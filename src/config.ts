import type {
  AutoPrunePolicyMode,
  DiskCacheConfig,
  ModelProfile,
  PruneChunksConfig,
} from "./types";

export const DEFAULT_DISK_CACHE_CONFIG: DiskCacheConfig = {
  enabled: false,
  maxBytes: 250 * 1024 * 1024,
  maxAgeDays: 14,
  maxBlobBytes: 25 * 1024 * 1024,
};

export const DEFAULT_CONFIG: PruneChunksConfig = {
  enabled: true,
  trackTools: ["*"],
  track: {
    minChunkTokens: 200,
  },
  autoPrune: {
    enabled: true,
    policy: "heuristic-v1",
    modelProfile: "auto",
    startAtPercent: 70,
    targetPercent: 55,
    preserveRecentChunks: 5,
    preserveRecentMinutes: 3,
    minChunkTokens: 300,
    maxChunksPerPass: 10,
    pruneSupersededOnIngest: true,
    pruneZeroMatchSearchesOnIngest: true,
  },
  reamerx: {
    pruneExploratoryAfterTerminal: true,
  },
  tombstones: {
    includeSummary: true,
    includeRestoreHint: true,
    maxSummaryChars: 180,
    compactAtPercent: 90,
    coalesceAtPercent: 98,
    maxCoalescedEntries: 120,
  },
  contextGuards: {
    compactFailedToolValidation: true,
    maxFailedToolValidationChars: 1200,
  },
  restore: {
    memory: true,
    diskCache: DEFAULT_DISK_CACHE_CONFIG,
    sourceRehydrate: true,
  },
  debug: false,
};

type RawDiskCacheConfig = boolean | Partial<DiskCacheConfig> | undefined;
type RawPruneChunksConfig = Partial<Omit<PruneChunksConfig, "autoPrune" | "restore">> & {
  autoPrune?: Partial<PruneChunksConfig["autoPrune"]>;
  restore?: Partial<Omit<PruneChunksConfig["restore"], "diskCache">> & {
    diskCache?: RawDiskCacheConfig;
  };
};

export function mergeConfig(input?: RawPruneChunksConfig | null): PruneChunksConfig {
  if (!input) return structuredClone(DEFAULT_CONFIG);

  return {
    enabled: input.enabled ?? DEFAULT_CONFIG.enabled,
    trackTools: input.trackTools ?? DEFAULT_CONFIG.trackTools,
    track: {
      minChunkTokens: input.track?.minChunkTokens ?? DEFAULT_CONFIG.track.minChunkTokens,
    },
    autoPrune: {
      enabled: input.autoPrune?.enabled ?? DEFAULT_CONFIG.autoPrune.enabled,
      policy: normalizePolicy(input.autoPrune?.policy),
      modelProfile: normalizeModelProfile(input.autoPrune?.modelProfile),
      startAtPercent: input.autoPrune?.startAtPercent ?? DEFAULT_CONFIG.autoPrune.startAtPercent,
      targetPercent: input.autoPrune?.targetPercent ?? DEFAULT_CONFIG.autoPrune.targetPercent,
      preserveRecentChunks:
        input.autoPrune?.preserveRecentChunks ?? DEFAULT_CONFIG.autoPrune.preserveRecentChunks,
      preserveRecentMinutes:
        input.autoPrune?.preserveRecentMinutes ?? DEFAULT_CONFIG.autoPrune.preserveRecentMinutes,
      minChunkTokens: input.autoPrune?.minChunkTokens ?? DEFAULT_CONFIG.autoPrune.minChunkTokens,
      maxChunksPerPass:
        input.autoPrune?.maxChunksPerPass ?? DEFAULT_CONFIG.autoPrune.maxChunksPerPass,
      pruneSupersededOnIngest:
        input.autoPrune?.pruneSupersededOnIngest ??
        DEFAULT_CONFIG.autoPrune.pruneSupersededOnIngest,
      pruneZeroMatchSearchesOnIngest:
        input.autoPrune?.pruneZeroMatchSearchesOnIngest ??
        DEFAULT_CONFIG.autoPrune.pruneZeroMatchSearchesOnIngest,
    },
    reamerx: {
      pruneExploratoryAfterTerminal:
        input.reamerx?.pruneExploratoryAfterTerminal ??
        DEFAULT_CONFIG.reamerx.pruneExploratoryAfterTerminal,
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
    contextGuards: {
      compactFailedToolValidation:
        input.contextGuards?.compactFailedToolValidation ??
        DEFAULT_CONFIG.contextGuards.compactFailedToolValidation,
      maxFailedToolValidationChars:
        input.contextGuards?.maxFailedToolValidationChars ??
        DEFAULT_CONFIG.contextGuards.maxFailedToolValidationChars,
    },
    restore: {
      memory: input.restore?.memory ?? DEFAULT_CONFIG.restore.memory,
      diskCache: mergeDiskCacheConfig(input.restore?.diskCache),
      sourceRehydrate: input.restore?.sourceRehydrate ?? DEFAULT_CONFIG.restore.sourceRehydrate,
    },
    debug: input.debug ?? DEFAULT_CONFIG.debug,
  };
}

function normalizePolicy(input: unknown): AutoPrunePolicyMode {
  return input === "adaptive-v1" || input === "heuristic-v1"
    ? input
    : DEFAULT_CONFIG.autoPrune.policy;
}

function normalizeModelProfile(input: unknown): ModelProfile {
  return input === "local-32k" || input === "cloud-1m" || input === "auto"
    ? input
    : DEFAULT_CONFIG.autoPrune.modelProfile;
}

function mergeDiskCacheConfig(input: RawDiskCacheConfig): DiskCacheConfig {
  if (typeof input === "boolean") {
    return { ...DEFAULT_DISK_CACHE_CONFIG, enabled: input };
  }
  if (!input) return { ...DEFAULT_DISK_CACHE_CONFIG };
  return {
    enabled: input.enabled ?? DEFAULT_DISK_CACHE_CONFIG.enabled,
    directory: input.directory ?? DEFAULT_DISK_CACHE_CONFIG.directory,
    maxBytes: input.maxBytes ?? DEFAULT_DISK_CACHE_CONFIG.maxBytes,
    maxAgeDays: input.maxAgeDays ?? DEFAULT_DISK_CACHE_CONFIG.maxAgeDays,
    maxBlobBytes: input.maxBlobBytes ?? DEFAULT_DISK_CACHE_CONFIG.maxBlobBytes,
  };
}
