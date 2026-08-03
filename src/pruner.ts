import { matchingReasoningAnchor } from "./anchors";
import { isReamerxExploratoryTool, isReamerxTerminalTool } from "./collector";
import type { ChunkRegistry } from "./registry";
import type { ContextChunk, ContextUsage, PreserveContext, PruneChunksConfig } from "./types";

export type RetirementCause = "budget" | "emergency" | "redundant" | "manual";

export type RetirementCandidate = {
  id: string;
  label: string;
  kind: string;
  risk: string;
  tokenEstimate: number;
  reason: string;
};

export type RetirementPlan = {
  cause: RetirementCause;
  budgetTokens: number | null;
  activeTokens: number;
  targetSavings: number;
  estimatedSavings: number;
  candidates: RetirementCandidate[];
};

export type EmergencySweepState = {
  registryRevision: number;
  usageTokens: number;
};

export function contextPercent(usage?: ContextUsage | null): number | null {
  if (!usage) return null;
  if (usage.percent != null) return usage.percent;
  if (usage.tokens != null && usage.contextWindow) {
    return (usage.tokens / usage.contextWindow) * 100;
  }
  return null;
}

export function activeToolBudget(
  contextWindow: number | null | undefined,
  config: PruneChunksConfig,
): number {
  if (contextWindow == null) return config.budget.maxTokens;
  const derived = Math.floor(contextWindow * config.budget.windowFraction);
  return clamp(derived, config.budget.minTokens, config.budget.maxTokens);
}

export function redundantRetirements(
  registry: ChunkRegistry,
  current: ContextChunk,
  config: PruneChunksConfig,
): RetirementPlan {
  if (!config.redundancy.enabled) return emptyPlan("redundant", registry);
  const reasons = new Map<string, string>();

  if (
    config.redundancy.pruneZeroMatchSearches &&
    current.risk === "low" &&
    isZeroMatchSearch(current)
  ) {
    reasons.set(current.id, "zero-result search");
  }

  for (const previous of registry.active()) {
    if (previous.id === current.id || previous.parentId) continue;
    if (previous.pinned || previous.risk === "high") continue;
    if (sameContent(previous, current)) {
      reasons.set(previous.id, "exact duplicate superseded by newer output");
      continue;
    }
    if (fullyCoveredFileRead(previous, current)) {
      reasons.set(previous.id, "older file range fully covered by newer read");
      continue;
    }
    if (
      config.redundancy.pruneReamerxExplorationAfterTerminal &&
      current.risk !== "high" &&
      isReamerxTerminalTool(current.toolName) &&
      isReamerxExploratoryTool(previous.toolName) &&
      sameScope(previous, current)
    ) {
      reasons.set(previous.id, `exploration superseded by ${current.toolName}`);
    }
  }

  const candidates = [...reasons].map(([id, reason]) => candidate(registry.get(id)!, reason));
  return {
    cause: "redundant",
    budgetTokens: null,
    activeTokens: registry.summary().activeTokens,
    targetSavings: candidates.reduce((sum, item) => sum + item.tokenEstimate, 0),
    estimatedSavings: candidates.reduce((sum, item) => sum + item.tokenEstimate, 0),
    candidates,
  };
}

export function budgetRetirementPlan(
  registry: ChunkRegistry,
  usage: ContextUsage | null | undefined,
  config: PruneChunksConfig,
  options: { now?: number; preserve?: PreserveContext; limit?: number } = {},
): RetirementPlan {
  const activeTokens = registry.summary().activeTokens;
  const budgetTokens = activeToolBudget(usage?.contextWindow, config);
  const targetSavings = Math.max(0, activeTokens - budgetTokens);
  return buildPlan("budget", registry, config, targetSavings, budgetTokens, options);
}

