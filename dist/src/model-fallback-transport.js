/**
 * TB7 — pure transport model-fallback core (filesystem/Pi-auth-free).
 *
 * See Projects/Piren/model-fallbacks-design.md §4.2/§4.3, §5, §6.4, §7, TB7.
 * This module decides same-live-client rotation over an injected seam (the
 * transport owns the platform adaptation: clients, APIs, chunking). The
 * transport passes its conversation-specific client's `promptAndWait`/`setModel`
 * and streams bounded non-secret notices for platform advisory rendering.
 *
 * Continuation happens ONLY for a fully-settled zero-side-effect eligible
 * provider error (`classifyRunOutcome` + `isFallbackEligibleOutcome`) on the
 * SAME live client/session: `set_model(next)` then a handoff re-prompt wrapping
 * the ORIGINAL inbound prompt verbatim. Declaration-order at-most-once through
 * `planFallbackAttempt`; a rejected `set_model` is an attempted unavailable
 * skip that keeps the settled outcome pending (never re-runs the request on
 * the just-failed model); exhaustion is a distinct terminal result with safe
 * category/model/count evidence only. Absent/malformed/disabled/no-primary
 * policy is inert (single run, no notices). Abort authority (`isAborted`)
 * checked at every await boundary prevents any handoff re-prompt.
 */
import { classifyRunOutcome, isFallbackEligibleOutcome, } from "./model-fallback-outcome.js";
import { planFallbackAttempt, buildFallbackHandoffPrompt } from "./model-fallback-rotation.js";
import { splitFallbackModelId } from "./model-fallback-gateway.js";
/**
 * Run one inbound transport prompt with bounded same-live-client fallback.
 * Returns the terminal attempt's events (the transport extracts the text) and
 * streams bounded notices. A run rejection (prompt rejection / timeout /
 * client exit) propagates — the transport keeps its existing conservative
 * response behavior. `isAborted` is checked before every side effect so an
 * abort landing at any point (including during `set_model`) prevents the
 * handoff re-prompt.
 */
export async function runTransportFallback(input) {
    const isAborted = input.isAborted ?? (() => false);
    const policy = input.policy;
    // Sam's dc81a41 guard: without a configured primary identity the transport
    // cannot prove a fallback differs from the just-failed Pi model; stay inert.
    const config = policy.primaryModelId !== null && policy.fallback.ok && policy.fallback.present ? policy.fallback.config : null;
    if (config === null) {
        const events = await input.run(input.originalPrompt);
        return { status: "completed", events };
    }
    let currentModelId = policy.primaryModelId;
    const attemptedModelIds = [];
    let prompt = input.originalPrompt;
    // The last settled attempt awaiting a rotation decision. A rejected
    // set_model keeps it pending so the loop plans the NEXT configured fallback
    // directly (design §5.1/§7) instead of re-running the request on the
    // just-failed model. Only a successful switch clears it.
    let pending = null;
    let result = null;
    while (result === null) {
        if (pending === null) {
            const events = await input.run(prompt);
            if (isAborted()) {
                result = { status: "completed", events };
                break;
            }
            pending = { events, outcome: classifyRunOutcome(events) };
        }
        const { events, outcome } = pending;
        const plan = planFallbackAttempt({
            configuredFallbacks: config.models,
            autoSwitch: config.autoSwitch,
            explicitModelSelected: false,
            aborted: false,
            outcome,
            currentModelId: currentModelId ?? "",
            attemptedModelIds,
        });
        if (plan.kind === "no-attempt" || !isFallbackEligibleOutcome(outcome)) {
            // Non-eligible outcome (completed/ambiguous/aborted): existing terminal
            // semantics, no fallback.
            result = { status: "completed", events };
            break;
        }
        if (plan.kind === "exhausted") {
            const notice = {
                kind: "exhausted",
                lastModelId: currentModelId ?? "",
                category: outcome.category,
                attemptedCount: plan.attemptedCount,
            };
            await input.onNotice(notice);
            result = {
                status: "exhausted",
                events,
                lastModelId: notice.lastModelId,
                category: outcome.category,
                attemptedCount: plan.attemptedCount,
            };
            break;
        }
        // A planned attempt: stream the attempt notice, then set_model on the same
        // live client.
        await input.onNotice({
            kind: "attempt",
            from: currentModelId ?? "",
            to: plan.modelId,
            category: outcome.category,
            attempt: plan.attemptNumber,
        });
        if (isAborted()) {
            result = { status: "completed", events };
            break;
        }
        const split = splitFallbackModelId(plan.modelId);
        let switched = false;
        try {
            await input.setModel(split.provider, split.modelId);
            currentModelId = plan.modelId;
            switched = true;
        }
        catch {
            // Unavailable fallback: bounded attempted skip; never retried within
            // the incident and never re-prompts the just-failed model.
        }
        attemptedModelIds.push(plan.modelId);
        if (isAborted()) {
            // Abort landed during set_model: steward intent wins, no re-prompt.
            result = { status: "completed", events };
            break;
        }
        if (!switched) {
            await input.onNotice({ kind: "unavailable", modelId: plan.modelId, attempt: plan.attemptNumber });
            if (isAborted()) {
                result = { status: "completed", events };
                break;
            }
            // Keep the pending outcome: plan the next candidate without a re-prompt.
            continue;
        }
        prompt = buildFallbackHandoffPrompt(input.originalPrompt, plan.modelId, outcome.category);
        pending = null;
    }
    return result;
}
/**
 * Render one bounded non-secret notice as platform advisory text (design
 * §6.4). Never carries raw provider error text, status codes, credentials,
 * session paths, or config paths.
 */
export function renderTransportFallbackNotice(notice) {
    switch (notice.kind) {
        case "attempt":
            return `[model fallback: ${notice.from} failed (${notice.category}) → ${notice.to}]`;
        case "unavailable":
            return `[model fallback: ${notice.modelId} unavailable; skipping]`;
        case "exhausted":
            return `[model fallback: exhausted after ${notice.attemptedCount} attempt(s) on ${notice.lastModelId} (${notice.category})]`;
    }
}
//# sourceMappingURL=model-fallback-transport.js.map