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

export interface ContextChunk {
  id: string;
  toolName: string;
  label: string;
  kind: ChunkKind;
  risk: ChunkRisk;
  tokenEstimate: number;
  createdAt: number;
  updatedAt: number;
  lastSeenAt?: number;
  lastRestoredAt?: number;
  pruned: boolean;
  pinned: boolean;
  pruneReason?: string;
  pinReason?: string;
  summary?: string;
  source?: ChunkSource;
  restoreMode: RestoreMode;
  restoreAvailable: boolean;
  restoreUnavailableReason?: string;
}

export type PreserveContext = {
  ids?: Set<string>;
  paths?: Set<string>;
};

export interface ChunkAuditEvent {
  id: string;
  chunkId: string;
  action: "tracked" | "pruned" | "restored" | "pinned" | "unpinned" | "auto_pruned" | "rehydrated";
  reason?: string;
  timestamp: number;
}

export interface ChunkContentCache {
  get(id: string): ContentBlock[] | undefined;
  set(id: string, content: ContentBlock[]): void;
  delete(id: string): void;
  has(id: string): boolean;
  clear(): void;
}

export interface ContextUsage {
  tokens: number | null;
  contextWindow: number | undefined;
  percent: number | null;
}

export type PruneChunksConfig = {
  enabled: boolean;
  trackTools: string[];
  track: {
    minChunkTokens: number;
  };
  autoPrune: {
    enabled: boolean;
    startAtPercent: number;
    targetPercent: number;
    preserveRecentChunks: number;
    preserveRecentMinutes: number;
    minChunkTokens: number;
    maxChunksPerPass: number;
  };
  tombstones: {
    includeSummary: boolean;
    includeRestoreHint: boolean;
    maxSummaryChars: number;
    compactAtPercent: number;
    coalesceAtPercent: number;
    maxCoalescedEntries: number;
  };
  restore: {
    memory: boolean;
    diskCache: boolean;
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
  source?: ChunkSource;
}

export type ListChunksOptions = {
  toolName?: string;
  kind?: ChunkKind;
  pruned?: boolean;
  pinned?: boolean;
  minTokens?: number;
  limit?: number;
  sortBy?: "tokens" | "age" | "recent" | "risk";
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
    label: string;
    toolName: string;
    kind: ChunkKind;
    risk: ChunkRisk;
    tokenEstimate: number;
    pruned: boolean;
    pinned: boolean;
    restoreMode: RestoreMode;
    restoreAvailable: boolean;
    restoreUnavailableReason?: string;
    summary?: string;
    source?: ChunkSource;
    createdAt: number;
    lastRestoredAt?: number;
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
};
