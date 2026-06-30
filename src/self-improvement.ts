export const CORRECTION_STRONG_PATTERN_SOURCES = [
  "don'?t do that",
  "not like that",
  "^I said\\b",
  "^I told you\\b",
  "we already discussed",
  "^please don'?t",
  "^that'?s not what I",
] as const;

export const CORRECTION_WEAK_PATTERN_SOURCES = [
  "^no[,\\.\\s!]",
  "^wrong[,\\.\\s!]",
  "^actually[,\\.\\s]",
  "^stop[,\\.\\s!]",
] as const;

export const CORRECTION_NEGATIVE_PATTERN_SOURCES = [
  "^no worries",
  "^no problem",
  "^no thanks",
  "^no need",
  "^actually.{0,10}(looks? great|perfect|good|correct|right)",
  "^stop.{0,5}(there|here|for now)",
] as const;

export const CORRECTION_DIRECTIVE_WORDS = [
  "use",
  "don't",
  "dont",
  "do",
  "try",
  "make",
  "run",
  "install",
  "add",
  "remove",
  "delete",
  "change",
  "fix",
  "put",
  "set",
  "write",
  "go",
  "stop",
  "start",
  "the",
  "that",
  "this",
  "it",
] as const;

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

function compilePattern(source: string): RegExp | null {
  try {
    return new RegExp(source, "i");
  } catch {
    return null;
  }
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasDirectiveWord(remainder: string, words: readonly string[]): boolean {
  if (words.length === 0) return false;
  const source = words.map(escapeRegexLiteral).join("|");
  return new RegExp(`\\b(${source})\\b`, "i").test(remainder);
}

function firstMatch(text: string, sources: readonly string[]): { source: string; pattern: RegExp; match: RegExpExecArray } | null {
  for (const source of sources) {
    const pattern = compilePattern(source);
    if (!pattern) continue;
    const match = pattern.exec(text);
    if (match) return { source, pattern, match };
  }
  return null;
}

function extractDirective(text: string, match?: RegExpExecArray): string {
  const afterMatch = match && match.index === 0 ? text.slice(match[0].length).trim() : text;
  const cleaned = afterMatch
    .replace(/^(please\s+)?don'?t\s+/i, "")
    .replace(/^(please\s+)?/i, "")
    .replace(/^(no|wrong|actually|stop|that'?s not|I said|I told you)[,\.\s!]+/i, "")
    .trim();
  return cleaned || text.trim();
}

export function detectCorrectionTrigger(text: string, config: CorrectionTriggerConfig = {}): CorrectionTriggerResult {
  const trimmed = text.trim();
  const negativeSources = config.negativePatterns ?? CORRECTION_NEGATIVE_PATTERN_SOURCES;
  if (firstMatch(trimmed, negativeSources)) {
    return { triggered: false, confidence: "none", text: trimmed, directive: "", matchedPattern: "" };
  }

  const strongSources = config.strongPatterns ?? CORRECTION_STRONG_PATTERN_SOURCES;
  const strong = firstMatch(trimmed, strongSources);
  if (strong) {
    return {
      triggered: true,
      confidence: "strong",
      text: trimmed,
      directive: extractDirective(trimmed, strong.match),
      matchedPattern: strong.source,
    };
  }

  const weakSources = config.weakPatterns ?? CORRECTION_WEAK_PATTERN_SOURCES;
  const directiveWords = config.directiveWords ?? CORRECTION_DIRECTIVE_WORDS;
  const weak = firstMatch(trimmed, weakSources);
  if (weak && weak.match.index === 0) {
    const remainder = trimmed.slice(weak.match[0].length).trim();
    if (hasDirectiveWord(remainder, directiveWords)) {
      return {
        triggered: true,
        confidence: "weak",
        text: trimmed,
        directive: extractDirective(trimmed, weak.match),
        matchedPattern: weak.source,
      };
    }
  }

  return { triggered: false, confidence: "none", text: trimmed, directive: "", matchedPattern: "" };
}

export function suggestCorrectionArtifacts(text: string): CorrectionArtifactSuggestion[] {
  const lower = text.toLowerCase();
  const suggestions: CorrectionArtifactSuggestion[] = [];

  if (lower.includes("project") || lower.includes("convention") || lower.includes("adr") || lower.includes("decision")) {
    suggestions.push(
      { tool: "project_append_log", reason: "Record the correction in the project's chronological visible history." },
      { tool: "skill_candidate_write", reason: "Draft a reusable procedure if this correction changes future agent workflow." },
      { tool: "decision_record", reason: "Capture durable architecture or policy corrections as an ADR when they set direction." },
      { tool: "wiki_update_concept", reason: "Promote the convention into an OKF Concept when it is reusable knowledge." },
    );
    return suggestions;
  }

  if (lower.includes("tool") || lower.includes("quirk") || lower.includes("command") || lower.includes("api")) {
    suggestions.push(
      { tool: "wiki_update_concept", reason: "Capture reusable tool behavior or quirks as an OKF Concept." },
      { tool: "skill_candidate_write", reason: "Draft a procedure when the correction changes how a tool should be used." },
      { tool: "project_append_log", reason: "Record project-scoped tool corrections in the project log." },
    );
    return suggestions;
  }

  if (lower.includes("person") || lower.includes("service") || lower.includes("system") || lower.includes("provider")) {
    suggestions.push(
      { tool: "wiki_update_entity", reason: "Capture corrected facts about a person, system, service, or provider as an OKF Entity." },
      { tool: "project_append_log", reason: "Record project-scoped entity corrections in the project log." },
    );
    return suggestions;
  }

  suggestions.push(
    { tool: "skill_candidate_write", reason: "Draft a reusable procedure if the correction prevents repeated mistakes." },
    { tool: "project_append_log", reason: "Record project-scoped corrections visibly in the project log." },
    { tool: "wiki_update_concept", reason: "Promote durable reusable knowledge into an OKF Concept." },
  );
  return suggestions;
}

export function formatCorrectionArtifactNudge(result: CorrectionTriggerResult): string {
  if (!result.triggered) return "No correction trigger detected.";
  const suggestions = suggestCorrectionArtifacts(result.text);
  const lines = [
    `Correction detected (${result.confidence}).`,
    result.directive ? `Directive: ${result.directive}` : "Directive: (not extracted)",
    "No hidden memory store, no SQLite, no silent pi.exec write.",
    "If this correction is durable, choose the minimum visible vault artifact:",
    ...suggestions.map((suggestion) => `- ${suggestion.tool}: ${suggestion.reason}`),
  ];
  return lines.join("\n");
}

export interface AutoNudgeConfigInput {
  env?: Record<string, string | undefined>;
  config?: Record<string, unknown> | null;
}

export interface AutoNudgeConfigResolution {
  enabled: boolean;
  source: "env" | "config" | "default";
}

function parseBooleanEnv(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return null;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

export function resolveAutoNudgeConfig(input: AutoNudgeConfigInput = {}): AutoNudgeConfigResolution {
  const envValue = parseBooleanEnv(input.env?.PIREN_AUTO_NUDGE);
  if (envValue !== null) {
    return { enabled: envValue, source: "env" };
  }
  const block = input.config?.self_improvement;
  if (block && typeof block === "object" && !Array.isArray(block)) {
    const candidate = (block as Record<string, unknown>).auto_nudge;
    if (typeof candidate === "boolean") {
      return { enabled: candidate, source: "config" };
    }
  }
  return { enabled: false, source: "default" };
}

export interface AutoNudgeNotification {
  text: string;
  confidence: "strong" | "weak";
  directive: string;
  matchedPattern: string;
  suggestions: CorrectionArtifactSuggestion[];
}

const AUTO_NUDGE_HEADER = "[ADR-0024 self-improvement nudge — advisory only, no hidden mutation]";

export function buildAutoNudgeNotification(message: string): AutoNudgeNotification | null {
  if (typeof message !== "string") return null;
  const trimmed = message.trim();
  if (trimmed === "") return null;
  const trigger = detectCorrectionTrigger(trimmed);
  if (!trigger.triggered) return null;
  if (trigger.confidence === "none") return null;
  const suggestions = suggestCorrectionArtifacts(trimmed);
  const body = formatCorrectionArtifactNudge(trigger);
  return {
    text: `${AUTO_NUDGE_HEADER}\n${body}`,
    confidence: trigger.confidence,
    directive: trigger.directive,
    matchedPattern: trigger.matchedPattern,
    suggestions,
  };
}
