import { matchingReasoningAnchor } from "./anchors";
import { isReamerxExploratoryTool, isReamerxTerminalTool } from "./collector";
import type { ChunkRegistry } from "./registry";
import type { ContextChunk, ContextUsage, PreserveContext, PruneChunksConfig } from "./types";

export type RetirementCause = "working_set" | "pressure" | "manual";

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
  targetTokens: number | null;
  activeTokens: number;
  targetSavings: number;
  estimatedSavings: number;
  candidates: RetirementCandidate[];
};

export type PressureSweepState = {
  usageTokens: number;
};

export type WorkingSetSweepState = {
  activeTokens: number;
};

export function contextPercent(usage?: ContextUsage | null): number | null {
  if (!usage) return null;
  if (usage.percent != null) return usage.percent;
  if (usage.tokens != null && usage.contextWindow) {
    return (usage.tokens / usage.contextWindow) * 100;
  }
  return null;
}

export function pressureRetirementPlan(
  registry: ChunkRegistry,
  usage: ContextUsage | null | undefined,
  config: PruneChunksConfig,
  options: { now?: number; preserve?: PreserveContext; limit?: number } = {},
): RetirementPlan {
  const targetTokens =
    usage?.contextWindow == null
      ? null
      : Math.floor((usage.contextWindow * config.pressure.targetPercent) / 100);
  const targetSavings =
    targetTokens == null || usage?.tokens == null ? 0 : Math.max(0, usage.tokens - targetTokens);
  return buildPlan("pressure", registry, config, targetSavings, targetTokens, options);
}

export function workingSetRetirementPlan(
  registry: ChunkRegistry,
  config: PruneChunksConfig,
  options: { now?: number; preserve?: PreserveContext; limit?: number } = {},
): RetirementPlan {
  const activeTokens = registry.summary().activeTokens;
  const targetSavings = Math.max(0, activeTokens - config.workingSet.targetTokens);
  return buildPlan(
    "working_set",
    registry,
    config,
    targetSavings,
    config.workingSet.targetTokens,
    options,
  );
}

export function manualRetirementPlan(
  registry: ChunkRegistry,
  config: PruneChunksConfig,
  options: { now?: number; preserve?: PreserveContext; limit?: number } = {},
): RetirementPlan {
  return buildPlan("manual", registry, config, Number.POSITIVE_INFINITY, null, options);
}

export function shouldRunPressureSweep(
  usage: ContextUsage | null | undefined,
  config: PruneChunksConfig,
  previous?: PressureSweepState,
): boolean {
  if (usage?.tokens == null || usage.contextWindow == null) return false;
  if ((usage.tokens / usage.contextWindow) * 100 < config.pressure.triggerPercent) return false;
  if (!previous) return true;
  return usage.tokens >= previous.usageTokens + config.pressure.retryAfterGrowthTokens;
}

export function shouldRunWorkingSetSweep(
  activeTokens: number,
  config: PruneChunksConfig,
  previous?: WorkingSetSweepState,
): boolean {
  if (activeTokens < config.workingSet.triggerTokens) return false;
  if (!previous) return true;
  return activeTokens >= previous.activeTokens + config.workingSet.retryAfterGrowthTokens;
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
  targetTokens: number | null,
  options: { now?: number; preserve?: PreserveContext; limit?: number },
): RetirementPlan {
  const activeTokens = registry.summary().activeTokens;
  if (targetSavings <= 0) {
    return {
      cause,
      targetTokens,
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
    targetTokens,
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
  const recentFamilies = recentFamilyIds(active, config.retention.preserveRecentResults);
  const preserveMs = config.retention.preserveRecentMinutes * 60_000;
  const activeChildren = new Set(
    active.filter((chunk) => chunk.parentId).map((chunk) => chunk.parentId as string),
  );
  const eligible: RetirementCandidate[] = [];

  for (const [index, chunk] of active.entries()) {
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
    const evidence = chunk.parentId ? undefined : staleEvidence(chunk, index, active);
    eligible.push(
      candidate(
        chunk,
        evidence ?? (chunk.part ? "old low-risk bulk output" : "old low-risk output"),
      ),
    );
  }

  eligible.sort(
    (a, b) =>
      evidenceRank(a.reason) - evidenceRank(b.reason) ||
      (registry.get(a.id)?.createdAt ?? 0) - (registry.get(b.id)?.createdAt ?? 0) ||
      b.tokenEstimate - a.tokenEstimate,
  );
  return eligible;
}

function staleEvidence(
  previous: ContextChunk,
  previousIndex: number,
  active: ContextChunk[],
): string | undefined {
  if (isZeroMatchSearch(previous)) return "zero-result search";
  for (let index = previousIndex + 1; index < active.length; index++) {
    const current = active[index];
    if (current.parentId) continue;
    if (sameContent(previous, current)) return "exact duplicate superseded by newer output";
    if (fullyCoveredFileRead(previous, current)) {
      return "older file range fully covered by newer read";
    }
    if (
      current.risk !== "high" &&
      isReamerxTerminalTool(current.toolName) &&
      isReamerxExploratoryTool(previous.toolName) &&
      sameScope(previous, current)
    ) {
      return `exploration superseded by ${current.toolName}`;
    }
  }
  return undefined;
}

function evidenceRank(reason: string): number {
  return reason === "old low-risk output" || reason === "old low-risk bulk output" ? 1 : 0;
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
  if (current.risk === "high" || !samePath(previous, current)) return false;
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

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}
