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
  pressure: {
    triggerPercent: 90,
    targetPercent: 80,
    retryAfterGrowthTokens: 8_192,
    preserveRecentResults: 6,
    preserveRecentMinutes: 3,
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
  Omit<PruneChunksConfig, "contextGuards" | "pressure" | "restore" | "track">
> & {
  track?: Partial<PruneChunksConfig["track"]>;
  pressure?: Partial<PruneChunksConfig["pressure"]>;
  contextGuards?: Partial<PruneChunksConfig["contextGuards"]>;
  restore?: Partial<Omit<PruneChunksConfig["restore"], "diskCache">> & {
    diskCache?: RawDiskCacheConfig;
  };
  profile?: unknown;
  autoPrune?: unknown;
  decisionCards?: unknown;
  tombstones?: unknown;
  reamerx?: unknown;
  budget?: unknown;
  emergency?: unknown;
  redundancy?: unknown;
};

const LEGACY_KEYS = [
  "profile",
  "autoPrune",
  "decisionCards",
  "tombstones",
  "reamerx",
  "budget",
  "emergency",
  "redundancy",
] as const;

export function mergeConfig(input?: RawPruneChunksConfig | null): PruneChunksConfig {
  if (!input) return structuredClone(DEFAULT_CONFIG);
  const legacy = LEGACY_KEYS.filter((key) => input[key] !== undefined);
  if (legacy.length > 0) {
    throw new Error(
      `pi-prune-chunks v0.3 no longer supports ${legacy.join(", ")}. ` +
        "Remove the old policy and configure pressure and restore settings; see README.md.",
    );
  }

  const config: PruneChunksConfig = {
    enabled: input.enabled ?? DEFAULT_CONFIG.enabled,
    trackTools: input.trackTools ?? [...DEFAULT_CONFIG.trackTools],
    track: { ...DEFAULT_CONFIG.track, ...input.track },
    pressure: { ...DEFAULT_CONFIG.pressure, ...input.pressure },
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
  if (
    !(config.pressure.targetPercent > 0) ||
    !(config.pressure.triggerPercent > config.pressure.targetPercent) ||
    config.pressure.triggerPercent > 100
  ) {
    throw new Error(
      "pruneChunks pressure percentages must satisfy 0 < targetPercent < triggerPercent <= 100",
    );
  }
  if (
    config.pressure.retryAfterGrowthTokens < 0 ||
    config.pressure.preserveRecentResults < 0 ||
    config.pressure.preserveRecentMinutes < 0
  ) {
    throw new Error("pruneChunks pressure retry and preservation values cannot be negative");
  }
}
