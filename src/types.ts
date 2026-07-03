export type ChunkKind =
  | "file_read"
  | "search"
  | "flow_trace"
  | "context_pack"
  | "shell"
  | "test_output"
  | "diff"
  | "outline"
  | "symbol"
  | "other";

export type ChunkRisk = "low" | "medium" | "high";

export type RestoreMode = "memory" | "disk_cache" | "source_rehydrate" | "unavailable";

export type AutoPrunePolicyMode = "heuristic-v1" | "adaptive-v1";

export type ModelProfile = "auto" | "local-32k" | "local-64k" | "cloud-200k" | "cloud-1m";

export type PolicyProfileName =
  | "local-32k"
  | "local-64k"
  | "cloud-200k"
  | "cloud-1m"
  | "privacy-max"
  | "research-heavy"
  | "coding-heavy"
  | "debug-failures";

export interface DiskCacheConfig {
  enabled: boolean;
  directory?: string;
  maxBytes: number;
  maxAgeDays: number;
  maxBlobBytes: number;
}

export type ContentBlock = {
  type: string;
  text?: string;
  [key: string]: unknown;
};

export interface ChunkSource {
  path?: string;
  startLine?: number;
  endLine?: number;
  symbol?: string;
  command?: string;
  toolCallId?: string;
  contentHash?: string;
  mtimeMs?: number;
}

export interface ChunkDecisionCard {
  gist: string;
  evidence: string[];
  restoreWhen: string[];
  safeToIgnoreWhen?: string[];
  sourceAnchors?: string[];
  hazards?: string[];
  generatedBy: "heuristic" | "model";
}

export type ChunkScopeKind = "main" | "subagent" | "chain";

export interface ChunkScope {
  scope: ChunkScopeKind;
  runId?: string;
  agentName?: string;
  parentRunId?: string;
}

export interface ChunkPart {
  index: number;
  label: string;
  lineStart?: number;
  lineEnd?: number;
  role: "kept_summary" | "bulk" | "failure" | "source" | "metadata";
}

export interface ContextChunk {
  id: string;
  parentId?: string;
  part?: ChunkPart;
  scope?: ChunkScope;
  toolName: string;
  label: string;
  kind: ChunkKind;
  risk: ChunkRisk;
  tokenEstimate: number;
  createdAt: number;
  updatedAt: number;
  lastSeenAt?: number;
  lastRestoredAt?: number;
  restoreCount?: number;
  pruned: boolean;
  pinned: boolean;
  pruneReason?: string;
  pinReason?: string;
  summary?: string;
  decisionCard?: ChunkDecisionCard;
  source?: ChunkSource;
  restoreMode: RestoreMode;
  restoreAvailable: boolean;
  restoreUnavailableReason?: string;
}

export type PreserveContext = {
  ids?: Set<string>;
  paths?: Set<string>;
};

export type TelemetryEventType =
  | "collect"
  | "manual_prune"
  | "auto_prune"
  | "restore"
  | "pin"
  | "unpin"
  | "tombstone"
  | "coalesce";

export interface ContinuationManifestEntry {
  id: string;
  label: string;
  kind: ChunkKind;
  risk: ChunkRisk;
  tokenEstimate: number;
  status: "active" | "pruned";
  card?: string;
  restoreHint?: string;
  sourceAnchors?: string[];
}

export interface ContinuationManifest {
  id: string;
  generatedAt: number;
  reason: string;
  pressurePercent: number | null;
  policy: AutoPrunePolicyMode;
  modelProfile: ModelProfile;
  modifiedPaths: string[];
  pinnedChunkIds: string[];
  active: ContinuationManifestEntry[];
  prunedHighValue: ContinuationManifestEntry[];
  unresolvedFailures: ContinuationManifestEntry[];
  recentRestores: ContinuationManifestEntry[];
}

export interface ContextTelemetryEvent {
  id: string;
  type: TelemetryEventType;
  timestamp: number;
  chunkId?: string;
  count?: number;
  tokens?: number;
  restoreMode?: RestoreMode;
  status?: string;
  reason?: string;
}

