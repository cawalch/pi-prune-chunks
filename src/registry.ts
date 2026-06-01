import { hashText } from "./text";
import type {
  ChunkActionResult,
  ChunkAuditEvent,
  ChunkContentCache,
  ChunkKind,
  ChunkListOutput,
  CollectedChunk,
  ContentBlock,
  ContextChunk,
  ListChunksOptions,
  PersistedPruneChunksState,
  RestoreMode,
} from "./types";

const RISK_ORDER: Record<string, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

export class MemoryChunkContentCache implements ChunkContentCache {
  private readonly content = new Map<string, ContentBlock[]>();

  get(id: string): ContentBlock[] | undefined {
    return this.content.get(id);
  }

  set(id: string, content: ContentBlock[]): void {
    this.content.set(id, cloneContent(content));
  }

  delete(id: string): void {
    this.content.delete(id);
  }

  has(id: string): boolean {
    return this.content.has(id);
  }

  clear(): void {
    this.content.clear();
  }
}

export class ChunkRegistry {
  private readonly chunks = new Map<string, ContextChunk>();
  private readonly toolCallIndex = new Map<string, string>();
  private readonly auditEvents: ChunkAuditEvent[] = [];
  private counter = 0;

  constructor(private readonly cache: ChunkContentCache = new MemoryChunkContentCache()) {}

  addCollected(collected: CollectedChunk, now = Date.now()): ContextChunk {
    const existingId = this.toolCallIndex.get(collected.toolCallId);
    if (existingId) {
      const existing = this.chunks.get(existingId);
      if (existing) {
        existing.lastSeenAt = now;
        existing.updatedAt = now;
        existing.restoreMode = "memory";
        existing.restoreAvailable = true;
        existing.restoreUnavailableReason = undefined;
        existing.tokenEstimate = collected.tokenEstimate;
        existing.summary = collected.summary;
        this.cache.set(existing.id, collected.content);
        return existing;
      }
    }

    const id = this.nextChunkId(collected.toolCallId, collected.toolName, collected.text);
    const restoreMode = inferRestoreMode(true, collected.source);
    const chunk: ContextChunk = {
      id,
      toolName: collected.toolName,
      label: collected.label,
      kind: collected.kind,
      risk: collected.risk,
      tokenEstimate: collected.tokenEstimate,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
      pruned: false,
      pinned: false,
      summary: collected.summary,
      source: collected.source,
      restoreMode,
      restoreAvailable: restoreMode !== "unavailable",
      restoreUnavailableReason:
        restoreMode === "unavailable"
          ? restoreUnavailableReason(false, collected.source)
          : undefined,
    };

    this.chunks.set(id, chunk);
    this.toolCallIndex.set(collected.toolCallId, id);
    this.cache.set(id, collected.content);
    this.audit(id, "tracked", undefined, now);
    return chunk;
  }

  get(id: string): ContextChunk | undefined {
    return this.chunks.get(id);
  }

  getContent(id: string): ContentBlock[] | undefined {
    return this.cache.get(id);
  }

  setContent(id: string, content: ContentBlock[]): void {
    this.cache.set(id, content);
    const chunk = this.chunks.get(id);
    if (chunk) {
      chunk.restoreMode = "memory";
      chunk.restoreAvailable = true;
      chunk.restoreUnavailableReason = undefined;
      chunk.updatedAt = Date.now();
    }
  }

  getByToolCallId(toolCallId: string): ContextChunk | undefined {
    const id = this.toolCallIndex.get(toolCallId);
    return id ? this.chunks.get(id) : undefined;
  }

  list(options: ListChunksOptions = {}): ChunkListOutput {
    let entries = [...this.chunks.values()];

    if (options.toolName) {
      entries = entries.filter((chunk) => chunk.toolName === options.toolName);
    }
    if (options.kind) {
      entries = entries.filter((chunk) => chunk.kind === options.kind);
    }
    if (options.pruned !== undefined) {
      entries = entries.filter((chunk) => chunk.pruned === options.pruned);
    }
    if (options.pinned !== undefined) {
      entries = entries.filter((chunk) => chunk.pinned === options.pinned);
    }
    if (options.minTokens !== undefined) {
      entries = entries.filter((chunk) => chunk.tokenEstimate >= (options.minTokens ?? 0));
    }

    sortChunks(entries, options.sortBy ?? "recent");
    const limit = Math.max(0, options.limit ?? 20);
    const sliced = entries.slice(0, limit);
    const summary = this.summary();

    return {
      totalChunks: summary.totalChunks,
      totalTokens: summary.totalTokens,
      activeTokens: summary.activeTokens,
      prunedTokens: summary.prunedTokens,
      pinnedChunks: summary.pinnedChunks,
      listed: sliced.length,
      chunks: sliced.map((chunk) => ({
        id: chunk.id,
        label: chunk.label,
        toolName: chunk.toolName,
        kind: chunk.kind,
        risk: chunk.risk,
        tokenEstimate: chunk.tokenEstimate,
        pruned: chunk.pruned,
        pinned: chunk.pinned,
        restoreMode: chunk.restoreMode,
        restoreAvailable: chunk.restoreAvailable,
        restoreUnavailableReason: chunk.restoreUnavailableReason,
        summary: chunk.summary,
        source: chunk.source,
        createdAt: chunk.createdAt,
        lastRestoredAt: chunk.lastRestoredAt,
      })),
    };
  }