export function emergencyRetirementPlan(
  registry: ChunkRegistry,
  usage: ContextUsage | null | undefined,
  config: PruneChunksConfig,
  options: { now?: number; preserve?: PreserveContext; limit?: number } = {},
): RetirementPlan {
  const ceiling =
    usage?.contextWindow == null
      ? null
      : Math.max(0, usage.contextWindow - config.emergency.minResponseHeadroomTokens);
  const targetSavings =
    ceiling == null || usage?.tokens == null ? 0 : Math.max(0, usage.tokens - ceiling);
  return buildPlan("emergency", registry, config, targetSavings, null, options);
}

export function manualRetirementPlan(
  registry: ChunkRegistry,
  config: PruneChunksConfig,
  options: { now?: number; preserve?: PreserveContext; limit?: number } = {},
): RetirementPlan {
  return buildPlan("manual", registry, config, Number.POSITIVE_INFINITY, null, options);
}

export function shouldRunEmergencySweep(
  usage: ContextUsage | null | undefined,
  config: PruneChunksConfig,
  registryRevision: number,
  previous?: EmergencySweepState,
): boolean {
  if (usage?.tokens == null || usage.contextWindow == null) return false;
  const ceiling = Math.max(0, usage.contextWindow - config.emergency.minResponseHeadroomTokens);
  if (usage.tokens <= ceiling) return false;
  if (!previous) return true;
  if (previous.registryRevision !== registryRevision) return true;
  return usage.tokens >= previous.usageTokens + config.emergency.retryAfterGrowthTokens;
}

export function isFailureLike(chunk: ContextChunk): boolean {
  if (chunk.kind !== "test_output") return false;
  if (chunk.risk === "high") return true;
  return /\b(FAIL|failed|error|AssertionError|Traceback|panic:)\b/i.test(
    `${chunk.label}\n${chunk.summary ?? ""}`,
  );
}

function buildPlan(
  cause: RetirementCause,
  registry: ChunkRegistry,
  config: PruneChunksConfig,
  targetSavings: number,
  budgetTokens: number | null,
  options: { now?: number; preserve?: PreserveContext; limit?: number },
): RetirementPlan {
  const activeTokens = registry.summary().activeTokens;
  if (targetSavings <= 0) {
    return {
      cause,
      budgetTokens,
      activeTokens,
      targetSavings: 0,
      estimatedSavings: 0,
      candidates: [],
    };
  }

  const eligible = eligibleCandidates(
    registry,
    config,
    options.now ?? Date.now(),
    options.preserve,
  );
  const selected: RetirementCandidate[] = [];
  let estimatedSavings = 0;
  const limit = Math.max(0, options.limit ?? Number.POSITIVE_INFINITY);
  for (const item of eligible) {
    if (selected.length >= limit) break;
    selected.push(item);
    estimatedSavings += item.tokenEstimate;
    if (estimatedSavings >= targetSavings) break;
  }
  return {
    cause,
    budgetTokens,
    activeTokens,
    targetSavings,
    estimatedSavings,
    candidates: selected,
  };
}

function eligibleCandidates(
  registry: ChunkRegistry,
  config: PruneChunksConfig,
  now: number,
  preserve?: PreserveContext,
): RetirementCandidate[] {
  const active = registry.active();
  const recentFamilies = recentFamilyIds(active, config.budget.preserveRecentResults);
  const preserveMs = config.budget.preserveRecentMinutes * 60_000;
  const activeChildren = new Set(
    active.filter((chunk) => chunk.parentId).map((chunk) => chunk.parentId as string),
  );
  const eligible: RetirementCandidate[] = [];

  for (const chunk of active) {
    if (!chunk.parentId && activeChildren.has(chunk.id)) continue;
    if (chunk.pinned || chunk.risk !== "low" || chunk.lastSeenAt == null) continue;
    if (chunk.kind === "diff" || isFailureLike(chunk)) continue;
    if (recentFamilies.has(chunk.id) || (chunk.parentId && recentFamilies.has(chunk.parentId)))
      continue;
    if (preserveMs > 0 && now - chunk.createdAt < preserveMs) continue;
    if (chunk.lastRestoredAt != null && now - chunk.lastRestoredAt < preserveMs) continue;
    if (preserve?.ids?.has(chunk.id) || (chunk.parentId && preserve?.ids?.has(chunk.parentId)))
      continue;
    if (isPathPreserved(chunk, preserve?.paths)) continue;
    if (matchingReasoningAnchor(chunk, preserve?.anchors, registry.getContent(chunk.id))) continue;
    eligible.push(
      candidate(chunk, chunk.part ? "old low-risk bulk output" : "old low-risk output"),
    );
  }

  eligible.sort(
    (a, b) =>
      (registry.get(a.id)?.createdAt ?? 0) - (registry.get(b.id)?.createdAt ?? 0) ||
      b.tokenEstimate - a.tokenEstimate,
  );
  return eligible;
}

