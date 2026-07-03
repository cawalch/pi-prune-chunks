import { compactWhitespace, firstMeaningfulLine, truncateText } from "./text";
import type { ChunkDecisionCard, ChunkKind, ChunkSource } from "./types";

const MAX_ITEMS = 4;
const DEFAULT_MAX_CHARS = 120;

export function buildDecisionCard(input: {
  kind: ChunkKind;
  toolName: string;
  text: string;
  source?: ChunkSource;
  maxChars?: number;
}): ChunkDecisionCard {
  const { kind, toolName, text, source } = input;
  const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;

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
