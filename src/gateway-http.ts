import { type IncomingMessage, type ServerResponse, createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, relative, join, extname } from "node:path";
import { PiRpcClient, extractAssistantText, type RpcEvent, type RpcSpawnTarget } from "./gateway-rpc.js";
import { piEventToSse, type SseEvent } from "./gateway-bridge.js";
import { vaultBrowserList, vaultBrowserRead } from "./vault-browser.js";
import { listAgentSessions } from "./session-browser.js";
import { isBearerAuthorized } from "./gateway-auth.js";
import { createInboxTask } from "./inbox.js";
import {
  applyAgentSettingsIntent,
  applyLocalSettingsIntent,
  createNodeSettingsFoundationIo,
  parseSettingsIntent,
  readAgentConfigRedacted,
  readLocalConfigRedacted,
  SettingsFoundationError,
  type AgentSettingsIntent,
  type LocalSettingsIntent,
  type SettingsFoundationIo,
} from "./settings-foundation.js";
import { buildOkfGraph } from "./okf-graph.js";
import { ConversationBroker } from "./conversation-broker.js";
import { buildConversationAgentsResponse } from "./conversation-agents.js";
import {
  GroupSettingsError,
  createNodeGroupSettingsDeps,
  listGroups,
  listVaultAgents,
  mutateGroup,
  readGroup,
  validateAllGroups,
  type GroupSettingsDeps,
} from "./group-settings.js";
import { CONVERSATION_AGENT_NAME_PATTERN, checkActiveGate, formatActiveGateRejection, resolveStewardMentions, type ValidatedRecipients } from "./conversation-contract.js";
import {
  type ConversationActivityNotification,
  type ConversationTelemetryNotification,
  type ConversationApprovalNotification,
  type ConversationDispatchOutcome,
  type ConversationEventNotification,
} from "./conversation-broker.js";
import {
  appendConversationEvent,
  createConversation,
  createConversationForAgentStart,
  createConversationForPeerStart,
  listConversations,
  readConversation,
  readConversationEvents,
  renameConversation,
  transitionConversationLifecycle,
  updateConversationAudience,
  type AppendConversationEventResult,
  type ConversationEventRecord,
  type ConversationLifecycleTransitionKind,
  type ConversationLifecycleTransitionResult,
  type ConversationManifest,
  type RenameConversationResult,
} from "./conversations.js";
import {
  parsePeerAudienceStartRequest,
  peerStartOriginBody,
  validatePeerRunnability,
} from "./conversation-peer-start.js";
import type { VaultDirReader } from "./okf.js";
import { classifyRunOutcome, isFallbackEligibleOutcome, type RunOutcome } from "./model-fallback-outcome.js";
import { DEFAULT_WORKBENCH_RUN_TIMEOUT_MS } from "./conversation-broker.js";
import {
  createNodeWorkbenchConfigReader,
  formatWorkbenchConfigWarning,
  parseWorkbenchConfig,
  workbenchRunDeadlineMs,
} from "./workbench-config.js";
import { planFallbackAttempt, buildFallbackHandoffPrompt } from "./model-fallback-rotation.js";
import {
  buildModelFallbackNotice,
  loadAgentFallbackPolicy,
  splitFallbackModelId,
  type GatewayFallbackPolicy,
  type ModelFallbackNotice,
} from "./model-fallback-gateway.js";
import {
  SERVICE_OBSERVATION_TARGETS,
  type ServiceObservedState,
  type ServiceStatusReader,
  type ServiceStatusSnapshot,
} from "./service-observability.js";

const HEARTBEAT_INTERVAL_MS = 30000;
const MAX_JSON_BODY_BYTES = 1024 * 1024;
const SERVICE_OBSERVED_STATES = new Set<ServiceObservedState>(["active", "inactive", "not-installed", "unavailable", "unknown"]);

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

/**
 * The reader seam is internal but still a runtime boundary before HTTP output:
 * TypeScript cannot protect this public response from an invalid JS/plugin
 * implementation. Reject rather than project/invent a partial snapshot.
 */
function isServiceStatusSnapshot(value: unknown): value is ServiceStatusSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  if (!hasExactKeys(snapshot, ["observedAt", "manager", "targets"])) return false;
  if (typeof snapshot.observedAt !== "string" || typeof snapshot.manager !== "string" || !Array.isArray(snapshot.targets)) return false;
  const observedAt = new Date(snapshot.observedAt);
  if (Number.isNaN(observedAt.getTime()) || observedAt.toISOString() !== snapshot.observedAt) return false;
  if (snapshot.manager !== "systemd-user" && snapshot.manager !== "tmux-cron" && snapshot.manager !== "unavailable") return false;
  if (snapshot.targets.length !== SERVICE_OBSERVATION_TARGETS.length) return false;

  return snapshot.targets.every((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
    const target = entry as Record<string, unknown>;
    return (
      hasExactKeys(target, ["target", "state"]) &&
      target.target === SERVICE_OBSERVATION_TARGETS[index] &&
      typeof target.state === "string" &&
      SERVICE_OBSERVED_STATES.has(target.state as ServiceObservedState)
    );
  });
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json; charset=utf-8",
};

/** W5: map a settings foundation error code to an HTTP status. */
function settingsErrorStatus(code: SettingsFoundationError["code"]): number {
  switch (code) {
    case "invalid-intent":
    case "invalid-agent":
    case "malformed-config":
      return 400;
    case "not-found":
      return 404;
    case "revision-changed":
      return 409;
    case "write-failed":
    case "read-failed":
    default:
      return 500;
  }
}

/** W5: bounded non-secret error body per foundation code (never raw content). */
function settingsErrorBoundedMessage(code: SettingsFoundationError["code"]): string {
  switch (code) {
    case "invalid-intent":
    case "invalid-agent":
      return "The settings values were rejected.";
    case "malformed-config":
      return "The local config is malformed; refusing to modify it.";
    case "not-found":
      return "The target config was not found.";
    case "revision-changed":
      return "The config changed since it was read; refusing to overwrite it. Re-read and retry.";
    case "write-failed":
    case "read-failed":
    default:
      return "Settings could not be written.";
  }
}

function createVaultRelativeDirReader(vaultRoot: string): VaultDirReader {
  const root = resolve(vaultRoot);

  function resolveInsideVault(path: string): string {
    const resolved = path === "" ? root : resolve(join(root, path));
    const rel = relative(root, resolved);
    if (rel.startsWith("..") || rel === "..") {
      throw new Error("Path resolves outside vault");
    }
    return resolved;
  }

  return {
    async list(dir: string) {
      const entries = await readdir(resolveInsideVault(dir), { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() || entry.isFile())
        .map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
    },
    async readFile(path: string) {
      return readFile(resolveInsideVault(path), "utf8");
    },
  };
}

export type RpcTargetBuilder = (agent: string) => Promise<RpcSpawnTarget>;

/**
 * Resolves the agent-local model-fallback policy for a gateway run
 * (TB4). The production implementation reads `team/<agent>/config.yml`
 * best-effort from the vault root; tests inject a fixed policy to keep the
 * gateway filesystem/Pi-auth free. Absent/malformed policies are inert.
 */
export type FallbackPolicyLoader = (agent: string | null) => Promise<GatewayFallbackPolicy>;

export interface GatewayServerOptions {
  target: RpcSpawnTarget;
  vaultRoot?: string | undefined;
  /** Runnable agents for the web UI. If absent, agent switching is disabled. */
  runnableAgents?: string[] | undefined;
  /**
   * Vault-defined agent roster (`team/<agent>/` names) for GET
   * /api/conversation-agents (decommission rename, ADR-0043). Explicitly
   * supplied by the caller (the CLI passes the already-resolved local-policy
   * report); the server never rereads local config or creates directories to
   * derive it. When absent, the roster route returns an empty list. `online`
   * is local installation policy only — membership in `runnableAgents`.
   */
  vaultAgents?: string[] | undefined;
  /**
   * D5: bounded startup-projected configured-model map (agent name =>
   * canonical model label or null), produced ONCE by the CLI via
   * `projectConfiguredAgentModels` from each agent's declared
   * `team/<agent>/config.yml` model preference. The server never rereads
   * config per request; entries with null/missing values simply omit the
   * additive `model` field. When absent, no entry carries a model.
   */
  agentConfiguredModels?: Record<string, string | null> | undefined;
  /** Initial active agent. Defaults to the first runnable agent or null. */
  initialAgent?: string | undefined;
  /**
   * Builds a new spawn target when switching agents. Required for agent
   * switching; if absent, POST /api/chat/switch returns 403.
   */
  targetBuilder?: RpcTargetBuilder | undefined;
  /**
   * Shared bootstrap token for Bearer auth. When set, all /api/* routes
   * except /api/auth/info require a matching `Authorization: Bearer <token>`
   * header. When absent (localhost dev), auth is not enforced.
   */
  authToken?: string | undefined;
  /**
   * Directory of static frontend files. When set, the gateway serves
   * index.html at GET / and other files by relative path with MIME type
   * detection. API routes always take priority over static files.
   */
  publicDir?: string | undefined;
  /**
   * VR-2: startup reader for optional vault-root `workbench.yml`. Defaults to
   * a node reader over vaultRoot; tests inject fakes. Called at most once,
   * only when a ConversationBroker will be constructed.
   */
  workbenchConfigReader?: (() => string | null) | undefined;
  /** VR-2: bounded non-secret startup warning sink. Defaults to console.warn. */
  workbenchWarn?: ((message: string) => void) | undefined;
  /**
   * Resolves the agent-local model-fallback policy (TB4). Defaults to
   * reading `team/<agent>/config.yml` best-effort under vaultRoot; absent/
   * malformed/disabled policies keep existing single-run behavior. Tests
   * inject a fixed policy so the gateway stays filesystem/Pi-auth free.
   */
  fallbackPolicyLoader?: FallbackPolicyLoader | undefined;
  /**
   * Read-only service-observation seam for GET /api/services/status. The
   * production CLI wires the D2.1 local reader; tests inject a fake so the
   * gateway never probes a live service manager. When absent, the route
   * returns a bounded non-diagnostic failure (never a fabricated snapshot).
   */
  serviceStatusReader?: ServiceStatusReader | undefined;
  /**
   * W5 (ADR-0046): the machine-local config path for the typed transport
   * Settings routes. Absent => the settings routes return a bounded 404
   * (settings unavailable); the routes never create a directory or read a
   * default path on their own.
   */
  settingsConfigPath?: string | undefined;
  /**
   * W5: filesystem seam for the settings routes. Defaults to the production
   * node adapter; tests inject a fake so the gateway never touches the real
   * local config. Reads/writes stay atomic and revision-checked (W4).
   */
  settingsIo?: SettingsFoundationIo | undefined;
  /** ST-4: injected group-settings filesystem seam (defaults to node fs). */
  groupsIo?: GroupSettingsDeps | undefined;
}

export interface GatewayHandle {
  port: number;
  hostname: string;
}

interface ChatStream {
  queue: SseEvent[];
  closed: boolean;
  waiters: Array<() => void>;
}

/**
 * TB4 per-incident fallback state for the single live global client turn.
 * `attemptedModelIds` records every configured fallback already attempted in
 * this incident (at-most-once); `aborted` is set by POST /api/chat/abort so
 * steward intent cancels remaining attempts; `policy` is the resolved
 * agent-local fallback policy for this run.
 */
interface FallbackIncident {
  attemptedModelIds: string[];
  aborted: boolean;
  policy: GatewayFallbackPolicy;
}

type JsonBodyResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; status: 400 | 413; error: string };

function wake(stream: ChatStream): void {
  const waiters = stream.waiters;
  stream.waiters = [];
  for (const waiter of waiters) {
    waiter();
  }
}

function enqueue(stream: ChatStream, event: SseEvent): void {
  stream.queue.push(event);
  wake(stream);
}

function closeStream(stream: ChatStream): void {
  stream.closed = true;
  wake(stream);
}

/**
 * Gateway HTTP/SSE server. One process, one shared Pi RPC client. The POST-start
 * plus GET-stream split decouples "kick off a turn" from "deliver the stream":
 * POST starts the RPC prompt and returns a stream_id immediately; GET drains the
 * bridge-translated SSE events until done or error.
 *
 * The HTTP layer is the transport. The bridge (gateway-bridge.ts) is the
 * mechanical Pi-event-to-SSE translation. The RPC client (gateway-rpc.ts) is the
 * transport-agnostic core. The gateway never imports Pi in-process.
 */
export class GatewayServer {
  private readonly server: Server;
  private client: PiRpcClient;
  private currentTarget: RpcSpawnTarget;
  private readonly streams = new Map<string, ChatStream>();
  private readonly vaultRoot: string | undefined;
  /** VR-2: resolved Conversation run deadline in ms (workbench.yml or 60-minute default). */
  readonly conversationRunTimeoutMs: number;
  private readonly runnableAgents: string[];
  private readonly vaultAgents: string[];
  private readonly agentConfiguredModels: Record<string, string | null>;
  private currentAgent: string | null;
  private readonly targetBuilder: RpcTargetBuilder | undefined;
  private readonly authToken: string;
  private readonly publicDir: string | undefined;
  private readonly conversationBroker: ConversationBroker | undefined;
  /** Idempotent cleanup callbacks for live conversation SSE handlers. */
  private readonly conversationStreamCleanups = new Set<() => void>();
  private shuttingDown = false;
  private readonly fallbackPolicyLoader: FallbackPolicyLoader | undefined;
  private readonly serviceStatusReader: ServiceStatusReader | undefined;
  private readonly settingsConfigPath: string | undefined;
  private readonly settingsIo: SettingsFoundationIo;
  private readonly groupsIo: GroupSettingsDeps;
  /** TB4: explicit steward model selection disables automatic fallback for this session. */
  private explicitModelSelected = false;
  /** TB4: the session's current model id (evidence + rotation skip); mirrors the live client. */
  private currentModelId: string | null = null;
  /** TB4: active fallback incident for the single live turn (null when idle). */
  private activeIncident: FallbackIncident | null = null;