function recentFamilyIds(chunks: ContextChunk[], count: number): Set<string> {
  if (count <= 0) return new Set();
  const parents = chunks
    .map((chunk, insertionIndex) => ({ chunk, insertionIndex }))
    .filter(({ chunk }) => !chunk.parentId)
    .sort((a, b) => b.chunk.createdAt - a.chunk.createdAt || b.insertionIndex - a.insertionIndex)
    .slice(0, count)
    .map(({ chunk }) => chunk.id);
  return new Set(parents);
}

function isPathPreserved(chunk: ContextChunk, paths: Set<string> | undefined): boolean {
  if (!chunk.source?.path || !paths?.size) return false;
  const chunkPath = normalizePath(chunk.source.path);
  for (const path of paths) {
    const normalized = normalizePath(path);
    if (
      chunkPath === normalized ||
      chunkPath.endsWith(`/${normalized}`) ||
      normalized.endsWith(`/${chunkPath}`)
    ) {
      return true;
    }
  }
  return false;
}

function sameContent(previous: ContextChunk, current: ContextChunk): boolean {
  return (
    previous.kind === current.kind &&
    !!previous.source?.contentHash &&
    previous.source.contentHash === current.source?.contentHash
  );
}

function fullyCoveredFileRead(previous: ContextChunk, current: ContextChunk): boolean {
  if (previous.kind !== "file_read" || current.kind !== "file_read") return false;
  if (current.risk === "high") return false;
  if (!samePath(previous, current)) return false;
  if (
    previous.source?.startLine == null ||
    previous.source.endLine == null ||
    current.source?.startLine == null ||
    current.source.endLine == null
  ) {
    return false;
  }
  return (
    current.source.startLine <= previous.source.startLine &&
    current.source.endLine >= previous.source.endLine
  );
}

function samePath(previous: ContextChunk, current: ContextChunk): boolean {
  return (
    !!previous.source?.path &&
    !!current.source?.path &&
    normalizePath(previous.source.path) === normalizePath(current.source.path)
  );
}

function sameScope(previous: ContextChunk, current: ContextChunk): boolean {
  return (
    (previous.scope?.scope ?? "main") === (current.scope?.scope ?? "main") &&
    (previous.scope?.runId ?? "") === (current.scope?.runId ?? "")
  );
}

function isZeroMatchSearch(chunk: ContextChunk): boolean {
  if (chunk.kind !== "search") return false;
  return /(?:\b0\s+(?:exact\s+)?(?:matches|results|hits)\b|\bno\s+(?:matches|results|hits)(?:\s+found)?\b)/i.test(
    `${chunk.label}\n${chunk.summary ?? ""}`,
  );
}

function candidate(chunk: ContextChunk, reason: string): RetirementCandidate {
  return {
    id: chunk.id,
    label: chunk.label,
    kind: chunk.kind,
    risk: chunk.risk,
    tokenEstimate: chunk.tokenEstimate,
    reason,
  };
}

function emptyPlan(cause: RetirementCause, registry: ChunkRegistry): RetirementPlan {
  return {
    cause,
    budgetTokens: null,
    activeTokens: registry.summary().activeTokens,
    targetSavings: 0,
    estimatedSavings: 0,
    candidates: [],
  };
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
