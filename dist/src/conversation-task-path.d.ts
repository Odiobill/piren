/**
 * T2 — pure C6 task-path helper (ADR-0045, workbench-task-handoff-and-agent-
 * telemetry-contract §5/§7). Identifies one exact vault-relative ordinary
 * inbox task-file path inside Conversation handoff text.
 *
 * This is a pure inspectable protocol aid and test seam ONLY: it never
 * accesses the vault, resolves symlinks, reads task contents/frontmatter,
 * creates/claims/updates any task, or infers a task from arbitrary text. It
 * is deliberately NOT wired into the C5 broker request/edge planner, routes,
 * or tool envelope (accepted contract §9 choice 5): the broker does not parse
 * task paths from handoff text.
 *
 * Accepted grammar (conservative, explicit):
 *
 *   team/<agent>/inbox/<task>.md
 *
 * where <agent> is a lowercase kebab-case agent name (`[a-z][a-z0-9-]*`) and
 * <task> is the ordinary one-file-per-task filename form: an 8-digit date,
 * `T`, 9-digit time-with-millis, `Z`, a kebab-case slug, and the `.md`
 * suffix (mirrors the ADR-0038 task-id shape). Claimed coordination files
 * (`.claimed.<device>.md`), absolute/relative/traversal/subdirectory shapes,
 * non-inbox paths, and non-timestamp filenames never match. In free text the
 * path must be cleanly delimited (start/end, whitespace, or one of
 * " ' ` ( [ { <) and must not be glued to trailing word/dash/dot characters —
 * a sentence-final period makes the token ineligible, so handoff authors
 * should wrap the path in backticks or whitespace.
 */
export type ConversationTaskPathExtraction = {
    ok: true;
    path: string;
} | {
    ok: false;
    reason: "no-task-path" | "ambiguous-task-paths";
};
/** True when `value` is exactly one ordinary vault-relative inbox task path. */
export declare function isConversationInboxTaskPath(value: string): boolean;
/**
 * Extract the single exact inbox task path named in handoff text. Repeating
 * the same path is not ambiguous; two DISTINCT valid paths are. Anything that
 * is not a strictly valid path (claimed files, absolute/URL/relative/
 * traversal shapes, non-timestamp filenames, arbitrary Markdown/link text) is
 * ignored rather than misread as a task.
 */
export declare function extractConversationTaskPath(text: string): ConversationTaskPathExtraction;
