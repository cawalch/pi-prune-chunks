import { parentTokenEstimate, planChunkParts } from "./parts";
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
  RestoreMode,
  StateDeltaAction,
} from "./types";

const RISK_ORDER: Record<string, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

export class MemoryChunkContentCache implements ChunkContentCache {
  private readonly content = new Map<string, ContentBlock[]>();

  get(id: string, mode?: "memory" | "disk_cache"): ContentBlock[] | undefined {
    if (mode === "disk_cache") return undefined;
    return this.content.get(id);
  }

  set(id: string, content: ContentBlock[]): void {
    this.content.set(id, cloneContent(content));
  }

  async archive(id: string, content: ContentBlock[]): Promise<void> {
    if (!this.content.has(id)) this.set(id, content);
  }

  delete(id: string): void {
    this.content.delete(id);
  }

  has(id: string, mode?: "memory" | "disk_cache"): boolean {
    if (mode === "disk_cache") return false;
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
  private revisionCounter = 0;

  constructor(private readonly cache: ChunkContentCache = new MemoryChunkContentCache()) {}

  addCollected(collected: CollectedChunk, now = Date.now()): ContextChunk {
    const existingId = this.toolCallIndex.get(collected.toolCallId);
    if (existingId) {
      const existing = this.chunks.get(existingId);
      if (existing) {
        existing.updatedAt = now;
        existing.restoreMode = "memory";
        existing.restoreAvailable = true;
        existing.restoreUnavailableReason = undefined;
        existing.tokenEstimate = collected.tokenEstimate;
        existing.scope = collected.scope;
        existing.summary = collected.summary;
        this.cache.set(existing.id, collected.content);
        this.revisionCounter += 1;
        return existing;
      }
    }

    const id = this.nextChunkId(collected.toolCallId, collected.toolName, collected.text);
    const parts = planChunkParts({
      kind: collected.kind,
      content: collected.content,
      tokenEstimate: collected.tokenEstimate,
    });
    const restoreMode = inferRestoreMode(true, collected.source, this.cache.has(id, "disk_cache"));
    const chunk: ContextChunk = {
      id,
      toolName: collected.toolName,
      scope: collected.scope,
      label: collected.label,
      kind: collected.kind,
      risk: collected.risk,
      tokenEstimate:
        parts.length > 0
          ? parentTokenEstimate(collected.tokenEstimate, parts)
          : collected.tokenEstimate,
      createdAt: now,
      updatedAt: now,
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
    this.addPartChunks(chunk, collected, parts, now);
    this.revisionCounter += 1;
    return chunk;
  }

  get(id: string): ContextChunk | undefined {
    return this.chunks.get(id);
  }

  getContent(id: string, mode?: "memory" | "disk_cache"): ContentBlock[] | undefined {
    return this.cache.get(id, mode);
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
    if (options.scope) {
      entries = entries.filter((chunk) => (chunk.scope?.scope ?? "main") === options.scope);
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
        parentId: chunk.parentId,
        part: chunk.part ? { ...chunk.part } : undefined,
        scope: chunk.scope ? { ...chunk.scope } : undefined,
        label: chunk.label,
        toolName: chunk.toolName,
        kind: chunk.kind,
        risk: chunk.risk,
        tokenEstimate: chunk.tokenEstimate,
        pruned: chunk.pruned,
        pinned: chunk.pinned,
        pruneReason: chunk.pruneReason,
        pinReason: chunk.pinReason,
        restoreMode: chunk.restoreMode,
        restoreAvailable: chunk.restoreAvailable,
        restoreUnavailableReason: chunk.restoreUnavailableReason,
        summary: chunk.summary,
        source: chunk.source,
        createdAt: chunk.createdAt,
        lastRestoredAt: chunk.lastRestoredAt,
        restoreCount: chunk.restoreCount,
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

  prunedPartsForToolCall(toolCallId: string): ContextChunk[] {
    const parent = this.getByToolCallId(toolCallId);
    if (!parent) return [];
    return this.all()
      .filter((chunk) => chunk.parentId === parent.id && chunk.pruned)
      .sort((a, b) => (a.part?.index ?? 0) - (b.part?.index ?? 0));
  }

  hasChildren(id: string): boolean {
    return this.all().some((chunk) => chunk.parentId === id);
  }

  revision(): number {
    return this.revisionCounter;
  }

  async archive(ids: string[]): Promise<void> {
    const family = this.familyOf(ids);
    await Promise.all(
      family.map(async (id) => {
        const content = this.cache.get(id, "memory");
        if (content) await this.cache.archive(id, content);
      }),
    );
    for (const id of family) {
      const chunk = this.chunks.get(id);
      if (!chunk) continue;
      if (this.cache.has(id, "disk_cache")) {
        chunk.restoreMode = "disk_cache";
        chunk.restoreAvailable = true;
        chunk.restoreUnavailableReason = undefined;
      }
    }
  }

  markSeenByToolCallId(toolCallId: string, now = Date.now()): boolean {
    const chunk = this.getByToolCallId(toolCallId);
    if (!chunk || chunk.lastSeenAt != null) return false;
    for (const id of this.familyOf([chunk.id])) {
      const member = this.chunks.get(id);
      if (!member) continue;
      member.lastSeenAt = now;
    }
    return true;
  }

  /**
   * Expand ids to a parent plus its parts. Pruning or restoring a parent
   * acts on the whole family; a single part id resolves to just itself, so
   * partial pruning of a bulk section still works.
   */
  familyOf(ids: string[]): string[] {
    const ordered: string[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (this.chunks.has(id) && !seen.has(id)) {
        seen.add(id);
        ordered.push(id);
      }
    }
    const idSet = new Set(ids);
    for (const chunk of this.chunks.values()) {
      if (chunk.parentId && idSet.has(chunk.parentId) && !seen.has(chunk.id)) {
        seen.add(chunk.id);
        ordered.push(chunk.id);
      }
    }
    return ordered;
  }

  prune(
    ids: string[],
    reason?: string,
    action: "pruned" | "auto_pruned" = "pruned",
  ): ChunkActionResult[] {
    const now = Date.now();
    // Cascade to parts: pruning a parent removes the whole tool result, so its
    // bulk part must leave active accounting too. Otherwise a fully-pruned
    // parent leaves its part active (and, since markSeen resolves only the
    // parent, never auto-prunable), inflating activeTokens indefinitely.
    return this.familyOf(ids).map((id) => {
      const chunk = this.chunks.get(id);
      if (!chunk) return { id, status: "not_found", tokens: 0 };
      if (chunk.pruned) return { id, status: "already_pruned", tokens: 0 };

      chunk.pruned = true;
      chunk.pruneReason = reason;
      chunk.updatedAt = now;
      this.audit(id, action, reason, now);
      this.revisionCounter += 1;
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
    chunk.restoreCount = (chunk.restoreCount ?? 0) + 1;
    chunk.updatedAt = now;
    this.audit(id, mode === "source_rehydrate" ? "rehydrated" : "restored", undefined, now);
    this.revisionCounter += 1;
    return { id, status: "restored", tokens: chunk.tokenEstimate, restoreMode: mode };
  }

  /**
   * Prune active, main-scope chunks that were previously seen but whose
   * toolCallId is no longer in the transcript (e.g. summarized away by
   * compaction). Safe against subagent contexts: if NO main-scope seen chunk
   * is still present, this is a different context, so nothing is evicted.
   */
  evictAbsentFromContext(
    presentToolCallIds: Set<string>,
    reason = "evicted from context",
  ): ChunkActionResult[] {
    return this.prune(this.absentFromContext(presentToolCallIds), reason, "auto_pruned");
  }

  absentFromContext(presentToolCallIds: Set<string>, allowEmpty = false): string[] {
    const mainSeen = this.active().filter(
      (chunk) =>
        (chunk.scope?.scope ?? "main") === "main" &&
        chunk.lastSeenAt != null &&
        !!chunk.source?.toolCallId,
    );
    if (mainSeen.length === 0) return [];
    const presentCount = mainSeen.filter((chunk) =>
      presentToolCallIds.has(chunk.source?.toolCallId ?? ""),
    ).length;
    if (presentCount === 0 && !allowEmpty) return [];
    const absent = mainSeen.filter(
      (chunk) => !presentToolCallIds.has(chunk.source?.toolCallId ?? ""),
    );
    return absent.map((chunk) => chunk.id);
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
      this.revisionCounter += 1;
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
      this.revisionCounter += 1;
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
    prunedByKind: Record<ChunkKind, { count: number; tokens: number }>;
    prunedByTool: Record<string, { count: number; tokens: number }>;
    restoreByMode: Record<RestoreMode, { count: number; tokens: number }>;
    unavailableByKind: Record<ChunkKind, { count: number; tokens: number }>;
    unavailableByTool: Record<string, { count: number; tokens: number }>;
  } {
    const activeByKind = {} as Record<ChunkKind, { count: number; tokens: number }>;
    const activeByTool: Record<string, { count: number; tokens: number }> = {};
    const prunedByKind = {} as Record<ChunkKind, { count: number; tokens: number }>;
    const prunedByTool: Record<string, { count: number; tokens: number }> = {};
    const restoreByMode = emptyRestoreBuckets();
    const unavailableByKind = {} as Record<ChunkKind, { count: number; tokens: number }>;
    const unavailableByTool: Record<string, { count: number; tokens: number }> = {};
    let prunedChunks = 0;
    let pinnedChunks = 0;
    let totalTokens = 0;
    let prunedTokens = 0;

    for (const chunk of this.chunks.values()) {
      totalTokens += chunk.tokenEstimate;
      incrementBucket(restoreByMode, chunk.restoreMode, chunk.tokenEstimate);
      if (!chunk.restoreAvailable) {
        incrementBucket(unavailableByKind, chunk.kind, chunk.tokenEstimate);
        incrementBucket(unavailableByTool, chunk.toolName, chunk.tokenEstimate);
      }
      if (chunk.pinned) pinnedChunks++;
      if (chunk.pruned) {
        prunedChunks++;
        prunedTokens += chunk.tokenEstimate;
        incrementBucket(prunedByKind, chunk.kind, chunk.tokenEstimate);
        incrementBucket(prunedByTool, chunk.toolName, chunk.tokenEstimate);
        continue;
      }

      incrementBucket(activeByKind, chunk.kind, chunk.tokenEstimate);
      incrementBucket(activeByTool, chunk.toolName, chunk.tokenEstimate);
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
      prunedByKind,
      prunedByTool,
      restoreByMode,
      unavailableByKind,
      unavailableByTool,
    };
  }

  auditTrail(limit = 50): ChunkAuditEvent[] {
    return this.auditEvents.slice(-Math.max(0, limit));
  }

  applyDelta(action: StateDeltaAction): boolean {
    const chunk = this.chunks.get(action.id);
    if (!chunk) return false;
    if (action.state === "pruned") {
      this.prune([action.id], action.reason, "auto_pruned");
      return true;
    }
    if (chunk.pruned) {
      this.restore(
        action.id,
        this.cache.has(action.id, "disk_cache") ? "disk_cache" : "memory",
        action.timestamp,
      );
    }
    return true;
  }

  reset(): void {
    this.chunks.clear();
    this.toolCallIndex.clear();
    this.auditEvents.length = 0;
    this.cache.clear();
    this.revisionCounter = 0;
  }

  private addPartChunks(
    parent: ContextChunk,
    collected: CollectedChunk,
    parts: ReturnType<typeof planChunkParts>,
    now: number,
  ): void {
    parts.forEach((part, index) => {
      const id = `${parent.id}#${part.idSuffix}`;
      const child: ContextChunk = {
        ...parent,
        id,
        parentId: parent.id,
        part: {
          index,
          label: part.label,
          lineStart: part.lineStart,
          lineEnd: part.lineEnd,
          role: part.role,
        },
        label: `${parent.label}#${part.label}`,
        tokenEstimate: part.tokenEstimate,
        scope: parent.scope ? { ...parent.scope } : undefined,
        source: parent.source
          ? {
              ...parent.source,
              startLine:
                parent.source.startLine != null
                  ? parent.source.startLine + part.lineStart - 1
                  : part.lineStart,
              endLine:
                parent.source.startLine != null
                  ? parent.source.startLine + part.lineEnd - 1
                  : part.lineEnd,
            }
          : parent.source,
        createdAt: now,
        updatedAt: now,
        pruned: false,
        pinned: false,
        pruneReason: undefined,
        pinReason: undefined,
        summary: collected.summary,
        restoreMode: inferRestoreMode(true, parent.source, this.cache.has(id, "disk_cache")),
        restoreAvailable: true,
        restoreUnavailableReason: undefined,
      };
      this.chunks.set(id, child);
      this.cache.set(id, part.content);
      this.audit(id, "tracked", `part of ${parent.id}`, now);
    });
  }

  private nextChunkId(toolCallId: string, toolName: string, text: string): string {
    return `pc_${hashText(`${toolCallId}\n${toolName}\n${text}`).slice(0, 12)}`;
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
  hasDiskCache = false,
): RestoreMode {
  if (hasMemory) return "memory";
  if (hasDiskCache) return "disk_cache";
  if (source?.path && source.startLine != null && source.endLine != null) return "source_rehydrate";
  return "unavailable";
}

export function restoreUnavailableReason(
  hasMemory: boolean,
  source?: { path?: string; startLine?: number; endLine?: number },
  hasDiskCache = false,
): string | undefined {
  if (hasMemory || hasDiskCache) return undefined;
  if (!source?.path) return "no memory content, disk cache, or source path metadata";
  if (source.startLine == null || source.endLine == null) {
    return "no memory content, disk cache, or source line range metadata";
  }
  return undefined;
}

function cloneContent(content: ContentBlock[]): ContentBlock[] {
  return content.map((block) => ({ ...block }));
}

function incrementBucket<K extends string>(
  buckets: Record<K, { count: number; tokens: number }>,
  key: K,
  tokens: number,
): void {
  const bucket = buckets[key] ?? { count: 0, tokens: 0 };
  bucket.count++;
  bucket.tokens += tokens;
  buckets[key] = bucket;
}

function emptyRestoreBuckets(): Record<RestoreMode, { count: number; tokens: number }> {
  return {
    memory: { count: 0, tokens: 0 },
    disk_cache: { count: 0, tokens: 0 },
    source_rehydrate: { count: 0, tokens: 0 },
    unavailable: { count: 0, tokens: 0 },
  };
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
