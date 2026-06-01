import {
  compactWhitespace,
  contentText,
  estimateTokens,
  firstMeaningfulLine,
  hashText,
  summarizeText,
  truncateText,
} from "./text";
import type {
  ChunkKind,
  ChunkRisk,
  ChunkSource,
  CollectedChunk,
  ContentBlock,
  PruneChunksConfig,
} from "./types";

type ToolResultInput = {
  toolCallId: string;
  toolName: string;
  content: ContentBlock[];
  params?: Record<string, unknown>;
  config: PruneChunksConfig;
};

const REAMER_TOOL_KINDS: Record<string, ChunkKind> = {
  code_overview: "outline",
  repo_map: "outline",
  code_context: "context_pack",
  code_search: "search",
  code_search_symbols: "symbol",
  code_read_range: "file_read",
  code_read_symbol: "symbol",
  code_outline: "outline",
  code_related: "context_pack",
  code_pattern_search: "search",
  code_semantic_search: "search",
  code_flow_trace: "flow_trace",
};

const FLOW_TOOL_KINDS: Record<string, ChunkKind> = {
  flow_trace: "flow_trace",
  flow_path: "flow_trace",
  flow_impact: "flow_trace",
};

const GENERIC_TOOL_KINDS: Record<string, ChunkKind> = {
  read: "file_read",
  file_read: "file_read",
  view_file: "file_read",
  open_file: "file_read",
  cat: "file_read",
  search: "search",
  grep: "search",
  rg: "search",
  ripgrep: "search",
  code_search: "search",
  shell: "shell",
  bash: "shell",
  command: "shell",
  exec_command: "shell",
  terminal: "shell",
  git_diff: "diff",
  diff: "diff",
  test: "test_output",
  npm_test: "test_output",
  pytest: "test_output",
  go_test: "test_output",
};

export const TRACKED_TOOL_FAMILIES = new Set([
  ...Object.keys(REAMER_TOOL_KINDS),
  ...Object.keys(FLOW_TOOL_KINDS),
  ...Object.keys(GENERIC_TOOL_KINDS),
]);

export const INTERNAL_TOOL_NAMES = new Set([
  "list_context_chunks",
  "prune_chunks",
  "restore_chunks",
  "pin_chunks",
  "unpin_chunks",
  "context_pressure",
]);

export function collectToolResult(input: ToolResultInput): CollectedChunk | null {
  if (!input.config.enabled) return null;
  if (INTERNAL_TOOL_NAMES.has(input.toolName.toLowerCase())) return null;
  if (!shouldTrackTool(input.toolName, input.config.trackTools)) return null;

  const text = contentText(input.content);
  if (!text) return null;

  const tokenEstimate = estimateTokens(text);
  if (tokenEstimate < input.config.track.minChunkTokens) return null;

  const kind = classifyKind(input.toolName, text, input.params);
  const source = inferSource(input.toolCallId, input.toolName, text, input.params);
  const risk = classifyRisk(kind, text, source);
  const summary = summarizeText(text, input.config.tombstones.maxSummaryChars);
  const label = makeLabel(input.toolName, kind, text, source);

  return {
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    content: input.content,
    text,
    label,
    kind,
    risk,
    tokenEstimate,
    summary,
    source,
  };
}

export function classifyKind(
  toolName: string,
  text: string,
  params?: Record<string, unknown>,
): ChunkKind {
  const normalized = toolName.toLowerCase();
  const mapped =
    REAMER_TOOL_KINDS[normalized] ?? FLOW_TOOL_KINDS[normalized] ?? GENERIC_TOOL_KINDS[normalized];
  if (mapped && mapped !== "shell") return mapped;

  const command = stringParam(params, ["command", "cmd"]);
  const commandText = `${command ?? ""}\n${text}`;
  if (looksLikeDiff(commandText)) return "diff";
  if (looksLikeTestOutput(commandText)) return "test_output";
  if (looksLikeSearchOutput(commandText)) return "search";
  if (looksLikeFileRead(toolName, params, text)) return "file_read";
  if (mapped) return mapped;
  return "other";
}

export function classifyRisk(kind: ChunkKind, text: string, source?: ChunkSource): ChunkRisk {
  if (hasCurrentFailureSignal(text)) return "high";

  switch (kind) {
    case "search":
    case "flow_trace":
    case "outline":
    case "symbol":
      return "low";
    case "file_read":
      if (source?.path && isAnchorPath(source.path)) return "high";
      if (source?.startLine != null && source.endLine != null) return "low";
      return "medium";
    case "test_output":
      return looksSuccessfulTestOutput(text) ? "low" : "medium";
    case "diff":
    case "context_pack":
    case "shell":
      return "medium";
    case "other":
      return "medium";
  }
}

