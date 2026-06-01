import type { ChunkRegistry } from "./registry";
import type { ChunkActionResult, ContextChunk, ContextUsage, PruneChunksConfig } from "./types";

export type PruneCandidate = {
  id: string;
  label: string;
  kind: string;
  risk: string;
  tokenEstimate: number;
  score: number;
  reasons: string[];
};

export type AutoPruneResult = {
  triggered: boolean;
  pruned: ChunkActionResult[];
  savedTokens: number;
  reason?: string;
};

export function contextPercent(usage?: ContextUsage | null): number | null {
  if (!usage) return null;
  if (usage.percent != null) return usage.percent;
  if (usage.tokens != null && usage.contextWindow) {
    return (usage.tokens / usage.contextWindow) * 100;
  }
  return null;
}

export function suggestPruneCandidates(
  registry: ChunkRegistry,
  config: PruneChunksConfig,
  options: {
    now?: number;
    limit?: number;
    preserveIds?: Set<string>;
    pressurePercent?: number | null;
  } = {},
): PruneCandidate[] {
  const now = options.now ?? Date.now();
  const recentProtected = recentChunkIds(registry.active(), config.autoPrune.preserveRecentChunks);
  const candidates: PruneCandidate[] = [];

  for (const chunk of registry.active()) {
    const blockedReason = autoPruneBlockedReason(
      chunk,
      config,
      now,
      recentProtected,
      options.preserveIds,
      options.pressurePercent,
    );
    if (blockedReason) continue;
    candidates.push(scoreCandidate(chunk, now));
  }

  candidates.sort((a, b) => b.score - a.score || b.tokenEstimate - a.tokenEstimate);
  return candidates.slice(0, Math.max(0, options.limit ?? config.autoPrune.maxChunksPerPass));
}

export function autoPrune(
  registry: ChunkRegistry,
  usage: ContextUsage | null | undefined,
  config: PruneChunksConfig,
  options: { now?: number; preserveIds?: Set<string> } = {},
): AutoPruneResult {
  if (!config.autoPrune.enabled) return { triggered: false, pruned: [], savedTokens: 0 };

  const pct = contextPercent(usage);
  if (pct == null || pct < config.autoPrune.startAtPercent) {
    return { triggered: false, pruned: [], savedTokens: 0 };
  }
  if (usage?.tokens == null || !usage.contextWindow) {
    return { triggered: false, pruned: [], savedTokens: 0 };
  }

  const targetTokens = Math.floor(usage.contextWindow * (config.autoPrune.targetPercent / 100));
  const targetSavings = Math.max(0, usage.tokens - targetTokens);
  if (targetSavings <= 0) return { triggered: false, pruned: [], savedTokens: 0 };

  const candidates = suggestPruneCandidates(registry, config, {
    now: options.now,
    limit: config.autoPrune.maxChunksPerPass,
    preserveIds: options.preserveIds,
    pressurePercent: pct,
  });

  const ids: string[] = [];
  let estimatedSavings = 0;
  for (const candidate of candidates) {
    ids.push(candidate.id);
    estimatedSavings += candidate.tokenEstimate;
    if (estimatedSavings >= targetSavings) break;
  }

  if (ids.length === 0) {
    return {
      triggered: true,
      pruned: [],
      savedTokens: 0,
      reason: `context at ${Math.round(pct)}%, no safe auto-prune candidates`,
    };
  }

  const reason = `auto-prune: context at ${Math.round(pct)}%, target ${config.autoPrune.targetPercent}%`;
  const pruned = registry.prune(ids, reason, "auto_pruned");
  return {
    triggered: true,
    pruned,
    savedTokens: pruned.reduce((sum, result) => sum + result.tokens, 0),
    reason,
  };
}