  constructor(options: GatewayServerOptions) {
    this.currentTarget = options.target;
    this.client = new PiRpcClient(options.target);
    this.vaultRoot = options.vaultRoot;
    this.runnableAgents = options.runnableAgents ?? [];
    this.vaultAgents = options.vaultAgents ?? [];
    this.agentConfiguredModels = options.agentConfiguredModels ?? {};
    this.targetBuilder = options.targetBuilder;
    this.authToken = options.authToken ?? "";
    this.publicDir = options.publicDir;
    this.fallbackPolicyLoader = options.fallbackPolicyLoader;
    this.serviceStatusReader = options.serviceStatusReader;
    this.settingsConfigPath = options.settingsConfigPath;
    this.settingsIo = options.settingsIo ?? createNodeSettingsFoundationIo();
    this.groupsIo = options.groupsIo ?? createNodeGroupSettingsDeps();
    // C2: the conversation broker is wired with the same runtime options;
    // conversation runs use isolated conversation × agent clients, never the
    // global gateway chat client. (The retired room broker is gone — no
    // Rooms product surface remains, ADR-0043.)
    if (options.vaultRoot !== undefined && options.targetBuilder !== undefined && this.runnableAgents.length > 0) {
      // VR-2: resolve the optional workbench.yml run deadline EXACTLY ONCE
      // before broker construction; never re-read or changed mid-process.
      const warn = options.workbenchWarn ?? ((message: string) => console.warn(message));
      const readWorkbenchYaml =
        options.workbenchConfigReader ?? createNodeWorkbenchConfigReader(options.vaultRoot);
      const resolution = parseWorkbenchConfig(readWorkbenchYaml());
      for (const warning of resolution.warnings) warn(formatWorkbenchConfigWarning(warning));
      this.conversationRunTimeoutMs = workbenchRunDeadlineMs(resolution);
      this.conversationBroker = new ConversationBroker({
        vaultRoot: options.vaultRoot,
        runnableAgents: this.runnableAgents,
        targetBuilder: options.targetBuilder,
        nonce: () => randomUUID().slice(0, 8),
        runTimeoutMs: this.conversationRunTimeoutMs,
      });
    } else {
      this.conversationRunTimeoutMs = DEFAULT_WORKBENCH_RUN_TIMEOUT_MS;
    }
    if (options.initialAgent !== undefined) {
      this.currentAgent = options.initialAgent;
    } else if (this.runnableAgents.length > 0) {
      this.currentAgent = this.runnableAgents[0] as string;
    } else {
      this.currentAgent = null;
    }
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  async start(port = 0, hostname = "127.0.0.1"): Promise<GatewayHandle> {
    await this.client.start();
    this.installExitHandler(this.client);

    await new Promise<void>((resolve) => {
      this.server.listen(port, hostname, resolve);
    });

    const address = this.server.address();
    const resolvedPort = typeof address === "object" && address ? address.port : port;
    return { port: resolvedPort, hostname };
  }

  async close(): Promise<void> {
    this.shuttingDown = true;
    if (this.conversationBroker) {
      await this.conversationBroker.close();
    }
    // Persistent conversation SSE connections would otherwise keep
    // server.close() waiting forever: wake/end every live stream, unsubscribe
    // its broker listeners, and stop its heartbeat. Cleanups are idempotent.
    for (const cleanup of [...this.conversationStreamCleanups]) {
      cleanup();
    }
    await this.client.stop();
    await new Promise<void>((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private installExitHandler(client: PiRpcClient): void {
    client.onExit(() => {
      if (this.shuttingDown) return;
      // Only surface exit errors if this is still the active client. After a
      // switch, the old client's intentional stop must not leak error events.
      if (client !== this.client) return;
      for (const stream of this.streams.values()) {
        if (!stream.closed) {
          enqueue(stream, { type: "error", data: { message: "Agent process exited unexpectedly." } });
        }
      }
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    // The auth-info route is always public: the frontend needs to know whether
    // to prompt for a token before it can make any authenticated request.
    if (req.method === "GET" && url.pathname === "/api/auth/info") {
      this.writeJson(res, 200, { authRequired: this.authToken !== "" });
      return;
    }

    // Enforce Bearer auth on all other /api/* routes when a token is
    // configured. On localhost with no token, auth is optional and this gate
    // is a no-op.
    if (this.authToken !== "" && url.pathname.startsWith("/api/")) {
      if (!isBearerAuthorized(req.headers.authorization, this.authToken)) {
        res.writeHead(401, {
          "content-type": "application/json",
          "www-authenticate": 'Bearer realm="piren"',
        });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
    }

    if (req.method === "POST" && url.pathname === "/api/chat/start") {
      await this.handleStart(req, res);
    } else if (req.method === "GET" && url.pathname === "/api/chat/stream") {
      await this.handleStream(res, url);
    } else if (req.method === "GET" && url.pathname === "/api/chat/models") {
      await this.handleModels(res);
    } else if (req.method === "GET" && url.pathname === "/api/chat/state") {
      await this.handleState(res);
    } else if (req.method === "POST" && url.pathname === "/api/chat/model") {
      await this.handleSetModel(req, res);
    } else if (req.method === "POST" && url.pathname === "/api/chat/thinking") {
      await this.handleSetThinking(req, res);
    } else if (req.method === "GET" && url.pathname === "/api/chat/agents") {
      await this.handleAgents(res);
    } else if (req.method === "GET" && url.pathname === "/api/conversation-agents") {
      await this.handleConversationAgents(res);
    } else if (req.method === "POST" && url.pathname === "/api/chat/switch") {
      await this.handleSwitch(req, res);
    } else if (req.method === "POST" && url.pathname === "/api/chat/approve") {
      await this.handleApprove(req, res);
    } else if (req.method === "POST" && url.pathname === "/api/chat/abort") {
      await this.handleAbort(res);
    } else if (req.method === "POST" && url.pathname === "/api/chat/new") {
      await this.handleNewConversation(res);
    } else if (req.method === "GET" && url.pathname === "/api/chat/messages") {
      await this.handleMessages(res);
    } else if (req.method === "POST" && url.pathname === "/api/chat/resume") {
      await this.handleResume(req, res);
    } else if (req.method === "GET" && url.pathname === "/api/chat/sessions") {
      await this.handleSessions(res);
    } else if (req.method === "POST" && url.pathname === "/api/v1/chat/completions") {
      await this.handleOpenAiChatCompletions(req, res);
    } else if (req.method === "GET" && url.pathname === "/api/vault/list") {
      await this.handleVaultList(res, url);
    } else if (req.method === "GET" && url.pathname === "/api/vault/read") {
      await this.handleVaultRead(res, url);
    } else if (req.method === "GET" && url.pathname === "/api/vault/graph") {
      await this.handleVaultGraph(res);
    } else if (req.method === "POST" && url.pathname === "/api/vault/inbox") {
      await this.handleVaultInbox(req, res);
    } else if (req.method === "GET" && url.pathname === "/api/settings/telegram") {
      await this.handleTransportSettingsRead(res, "telegram");
    } else if (req.method === "GET" && url.pathname === "/api/settings/discord") {
      await this.handleTransportSettingsRead(res, "discord");
    } else if (req.method === "POST" && url.pathname === "/api/settings/telegram") {
      await this.handleTransportSettingsWrite(req, res, "telegram");
    } else if (req.method === "POST" && url.pathname === "/api/settings/discord") {
      await this.handleTransportSettingsWrite(req, res, "discord");
    } else if (req.method === "GET" && url.pathname === "/api/settings/scheduler") {
      await this.handleSchedulerSettingsRead(res);
    } else if (req.method === "POST" && url.pathname === "/api/settings/scheduler") {
      await this.handleSchedulerSettingsWrite(req, res);
    } else if (req.method === "GET" && url.pathname === "/api/settings/groups") {
      await this.handleGroupsList(res);
    } else if (req.method === "POST" && url.pathname === "/api/settings/groups") {
      await this.handleGroupsAction(req, res);
    } else if (req.method === "GET" && url.pathname === "/api/settings/groups/validation") {
      await this.handleGroupsValidation(res);
    } else if (req.method === "GET" && url.pathname.startsWith("/api/settings/groups/")) {
      await this.handleGroupShow(res, decodeURIComponent(url.pathname.slice("/api/settings/groups/".length)));
    } else if (url.pathname.startsWith("/api/settings/agents/")) {
      const agent = url.pathname.slice("/api/settings/agents/".length);
      if (req.method === "GET") await this.handleAgentPreferencesRead(res, agent);
      else if (req.method === "POST") await this.handleAgentPreferencesWrite(req, res, agent);
      else this.writeJson(res, 405, { error: "method not allowed" });
    } else if (req.method === "GET" && url.pathname === "/api/services/status") {
      await this.handleServiceStatus(res);
    } else if (url.pathname === "/api/conversations" || url.pathname.startsWith("/api/conversations/")) {
      await this.handleConversations(req, res, url);
    } else if (req.method === "GET" && this.publicDir) {
      await this.handleStatic(res, url.pathname);
    } else {
      this.writeJson(res, 404, { error: "not found" });
    }
  }

  /**
   * Serve a static file from publicDir. Path traversal is rejected: the
   * resolved path must be inside publicDir (checked via relative()).
   * GET / maps to index.html. Directories fall back to index.html if it
   * exists, otherwise 404.
   */
  private async handleStatic(res: ServerResponse, pathname: string): Promise<void> {
    if (!this.publicDir) {
      this.writeJson(res, 404, { error: "not found" });
      return;
    }

    const root = resolve(this.publicDir);
    const requestPath = pathname === "/" ? "/index.html" : pathname;
    const filePath = resolve(join(root, requestPath));

    // Hard path-boundary enforcement: the resolved path must be inside root.
    const rel = relative(root, filePath);
    if (rel.startsWith("..") || rel === "") {
      this.writeJson(res, 403, { error: "path traversal rejected" });
      return;
    }

    try {
      const stats = await stat(filePath);
      if (stats.isDirectory()) {
        const indexPath = join(filePath, "index.html");
        try {
          await stat(indexPath);
          await this.serveFile(res, indexPath);
          return;
        } catch {
          this.writeJson(res, 404, { error: "not found" });
          return;
        }
      }
      await this.serveFile(res, filePath);
    } catch {
      this.writeJson(res, 404, { error: "not found" });
    }
  }

  private async serveFile(res: ServerResponse, filePath: string): Promise<void> {
    try {
      const content = await readFile(filePath);
      const ext = extname(filePath).toLowerCase();
      const mime = MIME_TYPES[ext] ?? "application/octet-stream";
      res.writeHead(200, { "content-type": mime });
      res.end(content);
    } catch {
      this.writeJson(res, 404, { error: "not found" });
    }
  }

  private async handleStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsed = await this.readJsonBody(req);
    if (!parsed.ok) {
      this.writeJson(res, parsed.status, { error: parsed.error });
      return;
    }

    const message = parsed.value.message;
    if (typeof message !== "string" || message.trim() === "") {
      this.writeJson(res, 400, { error: "message is required" });
      return;
    }

    const mode = parsed.value.mode;
    if (mode !== undefined && mode !== "steer" && mode !== "follow_up") {
      this.writeJson(res, 400, { error: "mode must be 'steer' or 'follow_up'" });
      return;
    }

    const streamId = randomUUID();
    const stream: ChatStream = { queue: [], closed: false, waiters: [] };
    this.streams.set(streamId, stream);

    // TB4: one persistent forwarder per turn. Intermediate settled runs
    // (provider-error fallback attempts) never emit a done; the single
    // terminal done is enqueued by runChatTurn. model_fallback notices are
    // enqueued as structured non-secret SSE events for external integrations
    // and the transcript.
    const forward = (event: RpcEvent): void => {
      const sse = piEventToSse(event);
      if (sse !== null && sse.type !== "done") {
        enqueue(stream, sse);
      }
    };
    const notify = (notice: ModelFallbackNotice): void => {
      enqueue(stream, { type: "model_fallback", data: notice as unknown as Record<string, unknown> });
    };

    // Fire and forget: the POST returns immediately. The turn runs to its
    // single terminal done (or error) and closes the stream. Errors and
    // mid-stream crashes surface as SSE error events.
    void this.runChatTurn(stream, message, mode, forward, notify);

    this.writeJson(res, 200, { stream_id: streamId });
  }

  /**
   * Drive one chat turn to its single terminal marker. steer/follow_up run
   * once on the existing turn (no fallback semantics); a fresh prompt runs
   * the TB4 bounded same-client rotation. Every turn ends with exactly one
   * terminal marker: done on success, error on failure.
   */
  private async runChatTurn(
    stream: ChatStream,
    message: string,
    mode: "steer" | "follow_up" | undefined,
    forward: (event: RpcEvent) => void,
    notify: (notice: ModelFallbackNotice) => void,
  ): Promise<void> {
    try {
      if (mode === "steer") {
        await this.commandAndSettle(this.client.steer(message), forward);
      } else if (mode === "follow_up") {
        await this.commandAndSettle(this.client.followUp(message), forward);
      } else {
        await this.runWithFallback(message, forward, notify);
      }
      enqueue(stream, { type: "done", data: {} });
    } catch (err) {
      if (!stream.closed) {
        enqueue(stream, { type: "error", data: { message: err instanceof Error ? err.message : String(err) } });
      }
    } finally {
      closeStream(stream);
    }
  }

  /**
   * Send a non-prompt RPC command (steer/follow_up) and resolve once the
   * underlying turn fully settles (agent_settled), forwarding events live.
   * A command rejection rejects the promise: continuations of an existing
   * turn are never eligible for model rotation.
   */
  private commandAndSettle(command: Promise<void>, forward: (event: RpcEvent) => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        action();
      };
      const unsubscribe = this.client.onEvent((event) => {
        forward(event);
        if (event.type === "agent_settled") {
          finish(() => {
            unsubscribe();
            resolve();
          });
        }
      });
      command.catch((err) => {
        finish(() => {
          unsubscribe();
          reject(err);
        });
      });
    });
  }

  /**
   * Send one prompt on the given client and resolve with its event stream
   * once the logical run fully settles (agent_settled — the sole terminal
   * boundary since TB0/G1). Prompt rejection rejects the promise. `timeoutMs`
   * is optional: chat SSE and OpenAI streaming keep today's no-timeout
   * behavior, while OpenAI non-streaming keeps its 30s bound.
   */
  private promptAndSettle(client: PiRpcClient, prompt: string, timeoutMs?: number): Promise<RpcEvent[]> {
    return new Promise<RpcEvent[]>((resolve, reject) => {
      const events: RpcEvent[] = [];
      let settled = false;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        action();
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          finish(() => reject(new Error(`Timed out waiting for agent_settled. Stderr: ${client.getStderr()}`)));
        }, timeoutMs);
      }
      const unsubscribe = client.onEvent((event) => {
        events.push(event);
        if (event.type === "agent_settled") {
          finish(() => {
            if (timer !== undefined) clearTimeout(timer);
            unsubscribe();
            resolve(events);
          });
        }
      });
      client.prompt(prompt).catch((err) => {
        finish(() => {
          if (timer !== undefined) clearTimeout(timer);
          unsubscribe();
          reject(err);
        });
      });
    });
  }

