export declare const CORRECTION_STRONG_PATTERN_SOURCES: readonly ["don'?t do that", "not like that", "^I said\\b", "^I told you\\b", "we already discussed", "^please don'?t", "^that'?s not what I"];
export declare const CORRECTION_WEAK_PATTERN_SOURCES: readonly ["^no[,\\.\\s!]", "^wrong[,\\.\\s!]", "^actually[,\\.\\s]", "^stop[,\\.\\s!]"];
export declare const CORRECTION_NEGATIVE_PATTERN_SOURCES: readonly ["^no worries", "^no problem", "^no thanks", "^no need", "^actually.{0,10}(looks? great|perfect|good|correct|right)", "^stop.{0,5}(there|here|for now)"];
export declare const CORRECTION_DIRECTIVE_WORDS: readonly ["use", "don't", "dont", "do", "try", "make", "run", "install", "add", "remove", "delete", "change", "fix", "put", "set", "write", "go", "stop", "start", "the", "that", "this", "it"];
export interface CorrectionTriggerConfig {
    strongPatterns?: readonly string[];
    weakPatterns?: readonly string[];
    negativePatterns?: readonly string[];
    directiveWords?: readonly string[];
}
export interface CorrectionTriggerResult {
    triggered: boolean;
    confidence: "none" | "strong" | "weak";
    text: string;
    directive: string;
    matchedPattern: string;
}
export interface CorrectionArtifactSuggestion {
    tool: "project_append_log" | "skill_candidate_write" | "decision_record" | "wiki_update_concept" | "wiki_update_entity";
    reason: string;
}
export declare function detectCorrectionTrigger(text: string, config?: CorrectionTriggerConfig): CorrectionTriggerResult;
export declare function suggestCorrectionArtifacts(text: string): CorrectionArtifactSuggestion[];
export declare function formatCorrectionArtifactNudge(result: CorrectionTriggerResult): string;
export interface AutoNudgeConfigInput {
    env?: Record<string, string | undefined>;
    config?: Record<string, unknown> | null;
}
export interface AutoNudgeConfigResolution {
    enabled: boolean;
    source: "env" | "config" | "default";
}
export declare function resolveAutoNudgeConfig(input?: AutoNudgeConfigInput): AutoNudgeConfigResolution;
export interface AutoNudgeNotification {
    text: string;
    confidence: "strong" | "weak";
    directive: string;
    matchedPattern: string;
    suggestions: CorrectionArtifactSuggestion[];
}
export declare function buildAutoNudgeNotification(message: string): AutoNudgeNotification | null;
export interface ReviewLoopConfigResolution {
    enabled: boolean;
    source: "env" | "config" | "default";
    intervalTurns: number;
    recentMessages: number;
    timeoutMs: number;
}
export declare function resolveReviewLoopConfig(input?: AutoNudgeConfigInput): ReviewLoopConfigResolution;
export declare function collectReviewConversation(entries: readonly unknown[], recentMessages?: number): string[];
export interface SelfImprovementReviewPromptInput {
    agentName: string;
    vaultRoot: string;
    conversation: readonly string[];
}
export declare function buildSelfImprovementReviewPrompt(input: SelfImprovementReviewPromptInput): string;
