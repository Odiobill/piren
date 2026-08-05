import { type RpcSpawnTarget } from "./gateway-rpc.js";
export type RpcTargetBuilder = (agent: string) => Promise<RpcSpawnTarget>;
export interface GatewayServerOptions {
    target: RpcSpawnTarget;
    vaultRoot?: string | undefined;
    /** Runnable agents for the web UI. If absent, agent switching is disabled. */
    runnableAgents?: string[] | undefined;
    /**
     * Vault-defined agent roster (`team/<agent>/` names) for GET
     * /api/room-agents (ADR-0041 R3b-2). Explicitly supplied by the caller
     * (the CLI passes the already-resolved local-policy report); the server
     * never rereads local config or creates directories to derive it. When
     * absent, the roster route returns an empty list. `online` is local
     * installation policy only — membership in `runnableAgents`.
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
    private readonly roomBroker;
    private readonly conversationBroker;
    /** Idempotent cleanup callbacks for live room SSE handlers. */
    private readonly roomStreamCleanups;
    /** Idempotent cleanup callbacks for live conversation SSE handlers. */
    private readonly conversationStreamCleanups;
    private shuttingDown;
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
    /** Safe durable manifest shape: no absolutePath, no byte counts. */
    private safeRoom;
    /**
     * Map room core/broker errors to HTTP statuses with non-secret messages.
     * Unknown errors become a generic 500: filesystem paths, raw Pi errors,
     * stderr, tokens, and tracebacks never reach the response.
     */
    private roomError;
    /**
     * Room route family (ADR-0041 R1c). Requires the wired room broker;
     * without room capability every room route is a 404.
     */
    private handleRooms;
    private handleRoomCreate;
    private handleRoomList;
    /**
     * GET /api/room-agents (ADR-0041 R3b-2). Deterministic vault-agent roster
     * where `online` is local installation policy only (membership in the
     * resolved runnableAgents set) — never Pi/transport/provider presence.
     */
    private handleRoomAgents;
    private handleRoomRead;
    private handleRoomEvents;
    /**
     * Structured steward-to-one-agent mention. The dispatch agent comes only
     * from body.agent (never text parsing) and is revalidated by the broker
     * against room participants and local runnable policy. Awaits the bounded
     * outcome; an active room × agent conflict is a 409 with no queue.
     */
    private handleRoomMessage;
    /** Abort the active run for exactly this room × agent. */
    private handleRoomAbort;
    /**
     * Forward an approval response to the exact pending room-agent request.
     * Exactly one of confirmed, value, or cancelled must be present.
     */
    private handleRoomApprove;
    /**
     * Scoped SSE stream for exactly one room: live committed room records as
     * `room_event`, live pending approvals as `approval`. Historic events are
     * served by GET .../events; this is a live broker subscription, not
     * polling and not a replay. Heartbeat + disconnect cleanup required.
     */
    private handleRoomEventStream;
    private safeConversation;
    private safeConversationEvent;
    private conversationError;
    private resolveConversationMentions;
    private dispatchConversationRecipients;
    private handleConversations;
    private handleConversationCreate;
    private handleConversationList;
    private handleConversationRead;
    private handleConversationMessage;
    private handleConversationEvents;
    private handleConversationEventStream;
    private writeJson;
    private writeSse;
}