  /**
   * Run one logical prompt with bounded same-client model fallback (TB4).
   *
   * Continuation gate (design §3.1, §4.2, §5): a continuation happens ONLY
   * after the prompt was accepted AND the logical run reached agent_settled
   * AND classifyRunOutcome returned an eligible provider-error category. It
   * always uses the same still-live client/session: set_model(next) then
   * re-prompt with the TB3 verbatim-safe handoff wrapping the ORIGINAL
   * request. Never switch_session, never respawn/swap a client, never replays
   * a different request, never infers eligibility from error text/status.
   *
   * Rotation is declaration-order at-most-once through planFallbackAttempt; a
   * failed/unknown set_model counts as an attempted unavailable fallback and
   * the next configured model is tried; exhaustion is terminal. Absent/
   * invalid/disabled fallback config is inert (single run, no events). The
   * active fallback model remains session affinity after success (no primary
   * restore). The OpenAI-compatible route reuses this runner with a no-op
   * notify so no Piren SSE event leaks into its response.
   */
  private async runWithFallback(
    prompt: string,
    forward: (event: RpcEvent) => void,
    notify: (notice: ModelFallbackNotice) => void,
    timeoutMs?: number,
  ): Promise<RpcEvent[]> {
    const policy = await this.resolveFallbackPolicy();
    const incident: FallbackIncident = { attemptedModelIds: [], aborted: false, policy };
    this.activeIncident = incident;

    if (this.currentModelId === null) {
      this.currentModelId = policy.primaryModelId;
    }

    // Capture the client for the whole incident: a mid-turn agent switch
    // swaps this.client, and rotation must never migrate attempts across
    // clients (no respawn/swap semantics).
    const client = this.client;
    const unsubscribe = client.onEvent(forward);
    try {
      // Without a configured primary identity, this live session cannot
      // prove a candidate differs from the just-failed Pi model. Stay inert
      // rather than risk an unsafe same-model re-prompt.
      const config =
        policy.primaryModelId !== null && policy.fallback.ok && policy.fallback.present
          ? policy.fallback.config
          : null;
      let currentPrompt = prompt;
      let terminal: RpcEvent[] | null = null;
      // The last settled run awaiting a rotation decision. A rejected
      // set_model keeps this pending so the loop plans the NEXT configured
      // fallback directly (design §5.1/§7: skip with evidence, try the
      // next) instead of re-running the request on the just-failed model.
      // Only a successful switch clears it, triggering the handoff re-prompt.
      let pending: { events: RpcEvent[]; outcome: RunOutcome } | null = null;

      while (terminal === null) {
        if (pending === null) {
          const events = await this.promptAndSettle(client, currentPrompt, timeoutMs);
          if (incident.aborted) {
            terminal = events;
            break;
          }
          pending = { events, outcome: classifyRunOutcome(events) };
        }
        const { events, outcome } = pending;
        const plan =
          config === null
            ? { kind: "no-attempt" as const, reason: "not-eligible" as const }
            : planFallbackAttempt({
                configuredFallbacks: config.models,
                autoSwitch: config.autoSwitch,
                explicitModelSelected: this.explicitModelSelected,
                aborted: incident.aborted,
                outcome,
                currentModelId: this.currentModelId ?? "",
                attemptedModelIds: incident.attemptedModelIds,
              });

        if (plan.kind === "no-attempt") {
          terminal = events;
          break;
        }
        // planFallbackAttempt only reaches attempt/exhausted for eligible
        // outcomes; TS cannot see that correlation, so narrow explicitly and
        // fail closed if it ever disagrees.
        if (!isFallbackEligibleOutcome(outcome)) {
          terminal = events;
          break;
        }

        if (plan.kind === "exhausted") {
          notify(
            buildModelFallbackNotice({
              from: this.currentModelId,
              to: null,
              category: outcome.category,
              attempt: plan.attemptedCount,
              exhausted: true,
            }),
          );
          terminal = events;
          break;
        }

        // A planned attempt: emit evidence, then set_model. An unavailable
        // fallback (set_model rejection) is recorded as attempted and skipped
        // (at-most-once; never retried within this incident).
        notify(
          buildModelFallbackNotice({
            from: this.currentModelId,
            to: plan.modelId,
            category: outcome.category,
            attempt: plan.attemptNumber,
            exhausted: false,
          }),
        );
        const split = splitFallbackModelId(plan.modelId);
        let switched = false;
        try {
          await client.setModel(split.provider, split.modelId);
          this.currentModelId = plan.modelId;
          switched = true;
        } catch {
          // Unavailable fallback: skip with evidence already emitted.
        }
        incident.attemptedModelIds.push(plan.modelId);
        // Steward abort during the set_model exchange cancels the pending
        // re-prompt (design §5.6: abort during an attempt cancels the rest).
        if (incident.aborted) {
          terminal = events;
          break;
        }
        if (!switched) {
          // The pre-switch notice records the planned bounded attempt. Record
          // the actual rejection separately and explicitly so the visible
          // evidence never presents an unavailable model as a successful
          // provider-error continuation (design §7).
          notify(
            buildModelFallbackNotice({
              from: this.currentModelId,
              to: plan.modelId,
              category: "unavailable",
              attempt: plan.attemptNumber,
              exhausted: false,
            }),
          );
          // Keep the pending outcome so the next iteration plans the next
          // configured model without a re-prompt.
          continue;
        }
        currentPrompt = buildFallbackHandoffPrompt(prompt, plan.modelId, outcome.category);
        pending = null;
      }

      return terminal ?? [];
    } finally {
      unsubscribe();
      if (this.activeIncident === incident) {
        this.activeIncident = null;
      }
    }
  }

  /** Resolve the fallback policy for the current agent (injected or vault). */
  private resolveFallbackPolicy(): Promise<GatewayFallbackPolicy> {
    if (this.fallbackPolicyLoader !== undefined) {
      return this.fallbackPolicyLoader(this.currentAgent);
    }
    return loadAgentFallbackPolicy(this.vaultRoot, this.currentAgent);
  }