  all(): ContextChunk[] {
    return [...this.chunks.values()];
  }

  active(): ContextChunk[] {
    return this.all().filter((chunk) => !chunk.pruned);
  }

  prunedForToolCall(toolCallId: string): ContextChunk | undefined {
    const chunk = this.getByToolCallId(toolCallId);
    return chunk?.pruned ? chunk : undefined;
  }

  markSeenByToolCallId(toolCallId: string, now = Date.now()): void {
    const chunk = this.getByToolCallId(toolCallId);
    if (!chunk) return;
    chunk.lastSeenAt = now;
    chunk.updatedAt = now;
  }

  prune(
    ids: string[],
    reason?: string,
    action: "pruned" | "auto_pruned" = "pruned",
  ): ChunkActionResult[] {
    const now = Date.now();
    return ids.map((id) => {
      const chunk = this.chunks.get(id);
      if (!chunk) return { id, status: "not_found", tokens: 0 };
      if (chunk.pruned) return { id, status: "already_pruned", tokens: 0 };

      chunk.pruned = true;
      chunk.pruneReason = reason;
      chunk.updatedAt = now;
      this.audit(id, action, reason, now);
      return { id, status: "pruned", tokens: chunk.tokenEstimate };
    });
  }

  restore(id: string, mode: RestoreMode, now = Date.now()): ChunkActionResult {
    const chunk = this.chunks.get(id);
    if (!chunk) return { id, status: "not_found", tokens: 0 };
    if (!chunk.pruned) return { id, status: "not_pruned", tokens: 0 };

    chunk.pruned = false;
    chunk.pruneReason = undefined;
    chunk.restoreMode = mode;
    chunk.restoreAvailable = true;
    chunk.restoreUnavailableReason = undefined;
    chunk.lastRestoredAt = now;
    chunk.updatedAt = now;
    this.audit(id, mode === "source_rehydrate" ? "rehydrated" : "restored", undefined, now);
    return { id, status: "restored", tokens: chunk.tokenEstimate, restoreMode: mode };
  }

  pin(ids: string[], reason?: string): ChunkActionResult[] {
    const now = Date.now();
    return ids.map((id) => {
      const chunk = this.chunks.get(id);
      if (!chunk) return { id, status: "not_found", tokens: 0 };
      if (chunk.pinned) return { id, status: "already_pinned", tokens: 0 };

      chunk.pinned = true;
      chunk.pinReason = reason;
      chunk.updatedAt = now;
      this.audit(id, "pinned", reason, now);
      return { id, status: "pinned", tokens: chunk.tokenEstimate };
    });
  }

  unpin(ids: string[]): ChunkActionResult[] {
    const now = Date.now();
    return ids.map((id) => {
      const chunk = this.chunks.get(id);
      if (!chunk) return { id, status: "not_found", tokens: 0 };
      if (!chunk.pinned) return { id, status: "not_pinned", tokens: 0 };

      chunk.pinned = false;
      chunk.pinReason = undefined;
      chunk.updatedAt = now;
      this.audit(id, "unpinned", undefined, now);
      return { id, status: "unpinned", tokens: chunk.tokenEstimate };
    });
  }

  summary(): {
    totalChunks: number;
    prunedChunks: number;
    pinnedChunks: number;
    totalTokens: number;
    activeTokens: number;
    prunedTokens: number;
    activeByKind: Record<ChunkKind, { count: number; tokens: number }>;
    activeByTool: Record<string, { count: number; tokens: number }>;
  } {
    const activeByKind = {} as Record<ChunkKind, { count: number; tokens: number }>;
    const activeByTool: Record<string, { count: number; tokens: number }> = {};
    let prunedChunks = 0;
    let pinnedChunks = 0;
    let totalTokens = 0;
    let prunedTokens = 0;

    for (const chunk of this.chunks.values()) {
      totalTokens += chunk.tokenEstimate;
      if (chunk.pinned) pinnedChunks++;
      if (chunk.pruned) {
        prunedChunks++;
        prunedTokens += chunk.tokenEstimate;
        continue;
      }

      const kindBucket = activeByKind[chunk.kind] ?? { count: 0, tokens: 0 };
      kindBucket.count++;
      kindBucket.tokens += chunk.tokenEstimate;
      activeByKind[chunk.kind] = kindBucket;

      const toolBucket = activeByTool[chunk.toolName] ?? { count: 0, tokens: 0 };
      toolBucket.count++;
      toolBucket.tokens += chunk.tokenEstimate;
      activeByTool[chunk.toolName] = toolBucket;
    }

    return {
      totalChunks: this.chunks.size,
      prunedChunks,
      pinnedChunks,
      totalTokens,
      activeTokens: totalTokens - prunedTokens,
      prunedTokens,
      activeByKind,
      activeByTool,
    };
  }

