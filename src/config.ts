import type {
  AutoPrunePolicyMode,
  DiskCacheConfig,
  ModelProfile,
  PolicyProfileName,
  PruneChunksConfig,
} from "./types";

export const DEFAULT_DISK_CACHE_CONFIG: DiskCacheConfig = {
  enabled: true,
  maxBytes: 250 * 1024 * 1024,
  maxAgeDays: 14,
  maxBlobBytes: 25 * 1024 * 1024,
};

export const DEFAULT_CONFIG: PruneChunksConfig = {
  profile: "coding-heavy",
  enabled: true,
  trackTools: ["*"],
  track: {
    minChunkTokens: 200,
  },
  autoPrune: {
    enabled: true,
    policy: "adaptive-v1",
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
  decisionCards: {
    mode: "heuristic",
    maxModelInputTokens: 1200,
    maxModelOutputChars: 800,
  },
  tombstones: {
    includeSummary: true,
    includeRestoreHint: true,
    maxSummaryChars: 180,
    compactAtPercent: 90,
    coalesceAtPercent: 98,
    coalesceMinChunks: 16,
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
type RawPruneChunksConfig = Partial<
  Omit<
    PruneChunksConfig,
    | "autoPrune"
    | "contextGuards"
    | "decisionCards"
    | "profile"
    | "reamerx"
    | "restore"
    | "tombstones"
    | "track"
  >
> & {
  profile?: PolicyProfileName;
  track?: Partial<PruneChunksConfig["track"]>;
  autoPrune?: Partial<PruneChunksConfig["autoPrune"]>;
  reamerx?: Partial<PruneChunksConfig["reamerx"]>;
  decisionCards?: Partial<PruneChunksConfig["decisionCards"]>;
  tombstones?: Partial<PruneChunksConfig["tombstones"]>;
  contextGuards?: Partial<PruneChunksConfig["contextGuards"]>;
  restore?: Partial<Omit<PruneChunksConfig["restore"], "diskCache">> & {
    diskCache?: RawDiskCacheConfig;
  };
};

export const POLICY_PROFILE_NAMES: PolicyProfileName[] = [
  "local-32k",
  "local-64k",
  "cloud-200k",
  "cloud-1m",
  "privacy-max",
  "research-heavy",
  "coding-heavy",
  "debug-failures",
];

export const POLICY_PROFILES: Record<
  PolicyProfileName,
  Partial<Omit<PruneChunksConfig, "profile">>
> = {
  "local-32k": {
    track: { minChunkTokens: 150 },
    autoPrune: {
      ...DEFAULT_CONFIG.autoPrune,
      modelProfile: "local-32k",
      startAtPercent: 55,
      targetPercent: 40,
      preserveRecentChunks: 2,
      preserveRecentMinutes: 1,
      minChunkTokens: 150,
      maxChunksPerPass: 16,
    },
    tombstones: {
      ...DEFAULT_CONFIG.tombstones,
      maxSummaryChars: 120,
      compactAtPercent: 80,
      coalesceAtPercent: 92,
      coalesceMinChunks: 8,
    },
  },
  "local-64k": {
    track: { minChunkTokens: 180 },
    autoPrune: {
      ...DEFAULT_CONFIG.autoPrune,
      modelProfile: "local-64k",
      startAtPercent: 65,
      targetPercent: 50,
      preserveRecentChunks: 3,
      preserveRecentMinutes: 2,
      minChunkTokens: 200,
      maxChunksPerPass: 12,
    },
    tombstones: {
      ...DEFAULT_CONFIG.tombstones,
      maxSummaryChars: 150,
      compactAtPercent: 86,
      coalesceAtPercent: 96,
      coalesceMinChunks: 12,
    },
  },
  "cloud-200k": {
    autoPrune: {
      ...DEFAULT_CONFIG.autoPrune,
      modelProfile: "cloud-200k",
      startAtPercent: 75,
      targetPercent: 62,
      preserveRecentChunks: 8,
      preserveRecentMinutes: 5,
      minChunkTokens: 500,
      maxChunksPerPass: 8,
    },
    tombstones: {
      ...DEFAULT_CONFIG.tombstones,
      maxSummaryChars: 220,
      compactAtPercent: 92,
      coalesceMinChunks: 24,
    },
  },
  "cloud-1m": {
    autoPrune: {
      ...DEFAULT_CONFIG.autoPrune,
      modelProfile: "cloud-1m",
      startAtPercent: 82,
      targetPercent: 70,
      preserveRecentChunks: 12,
      preserveRecentMinutes: 8,
      minChunkTokens: 800,
      maxChunksPerPass: 6,
    },
    tombstones: {
      ...DEFAULT_CONFIG.tombstones,
      maxSummaryChars: 280,
      compactAtPercent: 95,
      coalesceAtPercent: 99,
    },
  },
  "privacy-max": {
    track: { minChunkTokens: 300 },
    autoPrune: {
      ...DEFAULT_CONFIG.autoPrune,
      startAtPercent: 60,
      targetPercent: 45,
      preserveRecentChunks: 2,
      preserveRecentMinutes: 1,
      minChunkTokens: 300,
    },
    tombstones: {
      ...DEFAULT_CONFIG.tombstones,
      includeSummary: false,
      maxSummaryChars: 80,
      compactAtPercent: 82,
      coalesceMinChunks: 8,
    },
    restore: {
      ...DEFAULT_CONFIG.restore,
      diskCache: { ...DEFAULT_DISK_CACHE_CONFIG, enabled: false },
    },
  },
  "research-heavy": {
    decisionCards: {
      mode: "model-assisted",
      maxModelInputTokens: 1800,
      maxModelOutputChars: 1200,
    },
    autoPrune: {
      ...DEFAULT_CONFIG.autoPrune,
      startAtPercent: 78,
      targetPercent: 62,
      preserveRecentChunks: 10,
      preserveRecentMinutes: 8,
      minChunkTokens: 500,
      maxChunksPerPass: 8,
    },
    tombstones: {
      ...DEFAULT_CONFIG.tombstones,
      maxSummaryChars: 320,
      compactAtPercent: 94,
      coalesceMinChunks: 24,
    },
  },
  "coding-heavy": {},
  "debug-failures": {
    autoPrune: {
      ...DEFAULT_CONFIG.autoPrune,
      startAtPercent: 75,
      targetPercent: 60,
      preserveRecentChunks: 8,
      preserveRecentMinutes: 10,
      maxChunksPerPass: 6,
    },
    tombstones: { ...DEFAULT_CONFIG.tombstones, maxSummaryChars: 240, coalesceMinChunks: 24 },
  },
};

export function mergeConfig(input?: RawPruneChunksConfig | null): PruneChunksConfig {
  const profile = normalizeProfile(input?.profile);
  const base = applyProfile(DEFAULT_CONFIG, profile);
  if (!input) return base;

  return mergeWithBase(input, base, profile);
}

function mergeWithBase(
  input: RawPruneChunksConfig,
  base: PruneChunksConfig,
  profile: PolicyProfileName,
): PruneChunksConfig {
  return {
    profile,
    enabled: input.enabled ?? base.enabled,
    trackTools: input.trackTools ?? base.trackTools,
    track: {
      minChunkTokens: input.track?.minChunkTokens ?? base.track.minChunkTokens,
    },
    autoPrune: {
      enabled: input.autoPrune?.enabled ?? base.autoPrune.enabled,
      policy: normalizePolicy(input.autoPrune?.policy, base.autoPrune.policy),
      modelProfile: normalizeModelProfile(
        input.autoPrune?.modelProfile,
        base.autoPrune.modelProfile,
      ),
      startAtPercent: input.autoPrune?.startAtPercent ?? base.autoPrune.startAtPercent,
      targetPercent: input.autoPrune?.targetPercent ?? base.autoPrune.targetPercent,
      preserveRecentChunks:
        input.autoPrune?.preserveRecentChunks ?? base.autoPrune.preserveRecentChunks,
      preserveRecentMinutes:
        input.autoPrune?.preserveRecentMinutes ?? base.autoPrune.preserveRecentMinutes,
      minChunkTokens: input.autoPrune?.minChunkTokens ?? base.autoPrune.minChunkTokens,
      maxChunksPerPass: input.autoPrune?.maxChunksPerPass ?? base.autoPrune.maxChunksPerPass,
      pruneSupersededOnIngest:
        input.autoPrune?.pruneSupersededOnIngest ?? base.autoPrune.pruneSupersededOnIngest,
      pruneZeroMatchSearchesOnIngest:
        input.autoPrune?.pruneZeroMatchSearchesOnIngest ??
        base.autoPrune.pruneZeroMatchSearchesOnIngest,
    },
    reamerx: {
      pruneExploratoryAfterTerminal:
        input.reamerx?.pruneExploratoryAfterTerminal ?? base.reamerx.pruneExploratoryAfterTerminal,
    },
    decisionCards: {
      mode:
        input.decisionCards?.mode === "model-assisted" ? "model-assisted" : base.decisionCards.mode,
      maxModelInputTokens:
        input.decisionCards?.maxModelInputTokens ?? base.decisionCards.maxModelInputTokens,
      maxModelOutputChars:
        input.decisionCards?.maxModelOutputChars ?? base.decisionCards.maxModelOutputChars,
    },
    tombstones: {
      includeSummary: input.tombstones?.includeSummary ?? base.tombstones.includeSummary,
      includeRestoreHint:
        input.tombstones?.includeRestoreHint ?? base.tombstones.includeRestoreHint,
      maxSummaryChars: input.tombstones?.maxSummaryChars ?? base.tombstones.maxSummaryChars,
      compactAtPercent: input.tombstones?.compactAtPercent ?? base.tombstones.compactAtPercent,
      coalesceAtPercent: input.tombstones?.coalesceAtPercent ?? base.tombstones.coalesceAtPercent,
      coalesceMinChunks: input.tombstones?.coalesceMinChunks ?? base.tombstones.coalesceMinChunks,
      maxCoalescedEntries:
        input.tombstones?.maxCoalescedEntries ?? base.tombstones.maxCoalescedEntries,
    },
    contextGuards: {
      compactFailedToolValidation:
        input.contextGuards?.compactFailedToolValidation ??
        base.contextGuards.compactFailedToolValidation,
      maxFailedToolValidationChars:
        input.contextGuards?.maxFailedToolValidationChars ??
        base.contextGuards.maxFailedToolValidationChars,
    },
    restore: {
      memory: input.restore?.memory ?? base.restore.memory,
      diskCache: mergeDiskCacheConfig(input.restore?.diskCache, base.restore.diskCache),
      sourceRehydrate: input.restore?.sourceRehydrate ?? base.restore.sourceRehydrate,
    },
    debug: input.debug ?? base.debug,
  };
}

function applyProfile(config: PruneChunksConfig, profile: PolicyProfileName): PruneChunksConfig {
  const base = structuredClone(config);
  const profileConfig = POLICY_PROFILES[profile];
  return {
    ...base,
    ...profileConfig,
    profile,
    track: { ...base.track, ...profileConfig.track },
    autoPrune: { ...base.autoPrune, ...profileConfig.autoPrune },
    reamerx: { ...base.reamerx, ...profileConfig.reamerx },
    decisionCards: { ...base.decisionCards, ...profileConfig.decisionCards },
    tombstones: { ...base.tombstones, ...profileConfig.tombstones },
    contextGuards: { ...base.contextGuards, ...profileConfig.contextGuards },
    restore: {
      ...base.restore,
      ...profileConfig.restore,
      diskCache: {
        ...base.restore.diskCache,
        ...profileConfig.restore?.diskCache,
      },
    },
  };
}

function normalizeProfile(input: unknown): PolicyProfileName {
  return isProfile(input) ? input : DEFAULT_CONFIG.profile;
}

export function isPolicyProfile(input: unknown): input is PolicyProfileName {
  return typeof input === "string" && POLICY_PROFILE_NAMES.includes(input as PolicyProfileName);
}

function isProfile(input: unknown): input is PolicyProfileName {
  return isPolicyProfile(input);
}

function normalizePolicy(
  input: unknown,
  fallback: AutoPrunePolicyMode = DEFAULT_CONFIG.autoPrune.policy,
): AutoPrunePolicyMode {
  return input === "adaptive-v1" || input === "heuristic-v1" ? input : fallback;
}

function normalizeModelProfile(
  input: unknown,
  fallback: ModelProfile = DEFAULT_CONFIG.autoPrune.modelProfile,
): ModelProfile {
  return input === "local-32k" ||
    input === "local-64k" ||
    input === "cloud-200k" ||
    input === "cloud-1m" ||
    input === "auto"
    ? input
    : fallback;
}

function mergeDiskCacheConfig(
  input: RawDiskCacheConfig,
  base: DiskCacheConfig = DEFAULT_DISK_CACHE_CONFIG,
): DiskCacheConfig {
  if (typeof input === "boolean") {
    return { ...base, enabled: input };
  }
  if (!input) return { ...base };
  return {
    enabled: input.enabled ?? base.enabled,
    directory: input.directory ?? base.directory,
    maxBytes: input.maxBytes ?? base.maxBytes,
    maxAgeDays: input.maxAgeDays ?? base.maxAgeDays,
    maxBlobBytes: input.maxBlobBytes ?? base.maxBlobBytes,
  };
}
