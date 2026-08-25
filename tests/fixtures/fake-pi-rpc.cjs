// Fake Pi RPC responder used by the gateway RPC client tests.
//
// This is a standalone Node process that mimics the JSONL stdin/stdout
// behavior of `pi --mode rpc` for the prompt flow, without requiring live
// model auth. It is the "separate process" the tracer bullet must prove the
// client can talk to.
//
// Protocol it speaks (matches verified @earendil-works/pi-coding-agent@0.79.9):
//   stdin:  LF-only JSONL commands, e.g. {type:"prompt", message, id}
//   stdout: LF-only JSONL responses and agent events
//
// On a prompt it emits:
//   {type:"response", command:"prompt", success:true, id}
//   {type:"agent_start"}
//   {type:"message_update", assistantMessageEvent:{type:"text_delta", delta:"Hel"}}
//   {type:"message_update", assistantMessageEvent:{type:"text_delta", delta:"lo"}}
//   {type:"agent_end", messages:[]}
//
// Token deltas are intentionally nested inside assistantMessageEvent, exactly
// like the real Pi RPC stream, so a client that looks for a flat token event
// will see nothing.

"use strict";

const process = require("node:process");

let buffer = "";
// TB4: the current model as last set via set_model (used to prove the
// fallback re-prompt ran on the switched model).
let currentModelId = null;
// TB4 review: count accepted prompt commands so tests can prove the
// bounded rotation never re-runs the request on the just-failed model
// after a rejected set_model (surfaced via get_state messageCount).
let promptCount = 0;
// Blocking-approval state: set by a "waitapprove" prompt, cleared by the
// matching extension_ui_response or by abort.
let waitingApprovalId = null;
// Unique approval request ids: each fake-Pi process is isolated per
// conversation/room run, so two requests raised in the same millisecond by
// DIFFERENT processes must never collide across keys. Every emitted id
// carries the process id plus a process-local sequence suffix.
let approvalSeq = 0;
// C5-3: reserved conversation-handoff control state (root gate or workflow
// accept). Set by a "conversationhandoff" marker in the active prompt section,
// cleared by the matching extension_ui_response or by abort. The completion
// delta names the broker role flag so gateway e2e tests can prove the
// root/workflow target decoration from durable evidence.
let waitingConversationHandoffId = null;
let conversationHandoffSeq = 0;
// Root gate: the run stays active after the pending answer so the steward can
// confirm via the approve route before the deferred child may launch. The
// bounded window keeps the gateway e2e deterministic without a second signal.
const CONVERSATION_HANDOFF_ROOT_HOLD_MS = Number(process.env.FAKE_PI_CONVERSATION_HANDOFF_ROOT_HOLD_MS ?? 1200);

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function emitSettledProviderError(retryExhausted) {
  if (retryExhausted) {
    emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage: "529 provider overloaded" });
    emit({ type: "auto_retry_end", attempt: 3, maxAttempts: 3, success: false, finalError: "529 provider overloaded" });
  }
  const errorRecord = {
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: "provider error (401)",
  };
  emit({ type: "message_start", message: errorRecord });
  emit({ type: "message_end", message: errorRecord });
  emit({ type: "turn_end", message: Object.assign({ toolResults: [] }, errorRecord) });
  emit({ type: "agent_end", messages: [errorRecord], willRetry: false });
  emit({ type: "agent_settled" });
}

function emitSettledContaminatedError() {
  emit({ type: "message_update", role: "assistant", assistantMessageEvent: { type: "text_delta", delta: "Partial" } });
  const errorRecord = {
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: "provider error (401)",
  };
  emit({ type: "message_start", message: errorRecord });
  emit({ type: "message_end", message: errorRecord });
  emit({ type: "turn_end", message: Object.assign({ toolResults: [] }, errorRecord) });
  emit({ type: "agent_end", messages: [errorRecord], willRetry: false });
  emit({ type: "agent_settled" });
}