  private async handleStream(res: ServerResponse, url: URL): Promise<void> {
    const streamId = url.searchParams.get("stream_id");
    const stream = streamId ? this.streams.get(streamId) : undefined;
    if (!stream) {
      this.writeJson(res, 404, { error: "unknown stream_id" });
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.flushHeaders?.();

    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, HEARTBEAT_INTERVAL_MS);

    try {
      while (true) {
        while (stream.queue.length > 0) {
          const event = stream.queue.shift();
          if (!event) break;
          this.writeSse(res, event);
          if (event.type === "done" || event.type === "error") {
            return;
          }
        }
        if (stream.closed && stream.queue.length === 0) {
          return;
        }
        await new Promise<void>((resolve) => {
          stream.waiters.push(resolve);
        });
      }
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  }

  private async handleModels(res: ServerResponse): Promise<void> {
    try {
      const result = await this.client.getAvailableModels();
      this.writeJson(res, 200, result);
    } catch (err) {
      this.writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async handleOpenAiChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJsonBody(req);
    if (!body.ok) {
      this.writeJson(res, body.status, { error: body.error });
      return;
    }

    const messages = body.value.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      this.writeJson(res, 400, { error: "messages array is required" });
      return;
    }

    const prompt = this.openAiMessagesToPrompt(messages);
    if (prompt.trim() === "") {
      this.writeJson(res, 400, { error: "at least one message with text content is required" });
      return;
    }

    try {
      const requestedStream = body.value.stream;
      if (requestedStream === true) {
        await this.handleOpenAiChatCompletionsStream(res, prompt, body.value);
        return;
      }

      const events = await this.runWithFallback(
        prompt,
        () => {},
        () => {},
        30000,
      );
      const content = extractAssistantText(events).trim();
      const requestedModel = body.value.model;
      const model = typeof requestedModel === "string" && requestedModel.trim() !== "" ? requestedModel : "piren/default";
      this.writeJson(res, 200, {
        id: `chatcmpl-${randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
      });
    } catch (err) {
      this.writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private openAiMessagesToPrompt(messages: unknown[]): string {
    const parts: string[] = [];
    for (const item of messages) {
      if (typeof item !== "object" || item === null) continue;
      const record = item as { role?: unknown; content?: unknown };
      const role = typeof record.role === "string" && record.role.trim() !== "" ? record.role : "user";
      const content = this.openAiContentToText(record.content);
      if (content.trim() !== "") {
        parts.push(`${role}: ${content}`);
      }
    }
    return parts.join("\n");
  }

  private async handleOpenAiChatCompletionsStream(res: ServerResponse, prompt: string, body: Record<string, unknown>): Promise<void> {
    const requestedModel = body.model;
    const model = typeof requestedModel === "string" && requestedModel.trim() !== "" ? requestedModel : "piren/default";
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.flushHeaders?.();

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        action();
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        res.write(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        resolve();
      };
      // TB4: the runner forwards deltas live but never emits a Piren-specific
      // model_fallback event into the OpenAI response; the stop chunk and
      // [DONE] are written once after the terminal run.
      const forward = (event: RpcEvent): void => {
        const delta = this.openAiTextDeltaFromEvent(event);
        if (delta !== null) {
          res.write(`data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
          })}\n\n`);
        }
      };
      this.runWithFallback(prompt, forward, () => {})
        .then(() => {
          finish(() => {
            res.write(`data: ${JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            })}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
            resolve();
          });
        })
        .catch((err) => fail(err instanceof Error ? err : new Error(String(err))));
    });
  }

  private openAiTextDeltaFromEvent(event: RpcEvent): string | null {
    if (event.type !== "message_update") return null;
    const inner = event.assistantMessageEvent;
    if (typeof inner !== "object" || inner === null) return null;
    const record = inner as { type?: unknown; delta?: unknown };
    if (record.type === "text_delta" && typeof record.delta === "string") {
      return record.delta;
    }
    return null;
  }

  private openAiContentToText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === "object" && part !== null) {
        const record = part as { type?: unknown; text?: unknown };
        if ((record.type === undefined || record.type === "text") && typeof record.text === "string") {
          parts.push(record.text);
        }
      }
    }
    return parts.join("\n");
  }

  private async handleState(res: ServerResponse): Promise<void> {
    try {
      const state = await this.client.getState();
      this.writeJson(res, 200, state);
    } catch (err) {
      this.writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async handleSetModel(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJsonBody(req);
    if (!body.ok) {
      this.writeJson(res, body.status, { error: body.error });
      return;
    }

    const provider = body.value.provider;
    const modelId = body.value.modelId;
    if (typeof provider !== "string" || typeof modelId !== "string") {
      this.writeJson(res, 400, { error: "provider and modelId are required" });
      return;
    }

    try {
      const model = await this.client.setModel(provider, modelId);
      // TB4 (design §5.4): an explicit steward model selection takes
      // precedence for the session and disables automatic model fallback;
      // explicit opt-in re-enable is supported on the same route via
      // autoFallback:true (backward compatible — existing clients send only
      // provider/modelId). The internal fallback set_model never marks this
      // flag.
      if (body.value.autoFallback === true) {
        this.explicitModelSelected = false;
      } else {
        this.explicitModelSelected = true;
      }
      this.currentModelId = `${provider}/${modelId}`;
      this.writeJson(res, 200, model);
    } catch (err) {
      this.writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async handleSetThinking(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJsonBody(req);
    if (!body.ok) {
      this.writeJson(res, body.status, { error: body.error });
      return;
    }

    const level = body.value.level;
    if (typeof level !== "string") {
      this.writeJson(res, 400, { error: "level is required" });
      return;
    }

    try {
      await this.client.setThinkingLevel(level);
      this.writeJson(res, 200, { ok: true });
    } catch (err) {
      this.writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async readJsonBody(req: IncomingMessage): Promise<JsonBodyResult> {
    let body = "";
    let bytes = 0;
    for await (const chunk of req) {
      bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      if (bytes > MAX_JSON_BODY_BYTES) {
        return { ok: false, status: 413, error: "JSON request body is too large" };
      }
      body += typeof chunk === "string" ? chunk : chunk.toString();
    }
    try {
      const parsed = JSON.parse(body) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { ok: false, status: 400, error: "invalid JSON body" };
      }
      return { ok: true, value: parsed as Record<string, unknown> };
    } catch {
      return { ok: false, status: 400, error: "invalid JSON body" };
    }
  }

  private async handleApprove(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJsonBody(req);
    if (!body.ok) {
      this.writeJson(res, body.status, { error: body.error });
      return;
    }

    const id = body.value.id;
    if (typeof id !== "string") {
      this.writeJson(res, 400, { error: "id is required" });
      return;
    }

    // Exactly one of confirmed, value, or cancelled must be present.
    const confirmed = body.value.confirmed;
    const value = body.value.value;
    const cancelled = body.value.cancelled;

    try {
      if (cancelled === true) {
        this.client.respondToUiRequest(id, { cancelled: true });
      } else if (typeof confirmed === "boolean") {
        this.client.respondToUiRequest(id, { confirmed });
      } else if (typeof value === "string") {
        this.client.respondToUiRequest(id, { value });
      } else {
        this.writeJson(res, 400, { error: "one of confirmed, value, or cancelled is required" });
        return;
      }
      this.writeJson(res, 200, { ok: true });
    } catch (err) {
      this.writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Abort the current turn mid-stream. The abort RPC command emits agent_end
   * then agent_settled (an aborted run is fully settled), which drains any
   * active SSE streams so they close cleanly on the settled boundary. There is
   * no dedicated stream for the abort itself: the outcome is observed on the
   * existing stream bound to the active turn.
   */
  private async handleAbort(res: ServerResponse): Promise<void> {
    try {
      // TB4 (design §5.6): steward abort cancels any remaining fallback
      // attempts; the active incident settles as a cancel and never
      // continues. An abort during a fallback attempt cancels the rest.
      if (this.activeIncident) {
        this.activeIncident.aborted = true;
      }
      await this.client.abort();
      this.writeJson(res, 200, { ok: true });
    } catch (err) {
      this.writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Start a fresh conversation by replacing the active RPC client with a new
   * process for the current agent. A fresh Pi process has no transcript until
   * the steward sends a message, so no empty conversation is persisted by
   * Piren itself.
   */
  private async handleNewConversation(res: ServerResponse): Promise<void> {
    const oldClient = this.client;
    try {
      const target = this.targetBuilder && this.currentAgent
        ? await this.targetBuilder(this.currentAgent)
        : this.currentTarget;
      const nextClient = new PiRpcClient(target);
      await nextClient.start();
      this.installExitHandler(nextClient);
      this.client = nextClient;
      this.currentTarget = target;
      // TB4 (design §5.3): a fresh session resets fallback session state —
      // the fresh Pi process starts on the configured primary again.
      this.explicitModelSelected = false;
      this.currentModelId = null;
      this.activeIncident = null;

      for (const stream of this.streams.values()) {
        if (!stream.closed) {
          enqueue(stream, { type: "error", data: { message: "New conversation started; stream closed." } });
          closeStream(stream);
        }
      }
      this.streams.clear();

      await oldClient.stop();
      this.writeJson(res, 200, { ok: true, fresh: true });
    } catch (err) {
      this.writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Return the full transcript of the current Pi session. Used to repopulate
   * the chat view after a browser reconnect so the steward sees prior context.
   */
  private async handleMessages(res: ServerResponse): Promise<void> {
    try {
      const result = await this.client.getMessages();
      this.writeJson(res, 200, result);
    } catch (err) {
      this.writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Resume a past Pi session by its on-disk path. On a successful resume,
   * subsequent prompts and events belong to the resumed session. The response
   * carries `cancelled` so the frontend can fall back gracefully when Pi could
   * not resume the requested session.
   */
  private async handleResume(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJsonBody(req);
    if (!body.ok) {
      this.writeJson(res, body.status, { error: body.error });
      return;
    }

    const sessionPath = body.value.sessionPath;
    if (typeof sessionPath !== "string" || sessionPath.trim() === "") {
      this.writeJson(res, 400, { error: "sessionPath is required" });
      return;
    }

    try {
      const result = await this.client.switchSession(sessionPath);
      this.writeJson(res, 200, result);
    } catch (err) {
      this.writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * List vault session summaries under team/<currentAgent>/sessions/. These are
   * the agent's past conversations as recorded by session_write_summary. The
   * list is newest-first. Requires both vaultRoot and a current agent.
   */
  private async handleSessions(res: ServerResponse): Promise<void> {
    if (!this.vaultRoot) {
      this.writeJson(res, 404, { error: "session browser not configured" });
      return;
    }
    if (!this.currentAgent) {
      this.writeJson(res, 404, { error: "no active agent selected" });
      return;
    }
    try {
      const result = await listAgentSessions(this.vaultRoot, this.currentAgent);
      this.writeJson(res, 200, result);
    } catch (err) {
      this.writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async handleAgents(res: ServerResponse): Promise<void> {
    this.writeJson(res, 200, { agents: this.runnableAgents, current: this.currentAgent });
  }

  private async handleSwitch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.targetBuilder) {
      this.writeJson(res, 403, { error: "agent switching is not configured on this installation" });
      return;
    }

    const body = await this.readJsonBody(req);
    if (!body.ok) {
      this.writeJson(res, body.status, { error: body.error });
      return;
    }

    const agent = body.value.agent;
    if (typeof agent !== "string") {
      this.writeJson(res, 400, { error: "agent is required" });
      return;
    }

    if (!this.runnableAgents.includes(agent)) {
      this.writeJson(res, 403, { error: `agent '${agent}' is not in the runnable set` });
      return;
    }

    // No-op: same agent already running. Avoids restarting Pi for nothing.
    if (agent === this.currentAgent) {
      this.writeJson(res, 200, { agent, switched: false });
      return;
    }

    const oldClient = this.client;
    try {
      const target = await this.targetBuilder(agent);
      const nextClient = new PiRpcClient(target);
      await nextClient.start();
      this.installExitHandler(nextClient);

      // Swap the active client before stopping the old one. The exit handler
      // guards against the old client's intentional stop leaking errors.
      this.client = nextClient;
      this.currentTarget = target;
      this.currentAgent = agent;
      // TB4 (design §5.3): an agent switch is a fresh session for the new
      // agent — fallback session state resets (fresh configured primary).
      this.explicitModelSelected = false;
      this.currentModelId = null;
      this.activeIncident = null;

      // Close any streams still bound to the old client; they cannot continue
      // across an agent restart.
      for (const stream of this.streams.values()) {
        if (!stream.closed) {
          enqueue(stream, { type: "error", data: { message: "Agent switched; stream closed." } });
          closeStream(stream);
        }
      }
      this.streams.clear();

      await oldClient.stop();
      this.writeJson(res, 200, { agent, switched: true });
    } catch (err) {
      this.writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async handleVaultList(res: ServerResponse, url: URL): Promise<void> {
    if (!this.vaultRoot) {
      this.writeJson(res, 404, { error: "vault browser not configured" });
      return;
    }
    const path = url.searchParams.get("path") || ".";
    // WUX-B: closed bounded ordering value. Absent and "name" are the
    // default; "recent" is mtime-descending before the trim; anything else
    // is rejected fail-closed without altering default/path behavior.
    const orderParam = url.searchParams.get("order");
    let ordering: "name" | "recent" = "name";
    if (orderParam === "recent") {
      ordering = "recent";
    } else if (orderParam !== null && orderParam !== "name") {
      this.writeJson(res, 400, { error: "invalid order parameter" });
      return;
    }
    try {
      const result = await vaultBrowserList(this.vaultRoot, path, ordering);
      this.writeJson(res, 200, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("Path resolves outside vault")) {
        this.writeJson(res, 403, { error: msg });
      } else if (msg.startsWith("ENOENT") || msg.includes("ENOENT")) {
        this.writeJson(res, 404, { error: "path not found" });
      } else {
        this.writeJson(res, 400, { error: msg });
      }
    }
  }

  private async handleVaultRead(res: ServerResponse, url: URL): Promise<void> {
    if (!this.vaultRoot) {
      this.writeJson(res, 404, { error: "vault browser not configured" });
      return;
    }
    const path = url.searchParams.get("path");
    if (!path) {
      this.writeJson(res, 400, { error: "path is required" });
      return;
    }
    try {
      const result = await vaultBrowserRead(this.vaultRoot, path);
      this.writeJson(res, 200, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("Path resolves outside vault")) {
        this.writeJson(res, 403, { error: msg });
      } else if (msg.startsWith("ENOENT") || msg.includes("ENOENT")) {
        this.writeJson(res, 404, { error: "path not found" });
      } else {
        this.writeJson(res, 400, { error: msg });
      }
    }
  }

  private async handleVaultGraph(res: ServerResponse): Promise<void> {
    if (!this.vaultRoot) {
      this.writeJson(res, 404, { error: "vault graph not configured" });
      return;
    }
    try {
      const graph = await buildOkfGraph({ root: "", reader: createVaultRelativeDirReader(this.vaultRoot) });
      this.writeJson(res, 200, graph);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("Path resolves outside vault")) {
        this.writeJson(res, 403, { error: msg });
      } else if (msg.startsWith("ENOENT") || msg.includes("ENOENT")) {
        this.writeJson(res, 404, { error: "path not found" });
      } else {
        this.writeJson(res, 400, { error: msg });
      }
    }
  }

  /**
   * Create an inbox task for an agent from the web UI. This is a steward
   * affordance: drop a one-file-per-task Markdown file into the target
   * agent's inbox without invoking the agent. The `from` is always
   * "steward" because the web UI has no agent identity of its own.
   * Configured vaultRoot is required, otherwise 403 (no write surface).
   */
  private async handleVaultInbox(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.vaultRoot) {
      this.writeJson(res, 403, { error: "vault write surface not configured" });
      return;
    }
    const parsed = await this.readJsonBody(req);
    if (!parsed.ok) {
      this.writeJson(res, parsed.status, { error: parsed.error });
      return;
    }
    const to = parsed.value.to;
    const title = parsed.value.title;
    if (typeof to !== "string" || to.trim() === "") {
      this.writeJson(res, 400, { error: "to (agent name) is required" });
      return;
    }
    if (typeof title !== "string" || title.trim() === "") {
      this.writeJson(res, 400, { error: "title is required" });
      return;
    }
    const body = typeof parsed.value.body === "string" ? parsed.value.body : "";
    try {
      const result = await createInboxTask({
        vaultRoot: this.vaultRoot,
        from: "steward",
        to: to.trim(),
        title: title.trim(),
        body,
      });
      this.writeJson(res, 200, {
        taskId: result.taskId,
        path: result.path,
        from: result.from,
        to: result.to,
        status: result.status,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("Invalid agent name")) {
        this.writeJson(res, 400, { error: msg });
      } else if (msg.startsWith("Target agent not found")) {
        this.writeJson(res, 404, { error: msg });
      } else {
        this.writeJson(res, 400, { error: msg });
      }
    }
  }

  /**
   * GET /api/conversation-agents (ADR-0043 decommission rename of the old
   * /api/room-agents roster). Deterministic vault-agent roster where
   * `online` is local installation policy only (membership in the resolved
   * runnableAgents set) — never Pi/transport/provider presence.
   */
  private async handleConversationAgents(res: ServerResponse): Promise<void> {
    this.writeJson(res, 200, buildConversationAgentsResponse(this.vaultAgents, this.runnableAgents, this.agentConfiguredModels));
  }

  /**
   * GET /api/services/status — the D2.2 authenticated, read-only managed
   * service observation. Returns exactly the injected reader's bounded
   * snapshot (server-generated observedAt, manager, fixed-order
   * telegram/discord/scheduler targets) with no envelope or diagnostics. The
   * route takes no query/body selection of target, manager, command, path, or
   * timeout, never probes the gateway target, and never invokes a
   * service-control seam. An absent or failing reader is a bounded
   * non-diagnostic 503, never a fabricated observation.
   */
  private async handleServiceStatus(res: ServerResponse): Promise<void> {
    if (!this.serviceStatusReader) {
      this.writeJson(res, 503, { error: "service observation unavailable" });
      return;
    }
    try {
      const snapshot = await this.serviceStatusReader();
      if (!isServiceStatusSnapshot(snapshot)) {
        this.writeJson(res, 503, { error: "service observation unavailable" });
        return;
      }
      this.writeJson(res, 200, snapshot);
    } catch {
      // Raw reader diagnostics stay server-side; the failure body is fixed.
      this.writeJson(res, 503, { error: "service observation unavailable" });
    }
  }

  // -------------------------------------------------------------------------
  // W5 — typed transport Settings routes (ADR-0046)
  // -------------------------------------------------------------------------

  private groupsRoot(): string | undefined {
    return this.vaultRoot === undefined ? undefined : `${this.vaultRoot}/agent-groups`;
  }

  /** ST-4 — GET /api/settings/groups: bounded typed group summaries. */
  private async handleGroupsList(res: ServerResponse): Promise<void> {
    const root = this.groupsRoot();
    if (root === undefined) {
      this.writeJson(res, 404, { error: "settings unavailable" });
      return;
    }
    try {
      const groups = await listGroups(this.groupsIo, root);
      this.writeJson(res, 200, { available: true, groups });
    } catch (error) {
      void error;
      this.writeJson(res, 500, { error: "Agent groups could not be read." });
    }
  }

  /** ST-4 — GET /api/settings/groups/<group>: redacted modelled detail. */
  private async handleGroupShow(res: ServerResponse, group: string): Promise<void> {
    const root = this.groupsRoot();
    if (root === undefined) {
      this.writeJson(res, 404, { error: "settings unavailable" });
      return;
    }
    try {
      const detail = await readGroup(this.groupsIo, root, group);
      if (detail === null) {
        this.writeJson(res, 200, { available: false, reason: "Agent group was not found." });
        return;
      }
      const vaultAgents = await listVaultAgents(this.groupsIo, root.slice(0, -"/agent-groups".length));
      this.writeJson(res, 200, {
        available: true,
        group: {
          name: detail.name,
          revision: detail.revision,
          agents: detail.agents,
          fallbackOrder: detail.fallbackOrder,
          findings: detail.findings,
        },
        // ST-4 correction: the roster is EVERY vault-defined team/<agent>/
        // identity; locallyRunnable derives from the resolved gateway set.
        roster: vaultAgents.map((name) => ({ name, locallyRunnable: this.runnableAgents.includes(name) })),
      });
    } catch (error) {
      if (error instanceof GroupSettingsError && error.code === "invalid") {
        this.writeJson(res, 400, { error: "Invalid agent group name." });
        return;
      }
      this.writeJson(res, 500, { error: "Agent group could not be read." });
    }
  }

  /**
   * ST-4 correction — GET /api/settings/groups/validation: read-only
   * cross-group report reusing the CLI/core validate categories.
   */
  private async handleGroupsValidation(res: ServerResponse): Promise<void> {
    const root = this.groupsRoot();
    if (root === undefined || this.vaultRoot === undefined) {
      this.writeJson(res, 404, { error: "settings unavailable" });
      return;
    }
    try {
      const issues = await validateAllGroups(this.groupsIo, root, `${this.vaultRoot}/team`);
      this.writeJson(res, 200, { available: true, issues });
    } catch (error) {
      void error;
      this.writeJson(res, 500, { error: "Agent groups could not be read." });
    }
  }

  /**
   * POST /api/settings/groups — one closed typed group action. Body keys are
   * closed; create/remove-agent/fallback-set require confirm:true; stale
   * revisions fail as bounded 409 and never clobber.
   */
  private async handleGroupsAction(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const root = this.groupsRoot();
    if (root === undefined) {
      this.writeJson(res, 404, { error: "settings unavailable" });
      return;
    }
    const body = await this.readJsonBody(req);
    if (!body.ok) {
      this.writeJson(res, body.status, { error: body.error });
      return;
    }
    const raw = body.value;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      this.writeJson(res, 400, { error: "Group action must be an object." });
      return;
    }
    const allowedKeys = ["action", "group", "agent", "candidates", "confirm", "expectedRevision"];
    for (const key of Object.keys(raw as Record<string, unknown>)) {
      if (!allowedKeys.includes(key)) {
        this.writeJson(res, 400, { error: "Unknown field(s) in the group action (closed inventory)." });
        return;
      }
    }
    const record = raw as Record<string, unknown>;
    const action = record.action;
    if (action !== "create" && action !== "add-agent" && action !== "remove-agent" && action !== "fallback-set") {
      this.writeJson(res, 400, { error: "Unknown group action." });
      return;
    }
    const group = typeof record.group === "string" ? record.group : "";
    const expectedRevision = typeof record.expectedRevision === "string" ? record.expectedRevision : undefined;
    if (expectedRevision === undefined) {
      this.writeJson(res, 400, { error: "A source revision is required for every group action." });
      return;
    }
    const needsConfirm = action !== "add-agent";
    if (needsConfirm && record.confirm !== true) {
      this.writeJson(res, 400, { error: "This group action requires explicit confirmation." });
      return;
    }
    const agent = typeof record.agent === "string" ? record.agent : undefined;
    let candidates: string[] | undefined;
    if (record.candidates !== undefined) {
      const list = record.candidates;
      if (!Array.isArray(list) || !list.every((c): c is string => typeof c === "string")) {
        this.writeJson(res, 400, { error: "Fallback candidates must be a list of member names." });
        return;
      }
      candidates = [...list];
    }
    try {
      if (action === "create") {
        await mutateGroup(this.groupsIo, root, {
          group, expectedRevision, allowCreate: true, mutate: (data) => data,
        });
        this.writeJson(res, 200, { wrote: true });
        return;
      }
      if (group === "" || agent === undefined || agent.trim() === "") {
        this.writeJson(res, 400, { error: "An existing group and an agent name are required." });
        return;
      }
      if (action === "add-agent") {
        // ST-4 correction: free text is never authority. Only a name that
        // exists as a vault-defined team/<agent>/ identity may be added.
        const vaultAgents = await listVaultAgents(this.groupsIo, root.slice(0, -"/agent-groups".length));
        if (!vaultAgents.includes(agent)) {
          this.writeJson(res, 400, { error: "That agent is not a vault-defined agent (no team/<agent>/ directory)." });
          return;
        }
        await mutateGroup(this.groupsIo, root, {
          group, expectedRevision, mutate: (data) => ({
            agents: data.agents.includes(agent) ? data.agents : [...data.agents, agent],
            fallbackOrder: data.fallbackOrder,
          }),
        });
        this.writeJson(res, 200, { wrote: true });
        return;
      }
      if (action === "remove-agent") {
        await mutateGroup(this.groupsIo, root, {
          group, expectedRevision, mutate: (data) => {
            const fallbackOrder: Record<string, string[]> = {};
            for (const [member, list] of Object.entries(data.fallbackOrder)) {
              if (member === agent) continue;
              fallbackOrder[member] = list.filter((c) => c !== agent);
            }
            return { agents: data.agents.filter((a) => a !== agent), fallbackOrder };
          },
        });
        this.writeJson(res, 200, { wrote: true });
        return;
      }
      // fallback-set
      if (candidates === undefined) {
        this.writeJson(res, 400, { error: "The fallback-set action requires the ordered candidate list." });
        return;
      }
      await mutateGroup(this.groupsIo, root, {
        group, expectedRevision, mutate: (data) => {
          if (!data.agents.includes(agent)) {
            throw new GroupSettingsError("invalid", "The fallback target must be a group member.");
          }
          for (const candidate of candidates) {
            if (!data.agents.includes(candidate)) {
              throw new GroupSettingsError("invalid", "Every fallback candidate must be a group member.");
            }
          }
          if (candidates.includes(agent) || new Set(candidates).size !== candidates.length) {
            throw new GroupSettingsError("invalid", "Fallback candidates must be unique members other than the target.");
          }
          const fallbackOrder = { ...data.fallbackOrder, [agent]: candidates };
          return { agents: data.agents, fallbackOrder };
        },
      });
      this.writeJson(res, 200, { wrote: true });
    } catch (error) {
      if (error instanceof GroupSettingsError) {
        const statusByCode: Record<string, number> = { conflict: 409, "not-found": 404, exists: 409, invalid: 400, io: 500 };
        this.writeJson(res, statusByCode[error.code] ?? 400, { error: error.message });
        return;
      }
      this.writeJson(res, 500, { error: "The group action failed; nothing was changed." });
    }
  }

  /**
   * GET /api/settings/telegram|discord — the fully-redacted transport
   * projection (token `configured` boolean, ID counts, default agent,
   * feedback). Never a token, fingerprint, raw config, or unknown field.
   * Missing/malformed config fails closed with a bounded non-secret reason.
   */
  private async handleTransportSettingsRead(res: ServerResponse, family: "telegram" | "discord"): Promise<void> {
    if (this.settingsConfigPath === undefined) {
      this.writeJson(res, 404, { error: "settings unavailable" });
      return;
    }
    try {
      const projection = await readLocalConfigRedacted(this.settingsIo, this.settingsConfigPath);
      if (projection.available) {
        if (family === "telegram") {
          this.writeJson(res, 200, { available: true, telegram: projection.telegram });
        } else {
          this.writeJson(res, 200, { available: true, discord: projection.discord });
        }
        return;
      }
      this.writeJson(res, 200, { available: false, reason: projection.reason });
    } catch (error) {
      // Bounded, non-secret: never the raw error, config content, or a token.
      const message =
        error instanceof SettingsFoundationError && error.code === "read-failed"
          ? "Local config could not be read."
          : "Settings could not be read.";
      this.writeJson(res, 500, { error: message });
    }
  }

  /**
   * POST /api/settings/telegram|discord — apply one closed transport intent
   * through the W4 atomic/revision-checked foundation. The route enforces the
   * family match; a write-only token flows only into the written document.
   * Responses are fully redacted ({ wrote: true }); errors are bounded and
   * never echo the submitted token or raw config.
   */
  private async handleTransportSettingsWrite(req: IncomingMessage, res: ServerResponse, family: "telegram" | "discord"): Promise<void> {
    if (this.settingsConfigPath === undefined) {
      this.writeJson(res, 404, { error: "settings unavailable" });
      return;
    }
    const body = await this.readJsonBody(req);
    if (!body.ok) {
      this.writeJson(res, body.status, { error: body.error });
      return;
    }
    const parsed = parseSettingsIntent(body.value);
    if (!parsed.ok) {
      this.writeJson(res, 400, { error: parsed.error });
      return;
    }
    if (parsed.intent.surface !== "local" || parsed.intent.family !== family) {
      this.writeJson(res, 400, { error: "Settings intent does not match this transport route." });
      return;
    }
    // ST-1B: a submitted non-null transport default agent must be locally
    // runnable (gateway-resolved roster); bounded 400 before any write.
    const submittedAgent = parsed.intent.block.defaultAgent;
    if (submittedAgent !== undefined && submittedAgent !== null && !this.runnableAgents.includes(submittedAgent)) {
      this.writeJson(res, 400, { error: "Default agent is not locally runnable." });
      return;
    }
    try {
      await applyLocalSettingsIntent(this.settingsIo, this.settingsConfigPath, parsed.intent as LocalSettingsIntent);
      this.writeJson(res, 200, { wrote: true });
    } catch (error) {
      const status = error instanceof SettingsFoundationError ? settingsErrorStatus(error.code) : 500;
      const message = error instanceof SettingsFoundationError ? settingsErrorBoundedMessage(error.code) : "Settings could not be written.";
      this.writeJson(res, status, { error: message });
    }
  }

  /**
   * W6 — GET /api/settings/scheduler: the redacted scheduler projection
   * (master gate, closed automation classes, and the editable poll/stale/
   * concurrency/device values). Fail-closed S1 semantics; no tick/claim/spawn.
   */
  private async handleSchedulerSettingsRead(res: ServerResponse): Promise<void> {
    if (this.settingsConfigPath === undefined) {
      this.writeJson(res, 404, { error: "settings unavailable" });
      return;
    }
    try {
      const projection = await readLocalConfigRedacted(this.settingsIo, this.settingsConfigPath);
      if (projection.available) {
        this.writeJson(res, 200, { available: true, scheduler: projection.scheduler });
        return;
      }
      this.writeJson(res, 200, { available: false, reason: projection.reason });
    } catch (error) {
      const message = error instanceof SettingsFoundationError && error.code === "read-failed" ? "Local config could not be read." : "Settings could not be read.";
      this.writeJson(res, 500, { error: message });
    }
  }

  /** W6 — POST /api/settings/scheduler: closed scheduler intent via the W4 atomic writer. */
  private async handleSchedulerSettingsWrite(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.settingsConfigPath === undefined) {
      this.writeJson(res, 404, { error: "settings unavailable" });
      return;
    }
    const body = await this.readJsonBody(req);
    if (!body.ok) {
      this.writeJson(res, body.status, { error: body.error });
      return;
    }
    const parsed = parseSettingsIntent(body.value);
    if (!parsed.ok) {
      this.writeJson(res, 400, { error: parsed.error });
      return;
    }
    if (parsed.intent.surface !== "local" || parsed.intent.family !== "scheduler") {
      this.writeJson(res, 400, { error: "Settings intent does not match the scheduler route." });
      return;
    }
    try {
      await applyLocalSettingsIntent(this.settingsIo, this.settingsConfigPath, parsed.intent);
      this.writeJson(res, 200, { wrote: true });
    } catch (error) {
      const status = error instanceof SettingsFoundationError ? settingsErrorStatus(error.code) : 500;
      const message = error instanceof SettingsFoundationError ? settingsErrorBoundedMessage(error.code) : "Settings could not be written.";
      this.writeJson(res, status, { error: message });
    }
  }

  /** Validate a path agent is a locally-runnable name; bounded 403 otherwise. */
  private assertRunnableSettingsAgent(agent: string): void {
    if (!this.runnableAgents.includes(agent)) {
      throw new SettingsFoundationError("invalid-agent", "Agent is not locally runnable.");
    }
  }

  /** W6 — GET /api/settings/agents/<agent>: redacted vault-owned agent-preference projection. */
  private async handleAgentPreferencesRead(res: ServerResponse, agent: string): Promise<void> {
    if (this.vaultRoot === undefined) {
      this.writeJson(res, 404, { error: "settings unavailable" });
      return;
    }
    try {
      this.assertRunnableSettingsAgent(agent);
      const projection = await readAgentConfigRedacted(this.settingsIo, this.vaultRoot, agent);
      if (projection.available) {
        this.writeJson(res, 200, {
          available: true,
          model: projection.model,
          modelFallback: projection.modelFallback,
          contextInjection: projection.contextInjection,
          selfImprovement: projection.selfImprovement,
        });
        return;
      }
      this.writeJson(res, 200, { available: false, reason: projection.reason });
    } catch (error) {
      if (error instanceof SettingsFoundationError && error.code === "invalid-agent") {
        this.writeJson(res, 403, { error: "Agent is not locally runnable." });
        return;
      }
      const message = error instanceof SettingsFoundationError && error.code === "read-failed" ? "Agent config could not be read." : "Settings could not be read.";
      this.writeJson(res, 500, { error: message });
    }
  }

  /** W6 — POST /api/settings/agents/<agent>: closed agent-preference intent via the W4 atomic writer. */
  private async handleAgentPreferencesWrite(req: IncomingMessage, res: ServerResponse, agent: string): Promise<void> {
    if (this.vaultRoot === undefined) {
      this.writeJson(res, 404, { error: "settings unavailable" });
      return;
    }
    const body = await this.readJsonBody(req);
    if (!body.ok) {
      this.writeJson(res, body.status, { error: body.error });
      return;
    }
    const parsed = parseSettingsIntent(body.value);
    if (!parsed.ok) {
      this.writeJson(res, 400, { error: parsed.error });
      return;
    }
    if (parsed.intent.surface !== "agent") {
      this.writeJson(res, 400, { error: "Settings intent is not an agent preference." });
      return;
    }
    if (parsed.intent.agent !== agent) {
      this.writeJson(res, 400, { error: "Settings intent agent does not match the route agent." });
      return;
    }
    try {
      this.assertRunnableSettingsAgent(agent);
      // W6 model-fallback: any save that leaves auto-switch ENABLED requires
      // the exact route-specific confirmation (absent auto_switch defaults to
      // enabled, so a models-only edit on an undeclared/enabled declaration
      // also requires it). Disabled/absent saves never require it.
      if (parsed.intent.family === "model-fallback") {
        const current = await readAgentConfigRedacted(this.settingsIo, this.vaultRoot, agent);
        const currentAutoSwitch = current.available && current.modelFallback !== undefined ? current.modelFallback.autoSwitch : null;
        const resultAutoSwitch = parsed.intent.block.autoSwitch ?? currentAutoSwitch ?? true;
        if (resultAutoSwitch === true && parsed.intent.confirmAutoSwitch !== true) {
          this.writeJson(res, 400, { error: "Enabling model fallback auto-switch requires explicit confirmation." });
          return;
        }
      }
      await applyAgentSettingsIntent(this.settingsIo, this.vaultRoot, parsed.intent);
      this.writeJson(res, 200, { wrote: true });
    } catch (error) {
      if (error instanceof SettingsFoundationError && error.code === "invalid-agent") {
        this.writeJson(res, 403, { error: "Agent is not locally runnable." });
        return;
      }
      const status = error instanceof SettingsFoundationError ? settingsErrorStatus(error.code) : 500;
      const message = error instanceof SettingsFoundationError ? settingsErrorBoundedMessage(error.code) : "Settings could not be written.";
      this.writeJson(res, status, { error: message });
    }
  }

  // -------------------------------------------------------------------------
  // C2 — Conversation API family (ADR-0042, accepted C2 contract §3)
  // -------------------------------------------------------------------------

  private safeConversation(conversation: ConversationManifest): Record<string, unknown> {
    return {
      id: conversation.id,
      path: conversation.path,
      title: conversation.title,
      createdBy: conversation.createdBy,
      audience: conversation.audience,
      status: conversation.status,
      created: conversation.created,
      updated: conversation.updated,
    };
  }

  private safeConversationEvent(event: AppendConversationEventResult): Record<string, unknown> {
    return {
      id: event.id,
      conversationId: event.conversationId,
      kind: event.kind,
      created: event.created,
    };
  }

  private conversationError(res: ServerResponse, error: unknown): void {
    if (error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
      this.writeJson(res, 404, { error: "conversation not found" });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Conversation not found") || message.startsWith("Invalid conversation id")) {
      this.writeJson(res, 404, { error: message });
    } else if (
      message.startsWith("Conversation already exists") ||
      message.includes("is archived") ||
      message.includes("already active") ||
      message.includes("audience update is busy")
    ) {
      this.writeJson(res, 409, { error: message });
    } else if (
      message.includes("text is required") ||
      message.includes("not in the runnable set") ||
      message.includes("not a member of conversation") ||
      message.includes("Unrecognized agent") ||
      message.includes("Invalid conversation audience")
    ) {
      this.writeJson(res, 400, { error: message });
    } else {
      this.writeJson(res, 500, { error: "internal error" });
    }
  }

  private resolveConversationMentions(text: string): { ok: true; recipients: string[]; validated: ValidatedRecipients } | { ok: false; message: string } {
    const resolution = resolveStewardMentions(text, this.runnableAgents);
    if (!resolution.ok) {
      return { ok: false, message: resolution.message };
    }
    return { ok: true, recipients: [...resolution.validated.recipients], validated: resolution.validated };
  }

  private async dispatchConversationRecipients(
    conversationId: string,
    recipients: readonly string[],
    text: string,
    stewardEventId: string,
    priorEvents: readonly ConversationEventRecord[],
  ): Promise<{ entries: { agent: string; status: string }[]; conflictAgent: string | null }> {
    const entries: { agent: string; status: string }[] = [];
    let conflictAgent: string | null = null;
    for (const agent of recipients) {
      try {
        const outcome = await (this.conversationBroker as ConversationBroker).dispatchConversationMention({
          conversationId,
          agent,
          text,
          stewardEventId,
          priorEvents,
        });
        entries.push({ agent, status: outcome.status });
      } catch (error) {
        // Only an explicit active-run conflict is a 409; launch/ambiguous
        // outcomes are normal typed broker results and never land here.
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("already active")) {
          conflictAgent = conflictAgent ?? agent;
        } else {
          // Bounded per-recipient failure; the durable message and membership
          // are never rolled back; no queue/retry/fallback/reroute.
          entries.push({ agent, status: "conflict" });
        }
      }
    }
    return { entries, conflictAgent };
  }

  private async handleConversations(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!this.conversationBroker || !this.vaultRoot) {
      this.writeJson(res, 404, { error: "not found" });
      return;
    }
    const segments = url.pathname.split("/").filter((segment) => segment !== "");
    // segments: ["api", "conversations", id?, ...rest]
    let conversationId = "";
    if (segments.length >= 3) {
      try {
        conversationId = decodeURIComponent(segments[2] ?? "");
      } catch {
        this.writeJson(res, 400, { error: "malformed conversation id" });
        return;
      }
    }
    const rest = segments.slice(3);

    if (segments.length === 3 && segments[2] === "start" && req.method === "POST") {
      // ADR-0044: the agent-first start route is an exact path, never a
      // conversation id (P2 neutral ids can never be "start").
      await this.handleConversationStart(req, res);
    } else if (segments.length === 3 && segments[2] === "start-peer" && req.method === "POST") {
      // P3.2: the additive peer-audience start route is an exact path, never
      // a conversation id (P2 neutral ids can never be "start-peer").
      await this.handleConversationStartPeer(req, res);
    } else if (segments.length === 2 && req.method === "POST") {
      await this.handleConversationCreate(req, res);
    } else if (segments.length === 2 && req.method === "GET") {
      await this.handleConversationList(res);
    } else if (segments.length === 3 && req.method === "GET") {
      await this.handleConversationRead(res, conversationId);
    } else if (rest[0] === "events" && rest.length === 2 && rest[1] === "stream" && req.method === "GET") {
      await this.handleConversationEventStream(req, res, conversationId);
    } else if (rest[0] === "events" && rest.length === 1 && req.method === "GET") {
      await this.handleConversationEvents(res, conversationId);
    } else if (rest[0] === "messages" && rest.length === 1 && req.method === "POST") {
      await this.handleConversationMessage(req, res, conversationId);
    } else if (rest[0] === "attach" && rest.length === 1 && req.method === "POST") {
      await this.handleConversationAttach(res, conversationId);
    } else if (rest[0] === "approve" && rest.length === 1 && req.method === "POST") {
      await this.handleConversationApprove(req, res, conversationId);
    } else if (rest[0] === "abort" && rest.length === 1 && req.method === "POST") {
      await this.handleConversationAbort(req, res, conversationId);
    } else if (rest[0] === "agents" && rest.length === 3 && rest[2] === "telemetry" && req.method === "GET") {
      let telemetryAgent = "";
      try {
        telemetryAgent = decodeURIComponent(rest[1] ?? "");
      } catch {
        this.writeJson(res, 400, { error: "malformed agent name" });
        return;
      }
      await this.handleConversationTelemetry(res, conversationId, telemetryAgent);
    } else if (rest[0] === "agents" && rest.length === 3 && rest[2] === "workflow-status" && req.method === "GET") {
      let workflowAgent = "";
      try {
        workflowAgent = decodeURIComponent(rest[1] ?? "");
      } catch {
        this.writeJson(res, 400, { error: "malformed agent name" });
        return;
      }
      await this.handleConversationWorkflowStatus(res, conversationId, workflowAgent);
    } else if (rest[0] === "workflow-budgets" && rest.length === 1 && req.method === "GET") {
      await this.handleConversationWorkflowBudgets(res, conversationId);
    } else if (rest[0] === "workflow-budget" && rest.length === 1 && req.method === "POST") {
      await this.handleConversationWorkflowBudgetUpdate(req, res, conversationId);
    } else if ((rest[0] === "archive" || rest[0] === "reopen") && rest.length === 1 && req.method === "POST") {
      await this.handleConversationLifecycle(res, conversationId, rest[0]);
    } else if (rest[0] === "rename" && rest.length === 1 && req.method === "POST") {
      await this.handleConversationRename(req, res, conversationId);
    } else {
      this.writeJson(res, 404, { error: "not found" });
    }
  }

  /**
   * ADR-0044: authenticated POST /api/conversations/start — the
   * gateway-authoritative agent-first Conversation start. Accepts exactly
   * `{agent}`; rejects missing, non-string, blank, extra-key, malformed,
   * unknown, excluded, or non-runnable names BEFORE any vault persistence or
   * broker dispatch, using only the gateway-resolved local runnable set
   * (never browser state, provider health, or a config reread). Creates the
   * durable Conversation with `audience: [agent]` and the deterministic
   * agent-name title, persists the system-authored
   * `conversation_start_requested` origin event after the manifest and
   * BEFORE dispatch, publishes that exact committed record to the scoped SSE
   * stream, then drives the separately typed broker start path (one brief
   * bounded greeting; no C5 root/handoff authority). Never synthesizes
   * steward text and never weakens the text-first create route.
   */
  private async handleConversationStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsed = await this.readJsonBody(req);
    if (!parsed.ok) {
      this.writeJson(res, parsed.status, { error: parsed.error });
      return;
    }
    const keys = Object.keys(parsed.value);
    const agent = parsed.value.agent;
    if (keys.length !== 1 || keys[0] !== "agent" || typeof agent !== "string" || agent.trim() === "") {
      this.writeJson(res, 400, { error: "conversation start requires exactly one agent name" });
      return;
    }
    if (!this.runnableAgents.includes(agent)) {
      this.writeJson(res, 400, { error: `Agent '${agent}' is not in the local runnable set.` });
      return;
    }

    let conversation: ConversationManifest;
    try {
      conversation = await createConversationForAgentStart({ vaultRoot: this.vaultRoot as string, agent });
    } catch (error) {
      this.conversationError(res, error);
      return;
    }
    const originBody = `The steward requested starting this conversation with agent '${agent}'.`;
    const event = await appendConversationEvent({
      vaultRoot: this.vaultRoot as string,
      conversationId: conversation.id,
      kind: "conversation_start_requested",
      authorKind: "system",
      author: "system",
      body: originBody,
      nonce: () => randomUUID().slice(0, 8),
    });
    // Durable live-event parity (the P5 pattern): publish the exact
    // just-persisted origin record to scoped live subscribers BEFORE any
    // broker dispatch. Publication is a contained observability path: it can
    // never affect persistence, membership, or dispatch.
    (this.conversationBroker as ConversationBroker).publishConversationEvent(conversation.id, {
      id: event.id,
      conversationId: conversation.id,
      kind: "conversation_start_requested",
      authorKind: "system",
      author: "system",
      created: event.created,
      sequence: event.sequence,
      mentions: [],
      body: originBody,
      path: event.path,
    });
    let outcome: ConversationDispatchOutcome;
    try {
      outcome = await (this.conversationBroker as ConversationBroker).startConversationAgentRun({
        conversationId: conversation.id,
        agent,
        originEventId: event.id,
      });
    } catch (error) {
      // Only an explicit active-run conflict is a 409; typed launch/ambiguous
      // outcomes are normal broker results returned in the dispatch entry.
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("already active")) {
        this.writeJson(res, 409, { error: message });
        return;
      }
      this.conversationError(res, error);
      return;
    }
    this.writeJson(res, 201, {
      conversation: this.safeConversation(conversation),
      event: this.safeConversationEvent(event),
      dispatch: [{ agent, status: outcome.status }],
    });
  }

  /**
   * P3.2 (accepted P2 contract): authenticated POST /api/conversations/start-peer
   * — the additive peer-audience Conversation start. Strictly parses the
   * exact `{peers}` envelope via the pure P3.1 core; validates the WHOLE
   * audience against the gateway-resolved local runnable set BEFORE any vault
   * persistence (duplicates rejected, never collapsed; cardinality 2-8);
   * creates exactly one manifest with the canonically sorted initial audience
   * and the immutable cardinal title via the existing atomic machinery;
   * appends exactly one canonical system-authored `conversation_start_requested`
   * origin AFTER the manifest; publishes that exact committed record to the
   * scoped SSE stream; returns 201 `{conversation, event}` in the existing
   * safe projections with NO `dispatch` field. Zero broker contact: no
   * greeting, queue activity, or run evidence is ever produced here.
   */
  private async handleConversationStartPeer(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsed = await this.readJsonBody(req);
    if (!parsed.ok) {
      this.writeJson(res, parsed.status, { error: parsed.error });
      return;
    }
    const result = parsePeerAudienceStartRequest(parsed.value);
    if (!result.ok) {
      let message: string;
      if (result.failure.kind === "malformed-envelope") {
        message = "peer conversation start requires exactly one peers array";
      } else if (result.failure.kind === "cardinality") {
        message = "peer conversation start requires 2 to 8 distinct agent names";
      } else {
        // Bounded and redacted (P3.2 correction): identify positions and
        // reason classes only — never echo raw client-supplied values.
        const details = result.failure.members.map((member) => {
          const reason = member.reason;
          return `entry ${member.index} (${reason})`;
        });
        message = `invalid peer members: ${details.join(", ")}`;
      }
      this.writeJson(res, 400, { error: message });
      return;
    }
    const runnability = validatePeerRunnability(result.audience, this.runnableAgents);
    if (!runnability.ok) {
      // Bounded and redacted: a generic count only. The helper's indexes are
      // positions in the canonically sorted audience, not submitted request
      // entries — names and indexes are never exposed.
      const count = runnability.notRunnable.length;
      this.writeJson(res, 400, { error: `${count} requested peer(s) are not in the local runnable set.` });
      return;
    }

    let conversation: ConversationManifest;
    try {
      conversation = await createConversationForPeerStart({ vaultRoot: this.vaultRoot as string, audience: result.audience });
    } catch (error) {
      this.conversationError(res, error);
      return;
    }
    const originBody = peerStartOriginBody(result.audience);
    const event = await appendConversationEvent({
      vaultRoot: this.vaultRoot as string,
      conversationId: conversation.id,
      kind: "conversation_start_requested",
      authorKind: "system",
      author: "system",
      body: originBody,
      nonce: () => randomUUID().slice(0, 8),
    });
    // Durable live-event parity (same P5 pattern as the single-agent start):
    // publish the exact just-committed record to scoped live subscribers.
    // Contained observability only: it can never affect persistence,
    // membership, or any run state (there is no dispatch on this path).
    (this.conversationBroker as ConversationBroker).publishConversationEvent(conversation.id, {
      id: event.id,
      conversationId: conversation.id,
      kind: "conversation_start_requested",
      authorKind: "system",
      author: "system",
      created: event.created,
      sequence: event.sequence,
      mentions: [],
      body: originBody,
      path: event.path,
    });
    this.writeJson(res, 201, {
      conversation: this.safeConversation(conversation),
      event: this.safeConversationEvent(event),
    });
  }

  private async handleConversationCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsed = await this.readJsonBody(req);
    if (!parsed.ok) {
      this.writeJson(res, parsed.status, { error: parsed.error });
      return;
    }
    const text = parsed.value.text;
    if (typeof text !== "string" || text.trim() === "") {
      this.writeJson(res, 400, { error: "conversation message text is required" });
      return;
    }
    // Gateway-only mention authority (C1): resolve ALL mentions BEFORE any
    // durable conversation/event/membership/broker write. Atomic 400.
    const resolved = this.resolveConversationMentions(text);
    if (!resolved.ok) {
      this.writeJson(res, 400, { error: resolved.message });
      return;
    }

    let conversation: ConversationManifest;
    try {
      conversation = await createConversation({
        vaultRoot: this.vaultRoot as string,
        text,
        audience: resolved.recipients,
      });
    } catch (error) {
      this.conversationError(res, error);
      return;
    }
    const event = await appendConversationEvent({
      vaultRoot: this.vaultRoot as string,
      conversationId: conversation.id,
      kind: "steward_message",
      authorKind: "steward",
      author: "steward",
      body: text,
      mentions: resolved.recipients,
      nonce: () => randomUUID().slice(0, 8),
    });
    // P5 durable live-event parity: publish the exact just-persisted steward
    // event (the same complete durable record shape used for broker live
    // events and history parsing) to scoped live subscribers BEFORE any
    // broker dispatch. Publication is a contained observability path: it can
    // never affect persistence, membership, or dispatch.
    (this.conversationBroker as ConversationBroker).publishConversationEvent(conversation.id, {
      id: event.id,
      conversationId: conversation.id,
      kind: "steward_message",
      authorKind: "steward",
      author: "steward",
      created: event.created,
      sequence: event.sequence,
      mentions: [...resolved.recipients],
      body: text,
      path: event.path,
    });
    const dispatch =
      resolved.recipients.length > 0
        ? await this.dispatchConversationRecipients(conversation.id, resolved.recipients, text, event.id, [])
        : undefined;
    if (dispatch?.conflictAgent !== null && dispatch !== undefined) {
      // Explicit active-run conflict: the message is durable; surface 409.
      this.writeJson(res, 409, {
        error: `A run is already active for conversation '${conversation.id}' and agent '${dispatch.conflictAgent}'.`,
      });
      return;
    }
    this.writeJson(res, 201, {
      conversation: this.safeConversation(conversation),
      event: this.safeConversationEvent(event),
      ...(dispatch !== undefined ? { dispatch: dispatch.entries } : {}),
    });
  }

  private async handleConversationList(res: ServerResponse): Promise<void> {
    try {
      const conversations = await listConversations({ vaultRoot: this.vaultRoot as string });
      this.writeJson(res, 200, { conversations: conversations.map((conversation) => this.safeConversation(conversation)) });
    } catch (error) {
      this.conversationError(res, error);
    }
  }

  private async handleConversationRead(res: ServerResponse, conversationId: string): Promise<void> {
    try {
      const conversation = await readConversation({ vaultRoot: this.vaultRoot as string, conversationId });
      this.writeJson(res, 200, { conversation: this.safeConversation(conversation) });
    } catch (error) {
      this.conversationError(res, error);
    }
  }

  private async handleConversationMessage(req: IncomingMessage, res: ServerResponse, conversationId: string): Promise<void> {
    let conversation: ConversationManifest;
    try {
      conversation = await readConversation({ vaultRoot: this.vaultRoot as string, conversationId });
    } catch (error) {
      this.conversationError(res, error);
      return;
    }
    if (conversation.status !== "open") {
      this.writeJson(res, 409, { error: `Conversation '${conversationId}' is archived.` });
      return;
    }
    const parsed = await this.readJsonBody(req);
    if (!parsed.ok) {
      this.writeJson(res, parsed.status, { error: parsed.error });
      return;
    }
    const text = parsed.value.text;
    if (typeof text !== "string" || text.trim() === "") {
      this.writeJson(res, 400, { error: "conversation message text is required" });
      return;
    }
    const resolved = this.resolveConversationMentions(text);
    if (!resolved.ok) {
      this.writeJson(res, 400, { error: resolved.message });
      return;
    }
    // Prior durable transcript is read BEFORE the new event is appended, so
    // the current message is never part of the replayed context.
    const prior = await readConversationEvents({ vaultRoot: this.vaultRoot as string, conversationId });
    // Additive later-mention membership (C1): validated recipients grow the
    // durable manifest audience (first-mention order, no removals) and are
    // visible BEFORE dispatch. Invalid mentions never reach this point. A
    // held/contended audience lock fails closed with 409 BEFORE any steward
    // event or dispatch (no false delivery claim).
    try {
      if (resolved.recipients.length > 0) {
        await updateConversationAudience({
          vaultRoot: this.vaultRoot as string,
          conversationId,
          additions: resolved.validated,
        });
      }
    } catch (error) {
      this.conversationError(res, error);
      return;
    }
    const event = await appendConversationEvent({
      vaultRoot: this.vaultRoot as string,
      conversationId,
      kind: "steward_message",
      authorKind: "steward",
      author: "steward",
      body: text,
      mentions: resolved.recipients,
      nonce: () => randomUUID().slice(0, 8),
    });
    // P5 durable live-event parity: publish the exact just-persisted steward
    // event (the same complete durable record shape used for broker live
    // events and history parsing) to scoped live subscribers BEFORE any
    // broker dispatch.
    (this.conversationBroker as ConversationBroker).publishConversationEvent(conversationId, {
      id: event.id,
      conversationId,
      kind: "steward_message",
      authorKind: "steward",
      author: "steward",
      created: event.created,
      sequence: event.sequence,
      mentions: [...resolved.recipients],
      body: text,
      path: event.path,
    });
    // P5 single-member default: recipients are the explicit validated mentions,
    // or the SOLE durable audience member for a zero-mention message, or none
    // (multi-member zero-mention stays context-only). The browser never selects
    // a recipient; this reads the just-read authoritative manifest only.
    const recipients: string[] =
      resolved.recipients.length > 0
        ? [...resolved.recipients]
        : conversation.audience.length === 1
          ? [conversation.audience[0] as string]
          : [];
    // P5 automatic steer: exactly one target whose exact conversation×agent run
    // is active gets the existing Pi RPC `steer` (waits only the delivery ack;
    // no new run/terminal/status/membership event or outcome claim). A bounded
    // steer rejection/failure leaves the durable message and returns a truthful
    // `steer-failed` entry; no active run falls through to existing dispatch.
    if (recipients.length === 1) {
      const steerOutcome = await (this.conversationBroker as ConversationBroker).steerActiveConversationRun(
        conversationId,
        recipients[0] as string,
        text,
      );
      if (steerOutcome.status === "steered" || steerOutcome.status === "steer-failed") {
        this.writeJson(res, 200, {
          event: this.safeConversationEvent(event),
          dispatch: [{ agent: recipients[0] as string, status: steerOutcome.status }],
        });
        return;
      }
      // no-active-run: fall through to the existing dispatch path below.
    }
    const dispatch =
      recipients.length > 0
        ? await this.dispatchConversationRecipients(conversationId, recipients, text, event.id, prior)
        : undefined;
    if (dispatch?.conflictAgent !== null && dispatch !== undefined) {
      this.writeJson(res, 409, {
        error: `A run is already active for conversation '${conversationId}' and agent '${dispatch.conflictAgent}'.`,
      });
      return;
    }
    this.writeJson(res, 200, {
      event: this.safeConversationEvent(event),
      ...(dispatch !== undefined ? { dispatch: dispatch.entries } : {}),
    });
  }

  /**
   * C3-A: authenticated POST /api/conversations/<id>/attach — the ONLY
   * activating route in C3. Reads the durable Conversation manifest and
   * applies the accepted C1 `checkActiveGate` against the gateway's resolved
   * runnable agents. The route is STATELESS: no vault write, membership
   * update, broker dispatch, Pi client/session creation, live subscription,
   * queue, retry, or persistent active-conversation state. Rejected
   * conversations stay visibly read-only inspection (C0 §8 exact terms).
   */
  private async handleConversationAttach(res: ServerResponse, conversationId: string): Promise<void> {
    let conversation: ConversationManifest;
    try {
      conversation = await readConversation({ vaultRoot: this.vaultRoot as string, conversationId });
    } catch (error) {
      this.conversationError(res, error);
      return;
    }
    // C2 rejects writes to archived conversations. C3-A therefore never
    // presents one as active: archival remains durable read-only state until
    // a separately gated reopen transition exists.
    if (conversation.status !== "open") {
      this.writeJson(res, 409, {
        error: `Conversation '${conversationId}' is archived and stays read-only.`,
        attached: false,
        gate: { ok: true, missing: [], malformed: [] },
      });
      return;
    }
    const gate = checkActiveGate(conversation.audience, this.runnableAgents);
    if (!gate.ok) {
      this.writeJson(res, 409, {
        error: formatActiveGateRejection(conversationId, gate),
        attached: false,
        gate: { ok: false, missing: gate.missing, malformed: gate.malformed },
      });
      return;
    }
    this.writeJson(res, 200, {
      conversation: this.safeConversation(conversation),
      attached: true,
      gate: { ok: true, missing: [], malformed: [] },
    });
  }

  /**
   * L2: authenticated POST /api/conversations/<id>/archive|reopen — the only
   * mutating lifecycle routes besides first-message activation and message
   * append. They call the accepted L1 `transitionConversationLifecycle` core;
   * this handler only maps the typed result to the bounded HTTP vocabulary
   * (contract §3/§9 L2, selected defaults):
   *   - 200 {conversation, transitioned:true, event} for an actual transition;
   *   - 200 {conversation, transitioned:false} for a same-target repeat (no
   *     write, no event);
   *   - 409 exact busy vocabulary for genuine L1 lock contention;
   *   - 404 for absence (existing conversationError ENOENT mapping) — never
   *     relabelled as contention;
   *   - 500 {error:"internal error"} for an L1 event-append failure (the
   *     transitioned manifest is authoritative; no rollback/retry/repair/
   *     fabricated event, no raw error leakage).
   * State-only: no dispatch, retry, reroute, abort, attach, SSE, broker/Pi
   * client/session, audience/membership, or local-config side effect. Route
   * bodies carry no lifecycle input.
   */
  private async handleConversationLifecycle(
    res: ServerResponse,
    conversationId: string,
    transition: ConversationLifecycleTransitionKind,
  ): Promise<void> {
    let result: ConversationLifecycleTransitionResult;
    try {
      result = await transitionConversationLifecycle({
        vaultRoot: this.vaultRoot as string,
        conversationId,
        transition,
      });
    } catch (error) {
      // L1 absence/filesystem failures propagate honestly through the existing
      // conversationError mapping (ENOENT-coded -> 404 "conversation not
      // found"; anything else -> the bounded 500). Never relabel absence as
      // contention and never expose raw errors.
      this.conversationError(res, error);
      return;
    }
    if (!result.ok) {
      if (result.kind === "lock-busy") {
        this.writeJson(res, 409, {
          error: `Conversation '${conversationId}' is busy (another update holds the lock); retry after it completes.`,
        });
        return;
      }
      // event-append-failed: the transitioned manifest is authoritative; a
      // bounded 500 with no raw filesystem/typed-name leakage.
      this.writeJson(res, 500, { error: "internal error" });
      return;
    }
    if (result.transitioned) {
      this.writeJson(res, 200, {
        conversation: this.safeConversation(result.conversation),
        transitioned: true,
        event: this.safeConversationEvent(result.event),
      });
      return;
    }
    this.writeJson(res, 200, {
      conversation: this.safeConversation(result.conversation),
      transitioned: false,
    });
  }

  /**
   * U2: authenticated POST /api/conversations/<id>/rename — the bounded
   * steward-facing title change (accepted details/rename contract §Gateway/
   * API). The route only calls the `renameConversation` core and maps its
   * typed result to the bounded HTTP vocabulary:
   *   - 200 {conversation, renamed:true, event} for a completed rename; the
   *     safe event retains both bounded titles as inspectable evidence;
   *   - 200 {conversation, renamed:false} for the same normalized title (no
   *     write, no event);
   *   - 400 for malformed/missing/invalid titles (non-secret message);
   *   - 401 unauthenticated (existing Bearer gate);
   *   - 404 absent/invalid id (existing conversationError mapping);
   *   - 409 exact busy vocabulary for genuine lock contention;
   *   - 500 {error:"internal error"} for an event-append residual (the
   *     renamed manifest is authoritative; no rollback/retry/repair/
   *     fabricated event, no raw error/path/lock/Pi leakage).
   * State-only: no dispatch, retry, reroute, abort, attach, SSE, broker/Pi
   * client/session, audience/membership, lifecycle, or local-config effect.
   */
  private async handleConversationRename(req: IncomingMessage, res: ServerResponse, conversationId: string): Promise<void> {
    const parsed = await this.readJsonBody(req);
    if (!parsed.ok) {
      this.writeJson(res, parsed.status, { error: parsed.error });
      return;
    }
    const title = parsed.value.title;
    if (typeof title !== "string") {
      this.writeJson(res, 400, { error: "conversation title is required" });
      return;
    }
    let result: RenameConversationResult;
    try {
      result = await renameConversation({
        vaultRoot: this.vaultRoot as string,
        conversationId,
        title,
      });
    } catch (error) {
      // Absence/filesystem failures propagate honestly through the existing
      // conversationError mapping (ENOENT-coded -> 404; anything else -> the
      // bounded 500). Never relabel absence as contention, never expose raw
      // errors.
      this.conversationError(res, error);
      return;
    }
    if (!result.ok) {
      if (result.kind === "invalid-title") {
        this.writeJson(res, 400, { error: result.message });
        return;
      }
      if (result.kind === "lock-busy") {
        this.writeJson(res, 409, {
          error: `Conversation '${conversationId}' is busy (another update holds the lock); retry after it completes.`,
        });
        return;
      }
      // event-append-failed: the renamed manifest is authoritative; a bounded
      // 500 with no raw filesystem/typed-name leakage.
      this.writeJson(res, 500, { error: "internal error" });
      return;
    }
    if (result.renamed) {
      this.writeJson(res, 200, {
        conversation: this.safeConversation(result.conversation),
        renamed: true,
        event: {
          ...this.safeConversationEvent(result.event),
          previousTitle: result.previousTitle,
          title: result.title,
        },
      });
      return;
    }
    this.writeJson(res, 200, {
      conversation: this.safeConversation(result.conversation),
      renamed: false,
    });
  }

  private async handleConversationEvents(res: ServerResponse, conversationId: string): Promise<void> {
    try {
      const events = await readConversationEvents({ vaultRoot: this.vaultRoot as string, conversationId });
      this.writeJson(res, 200, { events });
    } catch (error) {
      this.conversationError(res, error);
    }
  }

  /**
   * C3-C2 bounded error vocabulary for the approval/abort control routes:
   * 400 for malformed bodies / non-exactly-one responses, 404 for absent
   * conversation (ENOENT), 409 for unknown/stale/already-settled approvals,
   * bounded 500 otherwise. Never leaks raw errors, Pi internals, lock
   * content, paths, or secrets.
   */
  private conversationControlError(res: ServerResponse, error: unknown): void {
    if (error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
      this.writeJson(res, 404, { error: "conversation not found" });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Invalid conversation id")) {
      // Same family convention as conversationError: an id that can never
      // name a conversation is a bounded 404, never a 500.
      this.writeJson(res, 404, { error: message });
    } else if (message.includes("Exactly one of confirmed, value, or cancelled is required")) {
      this.writeJson(res, 400, { error: message });
    } else if (message.startsWith("Unknown or stale approval request")) {
      this.writeJson(res, 409, { error: message });
    } else if (message.startsWith("conversation handoff gate could not be accepted")) {
      // C5-2: a confirmed gate whose edge cannot be accepted now (target /
      // budget / audience-lock state conflict) is a bounded 409, never a 500.
      this.writeJson(res, 409, { error: message });
    } else if (message.startsWith("a handoff gate approval accepts only")) {
      // C5-2: the initial gate is confirm-only; a value response is a bounded 400.
      this.writeJson(res, 400, { error: message });
    } else {
      this.writeJson(res, 500, { error: "internal error" });
    }
  }

  /**
   * C3-C2: forward an approval response to the exact pending
   * conversation×agent request. Body `{agent, request_id, confirmed|value|
   * cancelled}` with exactly one response field; the accepted C3-C1 core
   * validates the shape, delivers at most once, and cleans up. Only the
   * bounded vocabulary is mapped (400/404/409/401/200); the route never
   * duplicates approval authority in HTTP code.
   */
  private async handleConversationApprove(req: IncomingMessage, res: ServerResponse, conversationId: string): Promise<void> {
    const parsed = await this.readJsonBody(req);
    if (!parsed.ok) {
      this.writeJson(res, parsed.status, { error: parsed.error });
      return;
    }
    const agent = parsed.value.agent;
    const requestId = parsed.value.request_id;
    if (typeof agent !== "string" || agent.trim() === "") {
      this.writeJson(res, 400, { error: "agent is required" });
      return;
    }
    if (typeof requestId !== "string" || requestId === "") {
      this.writeJson(res, 400, { error: "request_id is required" });
      return;
    }
    try {
      // C3-C2: absent conversation is a bounded 404 (contract §7.1),
      // distinct from an unknown/stale request on an existing conversation
      // (409). Existence is checked without consulting lifecycle status —
      // the control itself stays run-scoped. C5-2: a pending initial gate
      // resolves through this same exact path; the await guarantees the
      // route truthfully reports success only after a confirmed gate's edge
      // is durably accepted (or a bounded rejection).
      await readConversation({ vaultRoot: this.vaultRoot as string, conversationId });
      await (this.conversationBroker as ConversationBroker).respondToConversationApproval({
        conversationId,
        agent,
        requestId,
        response: parsed.value,
      });
      this.writeJson(res, 200, { ok: true });
    } catch (error) {
      this.conversationControlError(res, error);
    }
  }

  /**
   * C3-C2: abort the active run for exactly one conversation × agent key.
   * Body `{agent}`; maps the C3-C1 typed outcome (cancelled | no-active-run)
   * verbatim and never creates/attaches/dispatches/switches a client.
   */
  private async handleConversationAbort(req: IncomingMessage, res: ServerResponse, conversationId: string): Promise<void> {
    const parsed = await this.readJsonBody(req);
    if (!parsed.ok) {
      this.writeJson(res, parsed.status, { error: parsed.error });
      return;
    }
    const agent = parsed.value.agent;
    if (typeof agent !== "string" || agent.trim() === "") {
      this.writeJson(res, 400, { error: "agent is required" });
      return;
    }
    try {
      const outcome = await (this.conversationBroker as ConversationBroker).abort(conversationId, agent);
      this.writeJson(res, 200, { outcome });
    } catch (error) {
      this.conversationControlError(res, error);
    }
  }

  /**
   * T4: authenticated, read-only
   * `GET /api/conversations/<id>/agents/<agent>/telemetry`. Reports the
   * truthful session-only telemetry availability for ONLY the exact live
   * `conversation × agent` pair via the broker read seam: HTTP 200 with
   * `sessionState: "live"` + bounded T3 facts, or 200 with
   * `{sessionState: "no_live_session"}` for every unavailable case. Never
   * spawns/resumes a client, never reconstructs from vault history, never
   * writes durable evidence, never publishes SSE. Conversation existence and
   * agent-name shape follow the existing Conversation route conventions.
   */
  private async handleConversationTelemetry(res: ServerResponse, conversationId: string, agent: string): Promise<void> {
    try {
      await readConversation({ vaultRoot: this.vaultRoot as string, conversationId });
    } catch (error) {
      this.conversationError(res, error);
      return;
    }
    if (!CONVERSATION_AGENT_NAME_PATTERN.test(agent)) {
      this.writeJson(res, 400, { error: "invalid agent name" });
      return;
    }
    const result = await (this.conversationBroker as ConversationBroker).readConversationTelemetry(conversationId, agent);
    this.writeJson(res, 200, result);
  }

  /**
   * B4: authenticated GET /api/conversations/<id>/agents/<agent>/workflow-status.
   * Broker-authoritative per-agent facts: existence 404, malformed agent 400,
   * audience check 404, then the broker's association/active snapshot. The
   * browser never selects a root or derives any fact.
   */
  private async handleConversationWorkflowStatus(res: ServerResponse, conversationId: string, agent: string): Promise<void> {
    let manifest: ConversationManifest;
    try {
      manifest = await readConversation({ vaultRoot: this.vaultRoot as string, conversationId });
    } catch (error) {
      this.conversationError(res, error);
      return;
    }
    if (!CONVERSATION_AGENT_NAME_PATTERN.test(agent)) {
      this.writeJson(res, 400, { error: "invalid agent name" });
      return;
    }
    if (!manifest.audience.includes(agent)) {
      this.writeJson(res, 404, { error: "agent is not in the conversation audience" });
      return;
    }
    const result = await (this.conversationBroker as ConversationBroker).getAgentWorkflowStatus(conversationId, agent);
    this.writeJson(res, 200, result);
  }

  /**
   * B4: authenticated GET /api/conversations/<id>/workflow-budgets — every
   * durable workflow root in sequence order plus the server-resolved
   * per-agent association map. No client root selection or inference.
   */
  private async handleConversationWorkflowBudgets(res: ServerResponse, conversationId: string): Promise<void> {
    try {
      await readConversation({ vaultRoot: this.vaultRoot as string, conversationId });
    } catch (error) {
      this.conversationError(res, error);
      return;
    }
    const result = await (this.conversationBroker as ConversationBroker).getConversationWorkflowBudgets(conversationId);
    this.writeJson(res, 200, result);
  }

  /**
   * B4: authenticated POST /api/conversations/<id>/workflow-budget — the
   * closed request body adapts ONLY to the B3 broker mutation seam. Exact
   * mapping: success 200; stale CAS conflict 409 with the current effective
   * view; archived/busy 409; unknown root/conversation 404; malformed or
   * invalid candidate 400 with no event. All errors bounded/non-secret.
   */
  private async handleConversationWorkflowBudgetUpdate(req: IncomingMessage, res: ServerResponse, conversationId: string): Promise<void> {
    try {
      await readConversation({ vaultRoot: this.vaultRoot as string, conversationId });
    } catch (error) {
      this.conversationError(res, error);
      return;
    }
    const parsed = await this.readJsonBody(req);
    if (!parsed.ok) {
      this.writeJson(res, parsed.status, { error: parsed.error });
      return;
    }
    const value = parsed.value;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      this.writeJson(res, 400, { error: "workflow budget update body must be a JSON object" });
      return;
    }
    const body = value as Record<string, unknown>;
    const allowed = new Set(["root_event_id", "edges", "rework_rounds", "expected_effective"]);
    for (const key of Object.keys(body)) {
      if (!allowed.has(key)) {
        this.writeJson(res, 400, { error: `unknown workflow budget update field: ${key}` });
        return;
      }
    }
    const rootEventId = body.root_event_id;
    if (typeof rootEventId !== "string" || rootEventId.trim() === "") {
      this.writeJson(res, 400, { error: "root_event_id must be a non-empty string" });
      return;
    }
    const edges = body.edges;
    if (edges !== undefined && (typeof edges !== "number" || !Number.isInteger(edges))) {
      this.writeJson(res, 400, { error: "edges must be an integer when present" });
      return;
    }
    const reworkRounds = body.rework_rounds;
    if (reworkRounds !== undefined && (typeof reworkRounds !== "number" || !Number.isInteger(reworkRounds))) {
      this.writeJson(res, 400, { error: "rework_rounds must be an integer when present" });
      return;
    }
    if (edges === undefined && reworkRounds === undefined) {
      this.writeJson(res, 400, { error: "at least one adjustable budget dimension is required" });
      return;
    }
    const expected = body.expected_effective;
    if (expected === null || typeof expected !== "object" || Array.isArray(expected)) {
      this.writeJson(res, 400, { error: "expected_effective is required" });
      return;
    }
    const expectedRecord = expected as Record<string, unknown>;
    const expectedKeys = Object.keys(expectedRecord);
    if (
      expectedKeys.length !== 2 ||
      expectedKeys.some((key) => key !== "edges" && key !== "reworkRounds") ||
      typeof expectedRecord.edges !== "number" || !Number.isInteger(expectedRecord.edges) ||
      typeof expectedRecord.reworkRounds !== "number" || !Number.isInteger(expectedRecord.reworkRounds)
    ) {
      this.writeJson(res, 400, { error: "expected_effective must carry exactly integer edges and reworkRounds" });
      return;
    }
    const outcome = await (this.conversationBroker as ConversationBroker).updateConversationWorkflowBudget({
      conversationId,
      rootEventId,
      ...(edges !== undefined ? { edges } : {}),
      ...(reworkRounds !== undefined ? { reworkRounds } : {}),
      expectedEffective: { edges: expectedRecord.edges, reworkRounds: expectedRecord.reworkRounds },
    });
    if (outcome.status === "updated") {
      this.writeJson(res, 200, {
        status: "updated",
        root_event_id: outcome.rootEventId,
        event_id: outcome.eventId,
        effective: outcome.effective,
      });
      return;
    }
    if (outcome.status === "conflict") {
      this.writeJson(res, 409, { error: outcome.reason, current_effective: outcome.currentEffective });
      return;
    }
    if (outcome.status === "busy" || outcome.status === "not-open") {
      this.writeJson(res, 409, { error: outcome.reason });
      return;
    }
    if (outcome.status === "unknown-root") {
      this.writeJson(res, 404, { error: outcome.reason });
      return;
    }
    this.writeJson(res, 400, { error: outcome.reason });
  }

  private async handleConversationEventStream(req: IncomingMessage, res: ServerResponse, conversationId: string): Promise<void> {
    // Validate the conversation exists before opening the stream.
    try {
      await readConversation({ vaultRoot: this.vaultRoot as string, conversationId });
    } catch (error) {
      this.conversationError(res, error);
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.flushHeaders?.();

    const stream: ChatStream = { queue: [], closed: false, waiters: [] };
    const broker = this.conversationBroker as ConversationBroker;
    const unsubscribe = broker.onConversationEvent(conversationId, (event: ConversationEventNotification) => {
      enqueue(stream, { type: "conversation_event", data: event as unknown as Record<string, unknown> });
    });
    // C3-C2: scoped live `approval` frames only (never durable, never
    // replayed in historic events); delivered only to this conversation's
    // attached/live stream.
    const unsubscribeApprovals = broker.onConversationApproval(conversationId, (approval: ConversationApprovalNotification) => {
      enqueue(stream, { type: "approval", data: approval as unknown as Record<string, unknown> });
    });
    // U4: scoped broker-authoritative `conversation_activity` frames (additive
    // named event; transient, never replayed, delivered only to this
    // conversation's attached live stream).
    const unsubscribeActivity = broker.onConversationActivity(conversationId, (activity: ConversationActivityNotification) => {
      enqueue(stream, { type: "conversation_activity", data: activity as unknown as Record<string, unknown> });
    });
    // T3: scoped broker-authoritative `conversation_telemetry` frames (live-only,
    // never durable, never replayed; at most one per settled run).
    const unsubscribeTelemetry = broker.onConversationTelemetry(conversationId, (telemetry: ConversationTelemetryNotification) => {
      enqueue(stream, { type: "conversation_telemetry", data: telemetry as unknown as Record<string, unknown> });
    });

    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, HEARTBEAT_INTERVAL_MS);

    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      unsubscribe();
      unsubscribeApprovals();
      unsubscribeActivity();
      unsubscribeTelemetry();
      this.conversationStreamCleanups.delete(cleanup);
      closeStream(stream);
    };
    this.conversationStreamCleanups.add(cleanup);
    req.on("close", cleanup);

    try {
      while (true) {
        while (stream.queue.length > 0) {
          const event = stream.queue.shift();
          if (!event) break;
          this.writeSse(res, event);
        }
        if (stream.closed) {
          return;
        }
        await new Promise<void>((resolve) => {
          stream.waiters.push(resolve);
        });
      }
    } finally {
      cleanup();
      res.end();
    }
  }

  private writeJson(res: ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  }

  private writeSse(res: ServerResponse, event: SseEvent): void {
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event.data)}\n\n`);
  }
}