  auditTrail(limit = 50): ChunkAuditEvent[] {
    return this.auditEvents.slice(-Math.max(0, limit));
  }

  persistenceState(): PersistedPruneChunksState {
    return {
      version: 1,
      chunks: this.all().map((chunk) => ({
        ...chunk,
        source: chunk.source ? { ...chunk.source } : undefined,
      })),
      audit: this.auditTrail(200),
    };
  }

  restorePersistence(state: PersistedPruneChunksState | undefined | null): number {
    if (!state || state.version !== 1 || !Array.isArray(state.chunks)) return 0;

    this.chunks.clear();
    this.toolCallIndex.clear();
    this.auditEvents.splice(0, this.auditEvents.length, ...(state.audit ?? []));
    this.counter = 0;

    for (const persisted of state.chunks) {
      const chunk = cloneChunk(persisted);
      const sourceMode = inferRestoreMode(false, chunk.source);
      chunk.restoreMode = sourceMode;
      chunk.restoreAvailable = sourceMode !== "unavailable";
      chunk.restoreUnavailableReason =
        sourceMode === "unavailable" ? restoreUnavailableReason(false, chunk.source) : undefined;
      this.chunks.set(chunk.id, chunk);
      if (chunk.source?.toolCallId) {
        this.toolCallIndex.set(chunk.source.toolCallId, chunk.id);
      }
      this.counter = Math.max(this.counter, counterFromId(chunk.id));
    }

    return this.chunks.size;
  }

  reset(): void {
    this.chunks.clear();
    this.toolCallIndex.clear();
    this.auditEvents.length = 0;
    this.cache.clear();
    this.counter = 0;
  }

  private nextChunkId(toolCallId: string, toolName: string, text: string): string {
    this.counter++;
    const counterPart = this.counter.toString(36).padStart(4, "0");
    const hash = hashText(`${toolCallId}\n${toolName}\n${text}`).slice(0, 6);
    return `pc_${counterPart}_${hash}`;
  }

  private audit(
    chunkId: string,
    action: ChunkAuditEvent["action"],
    reason: string | undefined,
    timestamp: number,
  ): void {
    const id = `evt_${this.auditEvents.length.toString(36).padStart(4, "0")}_${hashText(
      `${chunkId}:${action}:${timestamp}:${reason ?? ""}`,
    ).slice(0, 6)}`;
    this.auditEvents.push({ id, chunkId, action, reason, timestamp });
  }
}

export function inferRestoreMode(
  hasMemory: boolean,
  source?: { path?: string; startLine?: number; endLine?: number },
): RestoreMode {
  if (hasMemory) return "memory";
  if (source?.path && source.startLine != null && source.endLine != null) return "source_rehydrate";
  return "unavailable";
}

export function restoreUnavailableReason(
  hasMemory: boolean,
  source?: { path?: string; startLine?: number; endLine?: number },
): string | undefined {
  if (hasMemory) return undefined;
  if (!source?.path) return "no memory content or source path metadata";
  if (source.startLine == null || source.endLine == null) {
    return "no memory content or source line range metadata";
  }
  return undefined;
}

function cloneContent(content: ContentBlock[]): ContentBlock[] {
  return content.map((block) => ({ ...block }));
}

function cloneChunk(chunk: ContextChunk): ContextChunk {
  return {
    ...chunk,
    source: chunk.source ? { ...chunk.source } : undefined,
  };
}

function counterFromId(id: string): number {
  const match = /^pc_([0-9a-z]+)_/.exec(id);
  return match ? parseInt(match[1], 36) : 0;
}

function sortChunks(chunks: ContextChunk[], sortBy: "tokens" | "age" | "recent" | "risk"): void {
  switch (sortBy) {
    case "tokens":
      chunks.sort((a, b) => b.tokenEstimate - a.tokenEstimate || b.createdAt - a.createdAt);
      break;
    case "age":
      chunks.sort((a, b) => a.createdAt - b.createdAt || b.tokenEstimate - a.tokenEstimate);
      break;
    case "risk":
      chunks.sort(
        (a, b) => RISK_ORDER[b.risk] - RISK_ORDER[a.risk] || b.tokenEstimate - a.tokenEstimate,
      );
      break;
    case "recent":
      chunks.sort((a, b) => b.createdAt - a.createdAt || b.tokenEstimate - a.tokenEstimate);
      break;
  }
}
