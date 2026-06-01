import type { PruneChunksConfig } from "./types";

export const DEFAULT_CONFIG: PruneChunksConfig = {
  enabled: true,
  trackTools: ["*"],
  track: {
    minChunkTokens: 200,
  },
  autoPrune: {
    enabled: true,
    startAtPercent: 70,
    targetPercent: 55,
    preserveRecentChunks: 5,
    preserveRecentMinutes: 3,
    minChunkTokens: 300,
    maxChunksPerPass: 10,
  },
  tombstones: {
    includeSummary: true,
    includeRestoreHint: true,
    maxSummaryChars: 180,
    compactAtPercent: 90,
    coalesceAtPercent: 98,
    maxCoalescedEntries: 120,
  },
  restore: {
    memory: true,
    diskCache: false,
    sourceRehydrate: true,
  },
  debug: false,
};

export function mergeConfig(input?: Partial<PruneChunksConfig> | null): PruneChunksConfig {
  if (!input) return structuredClone(DEFAULT_CONFIG);

  return {
    enabled: input.enabled ?? DEFAULT_CONFIG.enabled,
    trackTools: input.trackTools ?? DEFAULT_CONFIG.trackTools,
    track: {
      minChunkTokens: input.track?.minChunkTokens ?? DEFAULT_CONFIG.track.minChunkTokens,
    },
    autoPrune: {
      enabled: input.autoPrune?.enabled ?? DEFAULT_CONFIG.autoPrune.enabled,
      startAtPercent: input.autoPrune?.startAtPercent ?? DEFAULT_CONFIG.autoPrune.startAtPercent,
      targetPercent: input.autoPrune?.targetPercent ?? DEFAULT_CONFIG.autoPrune.targetPercent,
      preserveRecentChunks:
        input.autoPrune?.preserveRecentChunks ?? DEFAULT_CONFIG.autoPrune.preserveRecentChunks,
      preserveRecentMinutes:
        input.autoPrune?.preserveRecentMinutes ?? DEFAULT_CONFIG.autoPrune.preserveRecentMinutes,
      minChunkTokens: input.autoPrune?.minChunkTokens ?? DEFAULT_CONFIG.autoPrune.minChunkTokens,
      maxChunksPerPass:
        input.autoPrune?.maxChunksPerPass ?? DEFAULT_CONFIG.autoPrune.maxChunksPerPass,
    },
    tombstones: {
      includeSummary: input.tombstones?.includeSummary ?? DEFAULT_CONFIG.tombstones.includeSummary,
      includeRestoreHint:
        input.tombstones?.includeRestoreHint ?? DEFAULT_CONFIG.tombstones.includeRestoreHint,
      maxSummaryChars:
        input.tombstones?.maxSummaryChars ?? DEFAULT_CONFIG.tombstones.maxSummaryChars,
      compactAtPercent:
        input.tombstones?.compactAtPercent ?? DEFAULT_CONFIG.tombstones.compactAtPercent,
      coalesceAtPercent:
        input.tombstones?.coalesceAtPercent ?? DEFAULT_CONFIG.tombstones.coalesceAtPercent,
      maxCoalescedEntries:
        input.tombstones?.maxCoalescedEntries ?? DEFAULT_CONFIG.tombstones.maxCoalescedEntries,
    },
    restore: {
      memory: input.restore?.memory ?? DEFAULT_CONFIG.restore.memory,
      diskCache: input.restore?.diskCache ?? DEFAULT_CONFIG.restore.diskCache,
      sourceRehydrate: input.restore?.sourceRehydrate ?? DEFAULT_CONFIG.restore.sourceRehydrate,
    },
    debug: input.debug ?? DEFAULT_CONFIG.debug,
  };
}
