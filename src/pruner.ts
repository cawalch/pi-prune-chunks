import { matchingReasoningAnchor } from "./anchors";
import type { ChunkRegistry } from "./registry";
import type { ContextChunk, ContextUsage, PreserveContext, PruneChunksConfig } from "./types";

export type RetirementCause = "pressure" | "manual";

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
  const recentFamilies = recentFamilyIds(active, config.pressure.preserveRecentResults);
  const preserveMs = config.pressure.preserveRecentMinutes * 60_000;
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
