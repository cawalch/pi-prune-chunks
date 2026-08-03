import type { DiskCacheConfig, PruneChunksConfig } from "./types";

export const DEFAULT_DISK_CACHE_CONFIG: DiskCacheConfig = {
  enabled: true,
  maxBytes: 250 * 1024 * 1024,
  maxAgeDays: 14,
  maxBlobBytes: 25 * 1024 * 1024,
};

export const DEFAULT_CONFIG: PruneChunksConfig = {
  enabled: true,
  trackTools: ["*"],
  track: {
    minChunkTokens: 200,
    maxSummaryChars: 180,
  },
  budget: {
    windowFraction: 0.25,
    minTokens: 8_192,
    maxTokens: 65_536,
    preserveRecentResults: 6,
    preserveRecentMinutes: 3,
  },
  emergency: {
    minResponseHeadroomTokens: 8_192,
    retryAfterGrowthTokens: 2_048,
  },
  redundancy: {
    enabled: true,
    pruneZeroMatchSearches: true,
    pruneReamerxExplorationAfterTerminal: true,
  },
  contextGuards: {
    compactFailedToolValidation: true,
    maxFailedToolValidationChars: 1_200,
  },
  restore: {
    memory: true,
    diskCache: DEFAULT_DISK_CACHE_CONFIG,
    sourceRehydrate: true,
  },
  debug: false,
};

type RawDiskCacheConfig = boolean | Partial<DiskCacheConfig> | undefined;
export type RawPruneChunksConfig = Partial<
  Omit<
    PruneChunksConfig,
    "budget" | "contextGuards" | "emergency" | "redundancy" | "restore" | "track"
  >
> & {
  track?: Partial<PruneChunksConfig["track"]>;
  budget?: Partial<PruneChunksConfig["budget"]>;
  emergency?: Partial<PruneChunksConfig["emergency"]>;
  redundancy?: Partial<PruneChunksConfig["redundancy"]>;
  contextGuards?: Partial<PruneChunksConfig["contextGuards"]>;
  restore?: Partial<Omit<PruneChunksConfig["restore"], "diskCache">> & {
    diskCache?: RawDiskCacheConfig;
  };
  profile?: unknown;
  autoPrune?: unknown;
  decisionCards?: unknown;
  tombstones?: unknown;
  reamerx?: unknown;
};

const LEGACY_KEYS = ["profile", "autoPrune", "decisionCards", "tombstones", "reamerx"] as const;

export function mergeConfig(input?: RawPruneChunksConfig | null): PruneChunksConfig {
  if (!input) return structuredClone(DEFAULT_CONFIG);
  const legacy = LEGACY_KEYS.filter((key) => input[key] !== undefined);
  if (legacy.length > 0) {
    throw new Error(
      `pi-prune-chunks v0.2 no longer supports ${legacy.join(", ")}. ` +
        "Migrate to budget, emergency, redundancy, and restore settings; see README.md.",
    );
  }

  const config: PruneChunksConfig = {
    enabled: input.enabled ?? DEFAULT_CONFIG.enabled,
    trackTools: input.trackTools ?? [...DEFAULT_CONFIG.trackTools],
    track: { ...DEFAULT_CONFIG.track, ...input.track },
    budget: { ...DEFAULT_CONFIG.budget, ...input.budget },
    emergency: { ...DEFAULT_CONFIG.emergency, ...input.emergency },
    redundancy: { ...DEFAULT_CONFIG.redundancy, ...input.redundancy },
    contextGuards: { ...DEFAULT_CONFIG.contextGuards, ...input.contextGuards },
    restore: {
      memory: input.restore?.memory ?? DEFAULT_CONFIG.restore.memory,
      diskCache: mergeDiskCacheConfig(input.restore?.diskCache),
      sourceRehydrate: input.restore?.sourceRehydrate ?? DEFAULT_CONFIG.restore.sourceRehydrate,
    },
    debug: input.debug ?? DEFAULT_CONFIG.debug,
  };
  validateConfig(config);
  return config;
}

function mergeDiskCacheConfig(input: RawDiskCacheConfig): DiskCacheConfig {
  if (typeof input === "boolean") {
    return { ...DEFAULT_DISK_CACHE_CONFIG, enabled: input };
  }
  return { ...DEFAULT_DISK_CACHE_CONFIG, ...input };
}

function validateConfig(config: PruneChunksConfig): void {
  if (!(config.budget.windowFraction > 0 && config.budget.windowFraction <= 1)) {
    throw new Error("pruneChunks.budget.windowFraction must be greater than 0 and at most 1");
  }
  if (config.budget.minTokens < 0 || config.budget.maxTokens < config.budget.minTokens) {
    throw new Error("pruneChunks budget token bounds are invalid");
  }
  if (config.budget.preserveRecentResults < 0 || config.budget.preserveRecentMinutes < 0) {
    throw new Error("pruneChunks budget preservation values cannot be negative");
  }
  if (
    config.emergency.minResponseHeadroomTokens < 0 ||
    config.emergency.retryAfterGrowthTokens < 0
  ) {
    throw new Error("pruneChunks emergency token values cannot be negative");
  }
}