export function pressureSummary(
  registry: ChunkRegistry,
  usage: ContextUsage | null | undefined,
  config: PruneChunksConfig,
): {
  estimatedActiveChunkTokens: number;
  estimatedPrunedTokens: number;
  largestUnprunedChunks: PruneCandidate[];
  autoPrune: {
    enabled: boolean;
    currentPercent: number | null;
    startAtPercent: number;
    targetPercent: number;
    minChunkTokens: number;
    maxChunksPerPass: number;
  };
  recommendedCandidates: PruneCandidate[];
} {
  const summary = registry.summary();
  return {
    estimatedActiveChunkTokens: summary.activeTokens,
    estimatedPrunedTokens: summary.prunedTokens,
    largestUnprunedChunks: registry
      .list({ pruned: false, sortBy: "tokens", limit: 5 })
      .chunks.map((chunk) => ({
        id: chunk.id,
        label: chunk.label,
        kind: chunk.kind,
        risk: chunk.risk,
        tokenEstimate: chunk.tokenEstimate,
        score: chunk.tokenEstimate,
        reasons: ["largest active chunk"],
      })),
    autoPrune: {
      enabled: config.autoPrune.enabled,
      currentPercent: contextPercent(usage),
      startAtPercent: config.autoPrune.startAtPercent,
      targetPercent: config.autoPrune.targetPercent,
      minChunkTokens: config.autoPrune.minChunkTokens,
      maxChunksPerPass: config.autoPrune.maxChunksPerPass,
    },
    recommendedCandidates: suggestPruneCandidates(registry, config, {
      limit: 10,
      pressurePercent: contextPercent(usage),
    }),
  };
}

function autoPruneBlockedReason(
  chunk: ContextChunk,
  config: PruneChunksConfig,
  now: number,
  recentProtected: Set<string>,
  preserveIds?: Set<string>,
  pressurePercent?: number | null,
): string | null {
  const relaxedForPressure =
    pressurePercent != null && pressurePercent >= config.autoPrune.startAtPercent + 5;
  const minChunkTokens = relaxedForPressure
    ? Math.min(config.autoPrune.minChunkTokens, config.track.minChunkTokens)
    : config.autoPrune.minChunkTokens;

  if (chunk.pruned) return "already pruned";
  if (chunk.pinned) return "pinned";
  if (chunk.risk === "high") return "high risk";
  if (
    chunk.kind === "file_read" &&
    chunk.risk === "medium" &&
    (pressurePercent == null || pressurePercent < config.autoPrune.startAtPercent + 15)
  ) {
    return "unbounded file read below high-pressure threshold";
  }
  if (chunk.tokenEstimate < minChunkTokens) return "below token floor";
  if (recentProtected.has(chunk.id)) return "recent protected chunk";
  if (preserveIds?.has(chunk.id)) return "referenced by latest assistant message";
  const preserveMs = config.autoPrune.preserveRecentMinutes * 60 * 1000;
  if (!relaxedForPressure && now - chunk.createdAt < preserveMs) return "created recently";
  if (chunk.lastRestoredAt != null && now - chunk.lastRestoredAt < preserveMs) {
    return "restored recently";
  }
  return null;
}

function scoreCandidate(chunk: ContextChunk, now: number): PruneCandidate {
  const ageMinutes = Math.max(0, (now - chunk.createdAt) / 60_000);
  const reasons: string[] = [];
  let score = chunk.tokenEstimate;

  if (chunk.restoreAvailable) {
    score += 300;
    reasons.push("restorable");
  }
  if (chunk.risk === "low") {
    score += 250;
    reasons.push("low risk");
  }
  if (["search", "flow_trace", "outline", "symbol"].includes(chunk.kind)) {
    score += 200;
    reasons.push("stale exploration");
  }
  if (chunk.kind === "test_output" && chunk.risk === "low") {
    score += 150;
    reasons.push("successful test output");
  }
  if (ageMinutes >= 30) {
    score += 300;
    reasons.push("old");
  } else if (ageMinutes >= 10) {
    score += 100;
    reasons.push("not recent");
  }

  return {
    id: chunk.id,
    label: chunk.label,
    kind: chunk.kind,
    risk: chunk.risk,
    tokenEstimate: chunk.tokenEstimate,
    score,
    reasons,
  };
}

function recentChunkIds(chunks: ContextChunk[], count: number): Set<string> {
  if (count <= 0) return new Set();
  return new Set(
    [...chunks]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, count)
      .map((chunk) => chunk.id),
  );
}
