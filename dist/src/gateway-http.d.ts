import { type RpcSpawnTarget } from "./gateway-rpc.js";
import { type GatewayFallbackPolicy } from "./model-fallback-gateway.js";
import { type ServiceStatusReader } from "./service-observability.js";
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
}
export interface GatewayHandle {
    port: number;
    hostname: string;
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
export declare class GatewayServer {
    private readonly server;
    private client;
    private currentTarget;
    private readonly streams;
    private readonly vaultRoot;
    private readonly runnableAgents;
    private readonly vaultAgents;
    private currentAgent;
    private readonly targetBuilder;
    private readonly authToken;
    private readonly publicDir;
    private readonly conversationBroker;
    /** Idempotent cleanup callbacks for live conversation SSE handlers. */
    private readonly conversationStreamCleanups;
    private shuttingDown;
    private readonly fallbackPolicyLoader;
    private readonly serviceStatusReader;
    /** TB4: explicit steward model selection disables automatic fallback for this session. */
    private explicitModelSelected;
    /** TB4: the session's current model id (evidence + rotation skip); mirrors the live client. */
    private currentModelId;
    /** TB4: active fallback incident for the single live turn (null when idle). */
    private activeIncident;
    constructor(options: GatewayServerOptions);
    start(port?: number, hostname?: string): Promise<GatewayHandle>;
    close(): Promise<void>;
    private installExitHandler;
    private handle;
    /**
     * Serve a static file from publicDir. Path traversal is rejected: the
     * resolved path must be inside publicDir (checked via relative()).
     * GET / maps to index.html. Directories fall back to index.html if it
     * exists, otherwise 404.
     */
    private handleStatic;
    private serveFile;
    private handleStart;
    /**
     * Drive one chat turn to its single terminal marker. steer/follow_up run
     * once on the existing turn (no fallback semantics); a fresh prompt runs
     * the TB4 bounded same-client rotation. Every turn ends with exactly one
     * terminal marker: done on success, error on failure.
     */
    private runChatTurn;
    /**
     * Send a non-prompt RPC command (steer/follow_up) and resolve once the
     * underlying turn fully settles (agent_settled), forwarding events live.
     * A command rejection rejects the promise: continuations of an existing
     * turn are never eligible for model rotation.
     */
    private commandAndSettle;
    /**
     * Send one prompt on the given client and resolve with its event stream
     * once the logical run fully settles (agent_settled — the sole terminal
     * boundary since TB0/G1). Prompt rejection rejects the promise. `timeoutMs`
     * is optional: chat SSE and OpenAI streaming keep today's no-timeout
     * behavior, while OpenAI non-streaming keeps its 30s bound.
     */
    private promptAndSettle;
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
    private runWithFallback;
    /** Resolve the fallback policy for the current agent (injected or vault). */
    private resolveFallbackPolicy;
    private handleStream;
    private handleModels;
    private handleOpenAiChatCompletions;
    private openAiMessagesToPrompt;
    private handleOpenAiChatCompletionsStream;
    private openAiTextDeltaFromEvent;
    private openAiContentToText;
    private handleState;
    private handleSetModel;
    private handleSetThinking;
    private readJsonBody;
    private handleApprove;
    /**
     * Abort the current turn mid-stream. The abort RPC command emits agent_end
     * then agent_settled (an aborted run is fully settled), which drains any
     * active SSE streams so they close cleanly on the settled boundary. There is
     * no dedicated stream for the abort itself: the outcome is observed on the
     * existing stream bound to the active turn.
     */
    private handleAbort;
    /**
     * Start a fresh conversation by replacing the active RPC client with a new
     * process for the current agent. A fresh Pi process has no transcript until
     * the steward sends a message, so no empty conversation is persisted by
     * Piren itself.
     */
    private handleNewConversation;
    /**
     * Return the full transcript of the current Pi session. Used to repopulate
     * the chat view after a browser reconnect so the steward sees prior context.
     */
    private handleMessages;
    /**
     * Resume a past Pi session by its on-disk path. On a successful resume,
     * subsequent prompts and events belong to the resumed session. The response
     * carries `cancelled` so the frontend can fall back gracefully when Pi could
     * not resume the requested session.
     */
    private handleResume;
    /**
     * List vault session summaries under team/<currentAgent>/sessions/. These are
     * the agent's past conversations as recorded by session_write_summary. The
     * list is newest-first. Requires both vaultRoot and a current agent.
     */
    private handleSessions;
    private handleAgents;
    private handleSwitch;
    private handleVaultList;
    private handleVaultRead;
    private handleVaultGraph;
    /**
     * Create an inbox task for an agent from the web UI. This is a steward
     * affordance: drop a one-file-per-task Markdown file into the target
     * agent's inbox without invoking the agent. The `from` is always
     * "steward" because the web UI has no agent identity of its own.
     * Configured vaultRoot is required, otherwise 403 (no write surface).
     */
    private handleVaultInbox;
    /**
     * GET /api/conversation-agents (ADR-0043 decommission rename of the old
     * /api/room-agents roster). Deterministic vault-agent roster where
     * `online` is local installation policy only (membership in the resolved
     * runnableAgents set) — never Pi/transport/provider presence.
     */
    private handleConversationAgents;
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
    private handleServiceStatus;
    private safeConversation;
    private safeConversationEvent;
    private conversationError;
    private resolveConversationMentions;
    private dispatchConversationRecipients;
    private handleConversations;
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
    private handleConversationStart;
    private handleConversationCreate;
    private handleConversationList;
    private handleConversationRead;
    private handleConversationMessage;
    /**
     * C3-A: authenticated POST /api/conversations/<id>/attach — the ONLY
     * activating route in C3. Reads the durable Conversation manifest and
     * applies the accepted C1 `checkActiveGate` against the gateway's resolved
     * runnable agents. The route is STATELESS: no vault write, membership
     * update, broker dispatch, Pi client/session creation, live subscription,
     * queue, retry, or persistent active-conversation state. Rejected
     * conversations stay visibly read-only inspection (C0 §8 exact terms).
     */
    private handleConversationAttach;
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
    private handleConversationLifecycle;
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
    private handleConversationRename;
    private handleConversationEvents;
    /**
     * C3-C2 bounded error vocabulary for the approval/abort control routes:
     * 400 for malformed bodies / non-exactly-one responses, 404 for absent
     * conversation (ENOENT), 409 for unknown/stale/already-settled approvals,
     * bounded 500 otherwise. Never leaks raw errors, Pi internals, lock
     * content, paths, or secrets.
     */
    private conversationControlError;
    /**
     * C3-C2: forward an approval response to the exact pending
     * conversation×agent request. Body `{agent, request_id, confirmed|value|
     * cancelled}` with exactly one response field; the accepted C3-C1 core
     * validates the shape, delivers at most once, and cleans up. Only the
     * bounded vocabulary is mapped (400/404/409/401/200); the route never
     * duplicates approval authority in HTTP code.
     */
    private handleConversationApprove;
    /**
     * C3-C2: abort the active run for exactly one conversation × agent key.
     * Body `{agent}`; maps the C3-C1 typed outcome (cancelled | no-active-run)
     * verbatim and never creates/attaches/dispatches/switches a client.
     */
    private handleConversationAbort;
    private handleConversationEventStream;
    private writeJson;
    private writeSse;
}