export function isAnchorPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  const basename = normalized.split("/").pop() ?? normalized;
  if (
    [
      "agents.md",
      "rules.md",
      "readme.md",
      "cargo.toml",
      "package.json",
      "pyproject.toml",
      "go.mod",
      "tsconfig.json",
      "biome.json",
    ].includes(basename)
  ) {
    return true;
  }
  return /(^|\/)src\/(lib|main|index)\.(rs|ts|tsx|js|jsx|mjs|cjs)$/.test(normalized);
}

export function inferSource(
  toolCallId: string,
  toolName: string,
  text: string,
  params?: Record<string, unknown>,
): ChunkSource {
  const source: ChunkSource = {
    toolCallId,
    contentHash: hashText(text),
  };

  const command = stringParam(params, ["command", "cmd"]);
  if (command) source.command = command;

  const path = stringParam(params, ["path", "file", "filename", "target", "sourcePath"]);
  if (path) source.path = path;

  const startLine = numberParam(params, ["startLine", "start_line", "lineStart", "fromLine"]);
  const endLine = numberParam(params, ["endLine", "end_line", "lineEnd", "toLine"]);
  if (startLine != null) source.startLine = startLine;
  if (endLine != null) source.endLine = endLine;

  const symbol = stringParam(params, ["symbol", "name"]);
  if (symbol) source.symbol = symbol;

  const inferred = inferLocationFromText(text);
  if (!source.path && inferred.path) source.path = inferred.path;
  if (source.startLine == null && inferred.startLine != null) source.startLine = inferred.startLine;
  if (source.endLine == null && inferred.endLine != null) source.endLine = inferred.endLine;

  if (!source.command && toolName.toLowerCase().includes("shell")) {
    const first = firstMeaningfulLine(text);
    if (first.startsWith("$ ")) source.command = first.slice(2);
  }

  return source;
}

export function makeLabel(
  toolName: string,
  kind: ChunkKind,
  text: string,
  source?: ChunkSource,
): string {
  if (source?.path && source.startLine != null && source.endLine != null) {
    return `${source.path}:${source.startLine}-${source.endLine}`;
  }
  if (source?.path && source.startLine != null) {
    return `${source.path}:${source.startLine}`;
  }
  if (source?.path) return source.path;
  if (source?.command) return source.command;

  const firstLine = compactWhitespace(firstMeaningfulLine(text));
  const prefix = kind === "other" ? toolName : `${kind}/${toolName}`;
  return `${prefix}: ${truncateText(firstLine, 100)}`;
}

function shouldTrackTool(toolName: string, trackTools: string[]): boolean {
  if (trackTools.includes("*")) return true;
  return trackTools.includes(toolName) || trackTools.includes(toolName.toLowerCase());
}

function looksLikeDiff(text: string): boolean {
  return (
    /\bdiff --git\b/.test(text) || /^@@\s[-+0-9, ]+@@/m.test(text) || /^[-+]{3}\s[ab]\//m.test(text)
  );
}

function looksLikeTestOutput(text: string): boolean {
  return (
    /\b(npm test|pytest|go test|cargo test|node --test|vitest|jest)\b/i.test(text) ||
    /\b(pass|passed|failing|failed|FAIL|ok\s+\S+)/.test(text)
  );
}

function looksSuccessfulTestOutput(text: string): boolean {
  return /\b(pass|passed|ok\s+\S+|tests\s+\d+)\b/i.test(text) && !hasCurrentFailureSignal(text);
}

function looksLikeSearchOutput(text: string): boolean {
  return /\b(matches|results|found)\b/i.test(text) && /:\d+[:\s]/.test(text);
}

function looksLikeFileRead(
  toolName: string,
  params: Record<string, unknown> | undefined,
  text: string,
): boolean {
  if (stringParam(params, ["path", "file", "filename", "sourcePath"])) return true;
  return /\bread\b/i.test(toolName) || /^[/.\w-]+\/[/.\w-]+:\d+/m.test(text);
}

function hasCurrentFailureSignal(text: string): boolean {
  return /\b(FAIL|FAILED|Traceback|panic:|Exception|SyntaxError|TypeError|ReferenceError|compilation error|Command failed)\b/.test(
    text,
  );
}

function inferLocationFromText(text: string): {
  path?: string;
  startLine?: number;
  endLine?: number;
} {
  const first = firstMeaningfulLine(text);
  const rangeMatch = /([./\w-]+\.[\w-]+):(\d+)(?:-(\d+))?/.exec(first);
  if (rangeMatch) {
    return {
      path: rangeMatch[1],
      startLine: Number(rangeMatch[2]),
      endLine: rangeMatch[3] ? Number(rangeMatch[3]) : Number(rangeMatch[2]),
    };
  }

  const diffMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(first);
  if (diffMatch) return { path: diffMatch[2] };

  return {};
}

function stringParam(
  params: Record<string, unknown> | undefined,
  names: string[],
): string | undefined {
  if (!params) return undefined;
  for (const name of names) {
    const value = params[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function numberParam(
  params: Record<string, unknown> | undefined,
  names: string[],
): number | undefined {
  if (!params) return undefined;
  for (const name of names) {
    const value = params[name];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return undefined;
}