export interface ChunkAuditEvent {
  id: string;
  chunkId: string;
  action: "tracked" | "pruned" | "restored" | "pinned" | "unpinned" | "auto_pruned" | "rehydrated";
  reason?: string;
  timestamp: number;
}

export interface ChunkContentCache {
  get(id: string, mode?: "memory" | "disk_cache"): ContentBlock[] | undefined;
  set(id: string, content: ContentBlock[]): void;
  delete(id: string): void;
  has(id: string, mode?: "memory" | "disk_cache"): boolean;
  clear(): void;
}

export interface ContextUsage {
  tokens: number | null;
  contextWindow: number | undefined;
  percent: number | null;
}

export type PruneChunksConfig = {
  profile: PolicyProfileName;
  enabled: boolean;
  trackTools: string[];
  track: {
    minChunkTokens: number;
  };
  autoPrune: {
    enabled: boolean;
    policy: AutoPrunePolicyMode;
    modelProfile: ModelProfile;
    startAtPercent: number;
    targetPercent: number;
    preserveRecentChunks: number;
    preserveRecentMinutes: number;
    minChunkTokens: number;
    maxChunksPerPass: number;
    pruneSupersededOnIngest: boolean;
    pruneZeroMatchSearchesOnIngest: boolean;
  };
  reamerx: {
    pruneExploratoryAfterTerminal: boolean;
  };
  tombstones: {
    includeSummary: boolean;
    includeRestoreHint: boolean;
    maxSummaryChars: number;
    compactAtPercent: number;
    coalesceAtPercent: number;
    maxCoalescedEntries: number;
  };
  contextGuards: {
    compactFailedToolValidation: boolean;
    maxFailedToolValidationChars: number;
  };
  restore: {
    memory: boolean;
    diskCache: DiskCacheConfig;
    sourceRehydrate: boolean;
  };
  debug: boolean;
};

export interface CollectedChunk {
  toolCallId: string;
  toolName: string;
  content: ContentBlock[];
  text: string;
  label: string;
  kind: ChunkKind;
  risk: ChunkRisk;
  tokenEstimate: number;
  summary?: string;
  decisionCard?: ChunkDecisionCard;
  source?: ChunkSource;
  scope?: ChunkScope;
}

export type ListChunksOptions = {
  toolName?: string;
  kind?: ChunkKind;
  pruned?: boolean;
  pinned?: boolean;
  minTokens?: number;
  limit?: number;
  sortBy?: "tokens" | "age" | "recent" | "risk";
  scope?: ChunkScopeKind;
};

export type ChunkListOutput = {
  totalChunks: number;
  totalTokens: number;
  activeTokens: number;
  prunedTokens: number;
  pinnedChunks: number;
  listed: number;
  chunks: Array<{
    id: string;
    parentId?: string;
    part?: ChunkPart;
    scope?: ChunkScope;
    label: string;
    toolName: string;
    kind: ChunkKind;
    risk: ChunkRisk;
    tokenEstimate: number;
    pruned: boolean;
    pinned: boolean;
    pruneReason?: string;
    pinReason?: string;
    restoreMode: RestoreMode;
    restoreAvailable: boolean;
    restoreUnavailableReason?: string;
    summary?: string;
    decisionCard?: ChunkDecisionCard;
    source?: ChunkSource;
    createdAt: number;
    lastRestoredAt?: number;
    restoreCount?: number;
  }>;
};

export type ChunkActionStatus =
  | "pruned"
  | "already_pruned"
  | "restored"
  | "not_pruned"
  | "pinned"
  | "already_pinned"
  | "unpinned"
  | "not_pinned"
  | "not_found"
  | "unavailable"
  | "source_changed";

export type ChunkActionResult = {
  id: string;
  status: ChunkActionStatus;
  tokens: number;
  reason?: string;
  restoreMode?: RestoreMode;
};

export type PersistedPruneChunksState = {
  version: 1;
  chunks: ContextChunk[];
  audit: ChunkAuditEvent[];
  telemetry?: ContextTelemetryEvent[];
  continuationManifest?: ContinuationManifest;
  activeProfile?: PolicyProfileName;
};
