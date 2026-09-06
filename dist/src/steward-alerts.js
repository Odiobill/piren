const ALERT_PATH = /^steward-inbox\/alerts\/[^/.][^/]*\.md$/;
const AGENT_NAME = /^[a-z][a-z0-9-]*$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// Legacy read-compatibility grammar for pre-P1b `status: resolved` records:
// an explicit UTC instant with either second or millisecond precision.
const LEGACY_RESOLVED_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SEVERITY_RANK = { urgent: 3, high: 2, normal: 1, low: 0 };
const MAX_PROJECTED_ALERTS = 100;
export function isDirectActiveStewardAlertPath(path) {
    return ALERT_PATH.test(path);
}
function assertActiveAlertPath(path) {
    if (!isDirectActiveStewardAlertPath(path)) {
        throw new Error("Alert path must name one direct active alert under steward-inbox/alerts/.");
    }
}
function assertIsoInstant(value, field) {
    if (!ISO_INSTANT.test(value) || Number.isNaN(Date.parse(value))) {
        throw new Error(`Alert ${field} must be a canonical ISO instant.`);
    }
}
function assertLegacyResolvedInstant(value) {
    if (!LEGACY_RESOLVED_INSTANT.test(value) || Number.isNaN(Date.parse(value))) {
        throw new Error("Alert resolved must be a canonical UTC ISO instant.");
    }
}
function required(fields, field) {
    const value = fields.get(field);
    if (value === undefined || value === "")
        throw new Error(`Alert is missing required ${field} field.`);
    return value;
}
function parseFields(content) {
    const match = content.match(/^---\n([\s\S]*?)\n---\n/);
    if (match === null)
        throw new Error("Alert is missing YAML frontmatter.");
    const fields = new Map();
    for (const line of (match[1] ?? "").split("\n")) {
        const field = line.match(/^([a-z_]+):\s*(.*)$/);
        if (field === null)
            throw new Error("Alert frontmatter is malformed.");
        const key = field[1] ?? "";
        if (fields.has(key))
            throw new Error(`Alert has duplicate ${key} field.`);
        fields.set(key, field[2] ?? "");
    }
    return fields;
}
function titleFromContent(content) {
    const frontmatter = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
    const title = frontmatter?.[1]?.match(/^#\s+(.+)$/m)?.[1]?.trim();
    if (!title)
        throw new Error("Alert is missing a title heading.");
    return title;
}
/** Parse one direct active steward-alert file without touching the filesystem. */
export function parseStewardAlert(options) {
    assertActiveAlertPath(options.path);
    const fields = parseFields(options.content);
    if (required(fields, "type") !== "Alert")
        throw new Error("Alert type must be Alert.");
    const id = required(fields, "id");
    const from = required(fields, "from");
    if (!AGENT_NAME.test(from))
        throw new Error("Alert from must be a lowercase kebab-case agent name.");
    const severity = required(fields, "severity");
    if (!["low", "normal", "high", "urgent"].includes(severity)) {
        throw new Error("Alert severity is invalid.");
    }
    const status = required(fields, "status");
    if (status !== "open" && status !== "closed" && status !== "resolved")
        throw new Error("Alert status is invalid.");
    const created = required(fields, "created");
    assertIsoInstant(created, "created");
    if (required(fields, "notify") !== "true" && fields.get("notify") !== "false") {
        throw new Error("Alert notify must be true or false.");
    }
    const alert = {
        path: options.path,
        id,
        from,
        severity: severity,
        status,
        created,
        title: titleFromContent(options.content),
    };
    const closedAt = fields.get("closed_at");
    const closedVia = fields.get("closed_via");
    const resolvedAt = fields.get("resolved");
    if (status === "resolved") {
        // Legacy read compatibility only: pre-P1b terminal records are preserved
        // as `resolved`, never relabeled `closed`. The oldest legitimate shape had
        // no resolution timestamp; when present, `resolved` must still be an exact
        // UTC instant. Workbench closure evidence is never accepted or fabricated.
        if (closedAt !== undefined || closedVia !== undefined)
            throw new Error("Resolved alert has closure evidence.");
        if (resolvedAt !== undefined) {
            if (resolvedAt === "")
                throw new Error("Alert resolved must not be empty.");
            assertLegacyResolvedInstant(resolvedAt);
            alert.resolvedAt = resolvedAt;
        }
    }
    else if (status === "open") {
        if (closedAt !== undefined || closedVia !== undefined)
            throw new Error("Open alert has closure evidence.");
        if (resolvedAt !== undefined)
            throw new Error("Open alert has resolved evidence.");
    }
    else {
        if (resolvedAt !== undefined)
            throw new Error("Closed alert has resolved evidence.");
        if (closedAt === undefined || closedVia === undefined)
            throw new Error("Closed alert is missing closure evidence.");
        assertIsoInstant(closedAt, "closed_at");
        if (closedVia !== "workbench")
            throw new Error("Alert closed_via must be workbench.");
        alert.closedAt = closedAt;
        alert.closedVia = closedVia;
    }
    return alert;
}
/**
 * Produce the exact next document for one open alert. This is pure: callers
 * supply current file content and must perform any CAS-protected write.
 */
export function closeStewardAlert(options) {
    const current = parseStewardAlert(options);
    if (current.status === "resolved")
        throw new Error("Resolved alert is not closeable.");
    if (current.status !== "open")
        throw new Error("Alert is already closed.");
    assertIsoInstant(options.closedAt, "closed_at");
    const content = options.content.replace(/^status: open$/m, `status: closed\nclosed_at: ${options.closedAt}\nclosed_via: workbench`);
    return {
        content,
        alert: parseStewardAlert({ path: options.path, content }),
    };
}
/**
 * Build the bounded, deterministic gateway-owned alert projection. The count
 * is intentionally uncapped; only a future presentation may render `99+`.
 */
export function projectStewardAlerts(alerts) {
    const sorted = [...alerts].sort((left, right) => {
        if (left.status !== right.status)
            return left.status === "open" ? -1 : 1;
        const severity = SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity];
        if (severity !== 0)
            return severity;
        const created = right.created.localeCompare(left.created);
        return created !== 0 ? created : left.path.localeCompare(right.path);
    });
    return {
        attentionCount: alerts.filter((alert) => alert.status === "open" && (alert.severity === "high" || alert.severity === "urgent")).length,
        alerts: sorted.slice(0, MAX_PROJECTED_ALERTS),
    };
}
//# sourceMappingURL=steward-alerts.js.map