function handle(cmd) {
  if (cmd.type === "prompt") {
    if (typeof cmd.message === "string" && cmd.message.includes("fail")) {
      emit({ type: "response", command: "prompt", success: false, id: cmd.id, error: "prompt rejected: fail trigger" });
      return;
    }
    promptCount += 1;
    emit({ type: "response", command: "prompt", success: true, id: cmd.id });
    emit({ type: "agent_start" });

    // TB4 deterministic provider-error scripts (checked BEFORE the default
    // completion so handoff re-prompts and error triggers are distinct; the
    // trigger words avoid "fail"/"approve"/"hang"/"waitapprove"/
    // "steer"/"follow_up" substrings).

    // (d) Fallback handoff re-prompt: the replacement model receives the
    // TB3 handoff-wrapped original request and completes normally, naming the
    // current (switched) model so tests can prove the same-client switch.
    if (typeof cmd.message === "string" && cmd.message.includes("[model fallback:")) {
      emit({ type: "message_update", role: "assistant", assistantMessageEvent: { type: "text_delta", delta: "Fbk " } });
      emit({ type: "message_update", role: "assistant", assistantMessageEvent: { type: "text_delta", delta: currentModelId || "unknown" } });
      emit({ type: "queue_update", steering: [], followUp: [] });
      emit({ type: "agent_end", messages: [], willRetry: false });
      emit({ type: "agent_settled" });
      return;
    }

    // (e) Settled zero-side-effect provider_error_other (eligible fallback).
    if (typeof cmd.message === "string" && cmd.message.includes("fallbackerr")) {
      emitSettledProviderError(false);
      return;
    }

    // (f) Settled transient-exhausted provider error (auto_retry_end
    // success:false; eligible fallback).
    if (typeof cmd.message === "string" && cmd.message.includes("fallbackretry")) {
      emitSettledProviderError(true);
      return;
    }

    // (g) Settled but CONTAMINATED provider error (text delta before the
    // error; zero-side-effect gate => ambiguous, never fallback-eligible).
    if (typeof cmd.message === "string" && cmd.message.includes("fallbackcontam")) {
      emitSettledContaminatedError();
      return;
    }

    // TB0 deterministic settlement scripts (trigger words avoid "fail"/"approve"/
    // "hang"/"waitapprove"/"steer"/"follow_up" substrings).

    // (a) Multiple agent_end where the first has willRetry:true: Pi announces an
    // automatic retry, re-runs, and only then fully settles.
    if (typeof cmd.message === "string" && cmd.message.includes("willretry")) {
      emit({ type: "message_update", role: "assistant", assistantMessageEvent: { type: "text_delta", delta: "Hel" } });
      emit({ type: "agent_end", messages: [], willRetry: true });
      emit({ type: "agent_start" });
      emit({ type: "message_update", role: "assistant", assistantMessageEvent: { type: "text_delta", delta: "lo" } });
      emit({ type: "agent_end", messages: [], willRetry: false });
      emit({ type: "agent_settled" });
      return;
    }

    // (b) Overflow compaction with willRetry:true, resumed normal completion,
    // then agent_settled. Compaction lifecycle traffic must never be terminal.
    if (typeof cmd.message === "string" && cmd.message.includes("overflowcompact")) {
      emit({ type: "message_update", role: "assistant", assistantMessageEvent: { type: "text_delta", delta: "Pre" } });
      emit({ type: "compaction_start", reason: "overflow" });
      emit({ type: "compaction_end", reason: "overflow", result: { summary: "compacted" }, aborted: false, willRetry: true });
      emit({ type: "agent_start" });
      emit({ type: "message_update", role: "assistant", assistantMessageEvent: { type: "text_delta", delta: "Post" } });
      emit({ type: "agent_end", messages: [], willRetry: false });
      emit({ type: "agent_settled" });
      return;
    }

    // (c) Failed/aborted compaction and summarization-retry traffic that NEVER
    // reaches agent_settled: maintenance signals are never terminal and the run
    // stays active (conservative path = bounded timeout / exit / abort).
    if (typeof cmd.message === "string" && cmd.message.includes("compactbreak")) {
      emit({ type: "message_update", role: "assistant", assistantMessageEvent: { type: "text_delta", delta: "Partial" } });
      emit({ type: "compaction_start", reason: "threshold" });
      emit({ type: "compaction_end", reason: "threshold", result: null, aborted: false, errorMessage: "quota exceeded" });
      emit({ type: "summarization_retry_scheduled", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "quota exceeded" });
      emit({ type: "summarization_retry_attempt_start", source: "compaction" });
      emit({ type: "summarization_retry_finished" });
      emit({ type: "agent_end", messages: [], willRetry: false });
      return; // deliberately no agent_settled
    }

    // C5-3: reserved conversation_handoff control request. The active section
    // is the text after the last "Handoff request:" (stage prompt) or the whole
    // message (root mention prompt); the first "conversationhandoff-><to>:<text>"
    // marker in that section drives the envelope, so each run in a bounded
    // chain carries only its own next link (the parent edge body embeds the
    // remainder). The completion delta names the broker role flag.
    if (typeof cmd.message === "string" && cmd.message.includes("conversationhandoff")) {
      const sectionIndex = cmd.message.lastIndexOf("Handoff request:");
      const section = sectionIndex >= 0 ? cmd.message.slice(sectionIndex + "Handoff request:".length) : cmd.message;
      const match = section.match(/conversationhandoff\s*->\s*([a-z0-9-]+)\s*:\s*([\s\S]*)/);
      if (match) {
        // VR-5: a workflow stage whose section also names "toolwork" first
        // emits bounded streamed text + safe tool events (so the stage work
        // card is visible) BEFORE raising its handoff request.
        if (typeof cmd.message === "string" && cmd.message.includes("toolwork")) {
          emit({ type: "message_update", role: "assistant", assistantMessageEvent: { type: "text_delta", delta: "Reviewing, then handing back." } });
          emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "vault_read", args: {} });
          emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "vault_read", isError: false, result: "content" });
        }
        waitingConversationHandoffId = "convhandoff-req-" + Date.now() + "-" + process.pid + "-" + ++conversationHandoffSeq;
        emit({
          type: "message_update",
          role: "assistant",
          assistantMessageEvent: {
            type: "text_delta",
            delta: "Requesting conversation handoff [role:" + (process.env.PIREN_CONVERSATION_HANDOFF_ENABLED || "none") + "].",
          },
        });
        emit({
          type: "extension_ui_request",
          id: waitingConversationHandoffId,
          method: "input",
          title: "piren:conversation-handoff",
          placeholder: JSON.stringify({ v: 1, to: match[1], text: match[2] }),
        });
        return;
      }
    }

    // T5: generic scripted-handoff seam (test-only). A prompt whose CURRENT
    // request section (after the last "Handoff request:", or the whole
    // message) contains the "c6script" token makes the fake poll a JSON
    // script file (env FAKE_PI_SCRIPT_FILE) for a rule {match, to, text}
    // whose `match` substring appears in the section, then emit the reserved
    // conversation handoff envelope with the scripted {to, text}. The file
    // may be an array of rules or an object {rules: [...], releases: {...}}.
    // Section-scoping keeps prior-context replay from re-triggering the seam.
    // A missing/invalid file or no matching rule within the bounded wait
    // completes the turn WITHOUT a handoff (visible failure, never
    // fabricated). Checked AFTER the marker flow so a root prompt carrying
    // both a marker and the token keeps the deterministic marker path.
    const c6SectionIndex = typeof cmd.message === "string" ? cmd.message.lastIndexOf("Handoff request:") : -1;
    const c6Section = c6SectionIndex >= 0 ? cmd.message.slice(c6SectionIndex + "Handoff request:".length) : cmd.message;
    if (typeof c6Section === "string" && c6Section.includes("c6script")) {
      const scriptFile = process.env.FAKE_PI_SCRIPT_FILE;
      const scriptTimeoutMs = Number(process.env.FAKE_PI_SCRIPT_TIMEOUT_MS ?? 5000);
      const scriptStart = Date.now();
      const tryScript = () => {
        let rules = null;
        if (scriptFile) {
          try {
            const parsed = JSON.parse(require("node:fs").readFileSync(scriptFile, "utf8"));
            if (Array.isArray(parsed)) rules = parsed;
            else if (parsed && Array.isArray(parsed.rules)) rules = parsed.rules;
          } catch {
            // not ready yet (missing/invalid): keep polling until the bound
          }
        }
        const rule =
          rules === null
            ? null
            : rules.find(
                (r) =>
                  r &&
                  typeof r.match === "string" &&
                  typeof r.to === "string" &&
                  typeof r.text === "string" &&
                  c6Section.includes(r.match),
              );
        if (rule) {
          waitingConversationHandoffId = "convhandoff-req-" + Date.now() + "-" + process.pid + "-" + ++conversationHandoffSeq;
          emit({
            type: "message_update",
            role: "assistant",
            assistantMessageEvent: {
              type: "text_delta",
              delta: "Requesting scripted handoff [role:" + (process.env.PIREN_CONVERSATION_HANDOFF_ENABLED || "none") + "].",
            },
          });
          emit({
            type: "extension_ui_request",
            id: waitingConversationHandoffId,
            method: "input",
            title: "piren:conversation-handoff",
            placeholder: JSON.stringify({ v: 1, to: rule.to, text: rule.text }),
          });
          return;
        }
        if (Date.now() - scriptStart >= scriptTimeoutMs) {
          emit({ type: "message_update", role: "assistant", assistantMessageEvent: { type: "text_delta", delta: "No c6script rule matched." } });
          emit({ type: "queue_update", steering: [], followUp: [] });
          emit({ type: "agent_end", messages: [] });
          emit({ type: "agent_settled" });
          return;
        }
        setTimeout(tryScript, 25);
      };
      tryScript();
      return;
    }

    // T5: generic hold/release seam (test-only). A prompt whose CURRENT
    // request section contains "c6hold:<id>" holds the turn (no agent_end)
    // while the fake polls the same JSON script file for a release entry in
    // an object {rules: [...], releases: {<id>: "text"}}. On release the fake
    // completes the turn with the scripted final text (default "Released."),
    // making the test-controlled terminal message the durable stage reply. A
    // missing/invalid file or no release within the bounded wait completes
    // WITHOUT it (visible test failure). Generic fixture behavior supplied
    // wholly by test data; no production logic.
    const holdMatch = typeof c6Section === "string" ? c6Section.match(/c6hold:([a-z0-9-]+)/) : null;
    if (holdMatch) {
      const holdId = holdMatch[1];
      const scriptFile = process.env.FAKE_PI_SCRIPT_FILE;
      const scriptTimeoutMs = Number(process.env.FAKE_PI_SCRIPT_TIMEOUT_MS ?? 5000);
      const scriptStart = Date.now();
      const tryRelease = () => {
        let releases = null;
        if (scriptFile) {
          try {
            const parsed = JSON.parse(require("node:fs").readFileSync(scriptFile, "utf8"));
            if (parsed && !Array.isArray(parsed) && parsed.releases && typeof parsed.releases === "object") {
              releases = parsed.releases;
            }
          } catch {
            // not ready yet (missing/invalid): keep polling until the bound
          }
        }
        if (releases !== null && Object.prototype.hasOwnProperty.call(releases, holdId)) {
          const finalText = typeof releases[holdId] === "string" ? releases[holdId] : "Released.";
          emit({ type: "message_update", role: "assistant", assistantMessageEvent: { type: "text_delta", delta: finalText } });
          emit({ type: "queue_update", steering: [], followUp: [] });
          emit({ type: "agent_end", messages: [] });
          emit({ type: "agent_settled" });
          return;
        }
        if (Date.now() - scriptStart >= scriptTimeoutMs) {
          emit({ type: "message_update", role: "assistant", assistantMessageEvent: { type: "text_delta", delta: "No c6hold release arrived." } });
          emit({ type: "queue_update", steering: [], followUp: [] });
          emit({ type: "agent_end", messages: [] });
          emit({ type: "agent_settled" });
          return;
        }
        setTimeout(tryRelease, 25);
      };
      tryRelease();
      return;
    }

    // VR-5: deterministic tool-work script (bounded streamed text + safe tool
    // lifecycle events with raw args/results present to prove they never
    // reach the browser work-card projection). Trigger word "toolwork" in the
    // CURRENT request section only (never prior-context replay); a
    // "conversationhandoff" message never reaches here — that branch runs
    // earlier and emits its own bounded tool deltas before its gate.
    const toolworkSectionIndex = typeof cmd.message === "string" ? cmd.message.lastIndexOf("Handoff request:") : -1;
    const toolworkSection = toolworkSectionIndex >= 0 ? cmd.message.slice(toolworkSectionIndex + "Handoff request:".length) : cmd.message;
    if (typeof toolworkSection === "string" && toolworkSection.includes("toolwork")) {
      emit({ type: "message_update", role: "assistant", assistantMessageEvent: { type: "text_delta", delta: "Working on it." } });
      emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "vault_read", args: { path: "/secret.md" } });
      emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "vault_read", isError: false, result: "secret file contents" });
      emit({ type: "tool_execution_start", toolCallId: "t2", toolName: "bash", args: { command: "rm -rf" } });
      emit({ type: "tool_execution_end", toolCallId: "t2", toolName: "bash", isError: true, result: "permission denied" });
      // VR-5: hold briefly so the mounted panel deterministically renders the
      // bounded tail + tool lines before the durable reply clears the card.
      const finishToolwork = () => {
        emit({ type: "queue_update", steering: [], followUp: [] });
        emit({ type: "agent_end", messages: [] });
        emit({ type: "agent_settled" });
      };
      setTimeout(finishToolwork, Number(process.env.FAKE_PI_TOOLWORK_HOLD_MS ?? 600));
      return;
    }

    // Blocking "hang": keep the run active (ack + agent_start, no agent_end)
    // until abort. Used to hold a handoff worker mid-run for lifecycle proofs.
    if (typeof cmd.message === "string" && cmd.message.includes("hang")) {
      return;
    }

    // P7: EXACT real Pi 0.83 production-protocol trace (captured read-only
    // from `/tmp/p7-probe/stdout2.jsonl` with the real binary and the exact
    // production invocation, deterministic 403): a session-start
    // fire-and-forget `extension_ui_request{method:"notify"}` lands in the
    // broker's run window BEFORE agent_start, followed by user + custom
    // piren-context messages, the repeated assistant error record in
    // message_start/message_end/turn_end/agent_end.messages, then settled.
    // Under P6 the notify contaminated the zero-side-effect gate -> ambiguous
    // -> no-policy completed (the pilot bug). Under P7 the fire-and-forget
    // notify must not contaminate: truthful provider_error terminal.
    if (typeof cmd.message === "string" && cmd.message.includes("providererror-real")) {
      emit({
        type: "extension_ui_request",
        id: "p7-notify-" + process.pid,
        method: "notify",
        message: "Piren loaded: fake at /tmp; vault_root=fake; device=fake",
        notifyType: "info",
      });
      emit({ type: "agent_start" });
      emit({ type: "turn_start" });
      emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "prior" }] } });
      emit({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "prior" }] } });
      emit({ type: "message_start", message: { role: "custom", customType: "piren-context", content: "# Piren Context\nagent_name: fake" } });
      emit({ type: "message_end", message: { role: "custom", customType: "piren-context", content: "# Piren Context\nagent_name: fake" } });
      const errorRecord = {
        role: "assistant",
        content: [],
        api: "openai-completions",
        provider: "opencode-go",
        model: "deepseek-v4-flash",
        usage: { input: 0, output: 0, totalTokens: 0 },
        stopReason: "error",
        errorMessage: "403: {\"type\":\"RegionError\",\"message\":\"redacted\"}",
      };
      emit({ type: "message_start", message: errorRecord });
      emit({ type: "message_end", message: errorRecord });
      emit({ type: "turn_end", message: Object.assign({ toolResults: [] }, errorRecord) });
      emit({ type: "agent_end", messages: [{ role: "user", content: [{ type: "text", text: "prior" }] }, { role: "custom", customType: "piren-context", content: "# Piren Context\nagent_name: fake" }, errorRecord], willRetry: false });
      emit({ type: "agent_settled" });
      return;
    }

    // P6: settled zero-side-effect provider error with EMPTY text (the pilot's
    // 403 shape: real assistant final error record, no text deltas, no
    // auto_retry). With no valid fallback policy the broker must record the
    // truthful bounded failed/provider_error terminal, never "completed", and
    // persist no fabricated agent_message. Reuses the existing settled
    // provider-error emission unchanged.
    if (typeof cmd.message === "string" && cmd.message.includes("providererror-empty")) {
      emitSettledProviderError(false);
      return;
    }

    // P6: exact real nested Pi 0.83 RPC assistant-text shape —
    // message_update.assistantMessageEvent.text_delta carries contentIndex and
    // a partial snapshot alongside delta (verified against the Pi 0.83.0
    // binary). The broker must extract exactly one durable agent_message from
    // these nested deltas.
    if (typeof cmd.message === "string" && cmd.message.includes("realnested")) {
      const partial = { role: "assistant", content: [{ type: "text", text: "Real nested." }] };
      emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Real ", partial },
        message: partial,
      });
      emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "nested.", partial },
        message: partial,
      });
      emit({ type: "agent_end", messages: [], willRetry: false });
      emit({ type: "agent_settled" });
      return;
    }

    // P5 empty-output diagnosis: a COMPLETED run that emits no assistant text
    // (no message_update.text_delta) so the broker must persist no
    // agent_message and still append the completed terminal.
    if (typeof cmd.message === "string" && cmd.message.includes("emptyoutput")) {
      emit({ type: "queue_update", steering: [], followUp: [] });
      emit({ type: "agent_end", messages: [] });
      emit({ type: "agent_settled" });
      return;
    }

    // If the message requests a BLOCKING approval ("waitapprove"), emit an
    // extension_ui_request and hold agent_end until the matching
    // extension_ui_response (or abort) arrives. This models a real approval
    // gate deterministically for room/gateway lifecycle tests.
    if (typeof cmd.message === "string" && cmd.message.includes("waitapprove")) {
      waitingApprovalId = "ui-req-" + Date.now() + "-" + process.pid + "-" + ++approvalSeq;
      emit({
        type: "extension_ui_request",
        id: waitingApprovalId,
        method: "confirm",
        title: "Approve action?",
        message: "The agent wants to proceed.",
      });
      return;
    }

    // If the message requests approval, emit an extension_ui_request before
    // completing the turn, so the approval round-trip can be tested. The
    // trigger is the exact token "approve" (word-bounded): the C5-3 root
    // prompt legitimately contains "approves"/"approved" in its gate
    // capability wording and must not be misread as a worker approval.
    if (typeof cmd.message === "string" && /\bapprove\b/.test(cmd.message)) {
      emit({
        type: "extension_ui_request",
        id: "ui-req-" + Date.now() + "-" + process.pid + "-" + ++approvalSeq,
        method: "confirm",
        title: "Approve action?",
        message: "The agent wants to proceed.",
      });
    }

    emit({ type: "message_update", role: "assistant", assistantMessageEvent: { type: "text_delta", delta: "Hel" } });
    emit({ type: "message_update", role: "assistant", assistantMessageEvent: { type: "text_delta", delta: "lo" } });
    // Emit a queue_update so the steering bridge path is exercised.
    emit({ type: "queue_update", steering: [], followUp: [] });
    emit({ type: "agent_end", messages: [] });
    // TB0/G1: agent_end alone is never terminal; the run completes only on
    // agent_settled (proves no retry, compaction retry, or queued continuation
    // remains per docs/rpc.md).
    emit({ type: "agent_settled" });
    return;
  }
  if (cmd.type === "steer") {
    // P5 steer-rejection trigger: a steer whose message names steerfail is
    // rejected by Pi (ack success:false), modeling a bounded steer failure.
    if (typeof cmd.message === "string" && cmd.message.includes("steerfail")) {
      emit({ type: "response", command: "steer", success: false, id: cmd.id, error: "steer rejected (fake)" });
      return;
    }
    emit({ type: "response", command: "steer", success: true, id: cmd.id });
    return;
  }
  if (cmd.type === "follow_up") {
    emit({ type: "response", command: "follow_up", success: true, id: cmd.id });
    return;
  }
  if (cmd.type === "extension_ui_response") {
    // Pi resolves the pending request internally; no ack response is sent back.
    // A response for a reserved conversation-handoff control request completes
    // the held turn: immediately for an accepted/rejected workflow result, or
    // after the bounded root-gate hold when the result is pending (the steward
    // confirms via the approve route while the run stays active).
    if (waitingConversationHandoffId !== null && cmd.id === waitingConversationHandoffId) {
      waitingConversationHandoffId = null;
      let status = "";
      try {
        if (typeof cmd.value === "string") {
          const parsed = JSON.parse(cmd.value);
          if (parsed && typeof parsed.status === "string") status = parsed.status;
        }
      } catch {
        // a malformed value still completes the held turn below
      }
      const complete = () => {
        emit({ type: "message_update", role: "assistant", assistantMessageEvent: { type: "text_delta", delta: " Handoff settled (" + (status || "unknown") + ")." } });
        emit({ type: "queue_update", steering: [], followUp: [] });
        emit({ type: "agent_end", messages: [] });
        emit({ type: "agent_settled" });
      };
      if (status === "pending") {
        setTimeout(complete, CONVERSATION_HANDOFF_ROOT_HOLD_MS);
      } else {
        complete();
      }
      return;
    }
    // A response for a blocking waitapprove request completes the held turn.
    if (waitingApprovalId !== null && cmd.id === waitingApprovalId) {
      waitingApprovalId = null;
      emit({ type: "message_update", role: "assistant", assistantMessageEvent: { type: "text_delta", delta: "Approved." } });
      emit({ type: "agent_end", messages: [] });
      emit({ type: "agent_settled" });
    }
    return;
  }
  if (cmd.type === "get_state") {
    emit({ type: "response", command: "get_state", success: true, id: cmd.id, data: { sessionId: "fake-session", isStreaming: false, thinkingLevel: "off", messageCount: promptCount, pendingMessageCount: 0 } });
    return;
  }
  if (cmd.type === "get_session_stats") {
    // T1 deterministic session-stats scenarios (docs/rpc.md shapes). Default:
    // fully numeric usage including a populated contextUsage, plus one unknown
    // extra field to prove typed results never leak raw unknown data.
    if (process.env.FAKE_PI_SESSION_STATS_FAIL === "1") {
      emit({ type: "response", command: "get_session_stats", success: false, id: cmd.id, error: "get_session_stats rejected by fake" });
      return;
    }
    if (process.env.FAKE_PI_SESSION_STATS_MALFORMED === "1") {
      emit({ type: "response", command: "get_session_stats", success: true, id: cmd.id, data: "unexpected-non-object" });
      return;
    }
    if (process.env.FAKE_PI_SESSION_STATS_BAD_CONTEXT === "1") {
      emit({
        type: "response",
        command: "get_session_stats",
        success: true,
        id: cmd.id,
        data: {
          sessionFile: "/tmp/fake-session.jsonl",
          sessionId: "fake-session-1",
          userMessages: 5,
          assistantMessages: 5,
          toolCalls: 12,
          toolResults: 12,
          totalMessages: 22,
          tokens: { input: 50000, output: 10000, cacheRead: 40000, cacheWrite: 5000, total: 105000 },
          cost: 0.45,
          // Structurally invalid: wrong types for every contextUsage field.
          contextUsage: { tokens: "many", contextWindow: "wide", percent: true },
        },
      });
      return;
    }
    if (process.env.FAKE_PI_SESSION_STATS_INVALID_SCALARS === "1") {
      // Undocumented/malformed documented scalars: the wrapper must reject,
      // never fabricate a real-looking zero or null metric.
      emit({
        type: "response",
        command: "get_session_stats",
        success: true,
        id: cmd.id,
        data: {
          sessionFile: 12345,
          sessionId: "fake-session-1",
          userMessages: "five",
          assistantMessages: 5,
          toolCalls: 12,
          toolResults: 12,
          totalMessages: 22,
          tokens: { input: 50000, output: 10000, cacheRead: 40000, cacheWrite: 5000, total: 105000 },
          cost: 0.45,
        },
      });
      return;
    }
    if (process.env.FAKE_PI_SESSION_STATS_NULL_CONTEXT === "1") {
      // A PRESENT contextUsage: null is not one of the two documented states
      // (omitted property / object with nullable tokens+percent): malformed.
      emit({
        type: "response",
        command: "get_session_stats",
        success: true,
        id: cmd.id,
        data: {
          sessionFile: "/tmp/fake-session.jsonl",
          sessionId: "fake-session-1",
          userMessages: 5,
          assistantMessages: 5,
          toolCalls: 12,
          toolResults: 12,
          totalMessages: 22,
          tokens: { input: 50000, output: 10000, cacheRead: 40000, cacheWrite: 5000, total: 105000 },
          cost: 0.45,
          contextUsage: null,
        },
      });
      return;
    }
    const data = {
      sessionFile: "/tmp/fake-session.jsonl",
      sessionId: "fake-session-1",
      userMessages: 5,
      assistantMessages: 5,
      toolCalls: 12,
      toolResults: 12,
      totalMessages: 22,
      tokens: { input: 50000, output: 10000, cacheRead: 40000, cacheWrite: 5000, total: 105000 },
      cost: 0.45,
      contextUsage: { tokens: 60000, contextWindow: 200000, percent: 30 },
      unexpectedExtra: { nested: true },
    };
    if (process.env.FAKE_PI_SESSION_STATS_NO_WINDOW === "1") {
      // No model/context window available: contextUsage is omitted entirely.
      delete data.contextUsage;
    }
    if (process.env.FAKE_PI_SESSION_STATS_POST_COMPACTION === "1") {
      // Immediately after compaction: present object, null usage numbers.
      data.contextUsage = { tokens: null, contextWindow: 200000, percent: null };
    }
    emit({ type: "response", command: "get_session_stats", success: true, id: cmd.id, data });
    return;
  }
  if (cmd.type === "get_available_models") {
    emit({
      type: "response",
      command: "get_available_models",
      success: true,
      id: cmd.id,
      data: {
        models: [
          { provider: "anthropic", id: "claude-sonnet-4-20250514", contextWindow: 200000, reasoning: true },
          { provider: "openai", id: "gpt-4.1", contextWindow: 128000, reasoning: false },
        ],
      },
    });
    return;
  }
  if (cmd.type === "set_model") {
    if (cmd.provider === "bogus" || cmd.modelId === "nope") {
      emit({ type: "response", command: "set_model", success: false, id: cmd.id, error: "model not found" });
      return;
    }
    // TB4 review: a modelId containing "slowmo" gets a delayed ack so tests
    // can land a steward abort deterministically during the set_model
    // round-trip (proves abort cancels the pending fallback re-prompt).
    const finishSetModel = () => {
      currentModelId = cmd.provider + "/" + cmd.modelId;
      emit({ type: "response", command: "set_model", success: true, id: cmd.id, data: { provider: cmd.provider, id: cmd.modelId } });
      emit({ type: "model_changed", model: { provider: cmd.provider, id: cmd.modelId } });
    };
    if (typeof cmd.modelId === "string" && cmd.modelId.includes("slowmo")) {
      setTimeout(finishSetModel, 250);
      return;
    }
    finishSetModel();
    return;
  }
  if (cmd.type === "set_thinking_level") {
    emit({ type: "response", command: "set_thinking_level", success: true, id: cmd.id });
    emit({ type: "thinking_level_changed", level: cmd.level });
    return;
  }
  if (cmd.type === "abort") {
    emit({ type: "response", command: "abort", success: true, id: cmd.id });
    // Model the real behavior: aborting a turn emits agent_end and then
    // agent_settled (an aborted run is fully settled), so active SSE streams
    // close cleanly. Brokers that already settled the run as cancelled treat
    // both events as stale and ignore them.
    waitingApprovalId = null;
    waitingConversationHandoffId = null;
    emit({ type: "agent_end", messages: [] });
    emit({ type: "agent_settled" });
    return;
  }
  if (cmd.type === "get_messages") {
    emit({
      type: "response",
      command: "get_messages",
      success: true,
      id: cmd.id,
      data: {
        messages: process.env.FAKE_PI_EMPTY_MESSAGES === "1" ? [] : [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi there!" },
        ],
      },
    });
    return;
  }
  if (cmd.type === "switch_session") {
    // A sessionPath of "cancel" simulates the user cancelling the resume.
    const cancelled = cmd.sessionPath === "cancel";
    emit({ type: "response", command: "switch_session", success: true, id: cmd.id, data: { cancelled } });
    return;
  }
  if (cmd.type === "new_session") {
    if (process.env.FAKE_PI_NEW_SESSION_FAIL === "1") {
      emit({ type: "response", command: "new_session", success: false, id: cmd.id, error: "new_session rejected by fake" });
      return;
    }
    emit({ type: "response", command: "new_session", success: true, id: cmd.id, data: { cancelled: process.env.FAKE_PI_NEW_SESSION_CANCEL === "1" } });
    return;
  }
  if (cmd.type === "compact") {
    if (process.env.FAKE_PI_COMPACT_FAIL === "1") {
      emit({ type: "response", command: "compact", success: false, id: cmd.id, error: "compact rejected by fake" });
      return;
    }
    emit({
      type: "response",
      command: "compact",
      success: true,
      id: cmd.id,
      data: { summary: "fake summary", firstKeptEntryId: "entry-1", tokensBefore: 150000, estimatedTokensAfter: 32000 },
    });
    return;
  }
  emit({ type: "response", command: String(cmd.type), success: true, id: cmd.id });
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newlineIndex;
  while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      // Ignore non-JSON lines, mirroring a tolerant reader.
    }
  }
});
process.stdin.on("end", () => process.exit(0));
