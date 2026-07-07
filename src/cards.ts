import { compactWhitespace, estimateTokens, firstMeaningfulLine, truncateText } from "./text";
import type { ChunkDecisionCard, ChunkKind, ChunkSource, PruneChunksConfig } from "./types";

const MAX_ITEMS = 4;
const DEFAULT_MAX_CHARS = 120;

export function buildDecisionCard(input: {
  kind: ChunkKind;
  toolName: string;
  text: string;
  source?: ChunkSource;
  maxChars?: number;
  modelCardResponse?: unknown;
  decisionCards?: PruneChunksConfig["decisionCards"];
}): ChunkDecisionCard {
  const { kind, toolName, text, source } = input;
  const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;

  const heuristic = (() => {
    switch (kind) {
      case "file_read":
        return fileReadCard(text, source, maxChars);
      case "search":
        return searchCard(text, source, maxChars);
      case "test_output":
        return testOutputCard(text, source, maxChars);
      case "diff":
        return diffCard(text, source, maxChars);
      case "context_pack":
      case "flow_trace":
      case "outline":
      case "symbol":
        return contextCard(kind, toolName, text, source, maxChars);
      case "shell":
      case "other":
        return shellCard(kind, toolName, text, source, maxChars);
    }
  })();

  return modelDecisionCardFromResponse(
    input.modelCardResponse,
    heuristic,
    input.decisionCards ?? {
      mode: "heuristic",
      maxModelInputTokens: 0,
      maxModelOutputChars: DEFAULT_MAX_CHARS,
    },
  );
}

export function buildModelDecisionCardPrompt(input: {
  kind: ChunkKind;
  toolName: string;
  text: string;
  source?: ChunkSource;
  decisionCards: PruneChunksConfig["decisionCards"];
}): string | null {
  if (input.decisionCards.mode !== "model-assisted") return null;
  const tokenBudget = Math.max(1, input.decisionCards.maxModelInputTokens);
  const charBudget = tokenBudget * 4;
  const text = truncateText(input.text, charBudget);
  const omitted =
    estimateTokens(input.text) > tokenBudget ? "\n[Input truncated to model-card budget]" : "";
  return [
    "Create a compact JSON decision card for a restorable tool-result chunk.",
    'Return only JSON with: {"gist":string,"evidence":string[],"restoreWhen":string[],"safeToIgnoreWhen"?:string[],"sourceAnchors"?:string[],"hazards"?:string[]}.',
    `Tool: ${input.toolName}`,
    `Kind: ${input.kind}`,
    input.source?.path ? `Source: ${sourceLabel(input.source)}` : "Source: unknown",
    "Content:",
    text,
    omitted,
  ]
    .filter(Boolean)
    .join("\n");
}

export function modelDecisionCardFromResponse(
  response: unknown,
  fallback: ChunkDecisionCard,
  config: PruneChunksConfig["decisionCards"],
): ChunkDecisionCard {
  if (config.mode !== "model-assisted" || response == null) return fallback;
  const parsed = parseModelCardResponse(response);
  if (!parsed) return fallback;
  const maxChars = Math.max(1, config.maxModelOutputChars);
  const gist = truncateText(compactWhitespace(parsed.gist), maxChars);
  if (!gist) return fallback;
  return {
    gist,
    evidence: compactModelItems(parsed.evidence, maxChars),
    restoreWhen: compactModelItems(parsed.restoreWhen, maxChars),
    safeToIgnoreWhen: parsed.safeToIgnoreWhen
      ? compactModelItems(parsed.safeToIgnoreWhen, maxChars)
      : undefined,
    sourceAnchors: parsed.sourceAnchors
      ? compactModelItems(parsed.sourceAnchors, maxChars)
      : undefined,
    hazards: parsed.hazards ? compactModelItems(parsed.hazards, maxChars) : undefined,
    generatedBy: "model",
  };
}

export function compactDecisionCard(card: ChunkDecisionCard, maxChars: number): string {
  const parts = [
    card.gist,
    card.evidence.length > 0 ? `evidence: ${card.evidence.join("; ")}` : "",
    card.restoreWhen.length > 0 ? `restore when: ${card.restoreWhen.join("; ")}` : "",
  ].filter(Boolean);
  return truncateText(compactWhitespace(parts.join(" | ")), maxChars);
}

function fileReadCard(
  text: string,
  source: ChunkSource | undefined,
  maxChars: number,
): ChunkDecisionCard {
  const anchor = sourceLabel(source);
  const evidence = semanticLines(text, maxChars);
  return card({
    gist: anchor ? `read ${anchor}` : `read source: ${firstLine(text, maxChars)}`,
    evidence,
    restoreWhen: ["editing this source", "need exact omitted lines"],
    safeToIgnoreWhen: ["path/range and visible anchors are enough"],
    sourceAnchors: anchor ? [anchor] : undefined,
  });
}

function searchCard(
  text: string,
  source: ChunkSource | undefined,
  maxChars: number,
): ChunkDecisionCard {
  const paths = unique(
    matches(text, /(?:^|\s)((?:[./\w-]+\/)+[\w.-]+):(\d+)/gm).map((match) => match[1]),
  ).slice(0, MAX_ITEMS);
  const zeroMatch = /\b(no matches|no results|0 results|0 matches|found 0)\b/i.test(text);
  const query = source?.command ? truncateText(source.command, maxChars) : undefined;
  return card({
    gist: zeroMatch
      ? `search found no matches${query ? ` for ${query}` : ""}`
      : `search returned ${paths.length || "some"} top path${paths.length === 1 ? "" : "s"}`,
    evidence: paths.length > 0 ? paths : semanticLines(text, maxChars),
    restoreWhen: ["need full snippets", "need additional hits"],
    safeToIgnoreWhen: zeroMatch
      ? ["absence of matches is sufficient"]
      : ["top hit paths are sufficient"],
    sourceAnchors: [...(query ? [query] : []), ...paths],
  });
}

function testOutputCard(
  text: string,
  source: ChunkSource | undefined,
  maxChars: number,
): ChunkDecisionCard {
  const failureLines = lines(text).filter((line) =>
    /\b(FAIL|FAILED|AssertionError|Error:|✖|panic:)\b/.test(line),
  );
  const failed = failureLines.length > 0 || /\b(failures?|failed)\b/i.test(text);
  const command = source?.command ?? shellPromptCommand(text);
  return card({
    gist: `${command ? `${command}: ` : ""}${failed ? "test failure output" : "test output"}`,
    evidence: (failed ? failureLines : semanticLines(text, maxChars)).slice(0, MAX_ITEMS),
    restoreWhen: failed
      ? ["debugging the failing test", "need full stack trace"]
      : ["need full test log"],
    safeToIgnoreWhen: failed ? undefined : ["only pass/fail status matters"],
    sourceAnchors: command ? [command] : undefined,
    hazards: failed ? ["contains failure output"] : undefined,
  });
}

function diffCard(
  text: string,
  source: ChunkSource | undefined,
  maxChars: number,
): ChunkDecisionCard {
  const files = unique(
    matches(text, /^diff --git a\/(.+?) b\/(.+)$/gm).map((match) => match[2]),
  ).slice(0, MAX_ITEMS);
  const hunkCount = matches(text, /^@@/gm).length;
  const sourceAnchor = source?.path ? [source.path] : undefined;
  return card({
    gist: `diff touching ${files.length || "unknown"} file${files.length === 1 ? "" : "s"}${hunkCount ? `, ${hunkCount} hunks` : ""}`,
    evidence: files.length > 0 ? files : semanticLines(text, maxChars),
    restoreWhen: ["reviewing exact patch", "checking changed lines"],
    safeToIgnoreWhen: ["changed-file list is enough"],
    sourceAnchors: files.length > 0 ? files : sourceAnchor,
  });
}

function contextCard(
  kind: ChunkKind,
  toolName: string,
  text: string,
  source: ChunkSource | undefined,
  maxChars: number,
): ChunkDecisionCard {
  const signalLines = lines(text).filter((line) =>
    /\b(readiness|ready|warning|missing|tests?|impact|symbol|source|caller|callee)\b/i.test(line),
  );
  return card({
    gist: `${kind}/${toolName}: ${firstLine(text, maxChars)}`,
    evidence: (signalLines.length > 0 ? signalLines : semanticLines(text, maxChars)).slice(
      0,
      MAX_ITEMS,
    ),
    restoreWhen: ["need full context pack", "need omitted source/test evidence"],
    safeToIgnoreWhen: ["card evidence answers the planning question"],
    sourceAnchors: source?.path ? [source.path] : undefined,
  });
}

function shellCard(
  kind: ChunkKind,
  toolName: string,
  text: string,
  source: ChunkSource | undefined,
  maxChars: number,
): ChunkDecisionCard {
  const command = source?.command ?? shellPromptCommand(text);
  const errorLines = lines(text).filter((line) =>
    /\b(error|exception|failed|denied|not found)\b/i.test(line),
  );
  return card({
    gist: `${command ?? `${kind}/${toolName}`}: ${firstLine(text, maxChars)}`,
    evidence: (errorLines.length > 0 ? errorLines : semanticLines(text, maxChars)).slice(
      0,
      MAX_ITEMS,
    ),
    restoreWhen: ["need full command output"],
    safeToIgnoreWhen: ["command and salient lines are enough"],
    sourceAnchors: command ? [command] : source?.path ? [source.path] : undefined,
    hazards: errorLines.length > 0 ? ["contains error output"] : undefined,
  });
}

type ModelCardShape = Omit<ChunkDecisionCard, "generatedBy">;

function parseModelCardResponse(response: unknown): ModelCardShape | null {
  const value = typeof response === "string" ? safeJsonParse(response) : response;
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<Record<keyof ModelCardShape, unknown>>;
  if (typeof candidate.gist !== "string") return null;
  if (!Array.isArray(candidate.evidence) || !Array.isArray(candidate.restoreWhen)) return null;
  return {
    gist: candidate.gist,
    evidence: stringArray(candidate.evidence),
    restoreWhen: stringArray(candidate.restoreWhen),
    safeToIgnoreWhen: Array.isArray(candidate.safeToIgnoreWhen)
      ? stringArray(candidate.safeToIgnoreWhen)
      : undefined,
    sourceAnchors: Array.isArray(candidate.sourceAnchors)
      ? stringArray(candidate.sourceAnchors)
      : undefined,
    hazards: Array.isArray(candidate.hazards) ? stringArray(candidate.hazards) : undefined,
  };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stringArray(values: unknown[]): string[] {
  return values.filter((value): value is string => typeof value === "string");
}

function compactModelItems(values: string[], maxChars: number): string[] {
  return unique(values.map((value) => truncateText(compactWhitespace(value), maxChars))).slice(
    0,
    MAX_ITEMS,
  );
}

function card(input: Omit<ChunkDecisionCard, "generatedBy">): ChunkDecisionCard {
  return {
    ...input,
    evidence: compactItems(input.evidence),
    restoreWhen: compactItems(input.restoreWhen),
    safeToIgnoreWhen: input.safeToIgnoreWhen ? compactItems(input.safeToIgnoreWhen) : undefined,
    sourceAnchors: input.sourceAnchors ? compactItems(input.sourceAnchors) : undefined,
    hazards: input.hazards ? compactItems(input.hazards) : undefined,
    generatedBy: "heuristic",
  };
}

function sourceLabel(source: ChunkSource | undefined): string | undefined {
  if (!source?.path) return undefined;
  if (source.startLine != null && source.endLine != null) {
    return `${source.path}:${source.startLine}-${source.endLine}`;
  }
  if (source.startLine != null) return `${source.path}:${source.startLine}`;
  return source.path;
}

function semanticLines(text: string, maxChars: number): string[] {
  return unique(
    lines(text)
      .filter((line) => /\S/.test(line))
      .filter((line) => !/^[-=_]{3,}$/.test(line))
      .slice(0, 12)
      .map((line) => truncateText(compactWhitespace(line), maxChars)),
  ).slice(0, MAX_ITEMS);
}

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => compactWhitespace(line))
    .filter(Boolean);
}

function firstLine(text: string, maxChars: number): string {
  return truncateText(compactWhitespace(firstMeaningfulLine(text)), maxChars);
}

function shellPromptCommand(text: string): string | undefined {
  const line = text.split(/\r?\n/).find((candidate) => /^[$>]\s+/.test(candidate.trim()));
  return line?.trim().replace(/^[$>]\s+/, "");
}

function matches(text: string, pattern: RegExp): RegExpMatchArray[] {
  return [...text.matchAll(pattern)];
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function compactItems(values: string[]): string[] {
  return unique(
    values.map((value) => truncateText(compactWhitespace(value), DEFAULT_MAX_CHARS)),
  ).slice(0, MAX_ITEMS);
}
