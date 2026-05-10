/**
 * ChunkTracker — Core state management for tracking and pruning tool-result chunks.
 *
 * Separated from the pi extension entry point for testability.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToolChunk = {
  /** Stable chunk id (toolCallId). */
  id: string;
  /** Tool that produced this chunk. */
  toolName: string;
  /** Timestamp when the chunk was catalogued. */
  timestamp: number;
  /** Token estimate for the original content. */
  estTokens: number;
  /** Short label for display (first line or file path). */
  label: string;
  /** Whether this chunk is currently pruned. */
  pruned: boolean;
  /** Pruning reason, if pruned. */
  pruneReason?: string;
  /** Original content (kept in memory for restore). */
  originalContent: Array<{ type: string; text: string }>;
};

export type PruneResult = {
  id: string;
  status: "pruned" | "already_pruned" | "not_found";
  tokens: number;
};

export type RestoreResult = {
  id: string;
  status: "restored" | "not_pruned" | "not_found" | "content_lost";
  tokens: number;
};

export type ListOutput = {
  totalChunks: number;
  totalTokens: number;
  prunedTokens: number;
  listed: number;
  chunks: Array<{
    id: string;
    toolName: string;
    label: string;
    estTokens: number;
    pruned: boolean;
    timestamp: number;
  }>;
};

/** Configurable thresholds for context budget enforcement. */
export type ThresholdConfig = {
  /** Fraction (0–1) at which to inject soft warnings. Default: 0.5 */
  softThreshold: number;
  /** Fraction (0–1) at which to block non-prune tool calls. Default: 0.9 */
  hardThreshold: number;
  /** Max consecutive prune calls before streak penalty. Default: 3 */
  maxConsecutivePrunes: number;
};

export const DEFAULT_THRESHOLDS: ThresholdConfig = {
  softThreshold: 0.5,
  hardThreshold: 0.9,
  maxConsecutivePrunes: 3,
};

// Tools that produce large, pruneable context
export const PRUNEABLE_TOOLS = new Set([
  "code_context",
  "code_search",
  "code_search_symbols",
  "code_read_range",
  "code_read_symbol",
  "code_outline",
  "code_related",
  "flow_trace",
  "flow_path",
  "flow_impact",
  "code_pattern_search",
  "code_semantic_search",
  "code_flow_trace",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function contentText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text ?? "")
    .join("\n");
}

export function makeLabel(toolName: string, content: string): string {
  const firstLine = content.split("\n").find((l) => l.trim().length > 0) ?? "";
  const maxLen = 80;
  const truncated = firstLine.length > maxLen ? `${firstLine.slice(0, maxLen)}…` : firstLine;
  return `${toolName}: ${truncated}`;
}

export function tombstoneFor(chunk: ToolChunk): Array<{ type: string; text: string }> {
  return [
    {
      type: "text",
      text: `[pruned:${chunk.id} ${chunk.toolName} "${chunk.label}" ~${chunk.estTokens}t — use restore_chunks to recover]`,
    },
  ];
}

/** Build a compact context-usage footer for agent visibility. */
export function contextFooter(
  usedTokens: number,
  limitTokens: number,
  summary: { total: number; pruned: number; totalTokens: number; prunedTokens: number },
): string {
  const pct = Math.round((usedTokens / limitTokens) * 100);
  const activeTokens = summary.totalTokens - summary.prunedTokens;
  return (
    `[Context: ~${usedTokens}/${limitTokens} tokens (${pct}%) | ` +
    `chunks: ${summary.total} tracked, ${summary.pruned} pruned, ~${activeTokens}t active]`
  );
}

/** Check for degenerate consecutive prune streaks. */
export function checkPruneStreak(
  consecutiveCount: number,
  batchSize: number,
  maxConsecutive: number,
): { shouldWarn: boolean; message: string | null } {
  if (consecutiveCount > maxConsecutive) {
    return {
      shouldWarn: true,
      message:
        `\u26A0\uFE0F You have called prune_chunks ${consecutiveCount} times in a row. ` +
        `Batch your pruning \u2014 pass all chunk ids in a single call instead of ` +
        `pruning one at a time.`,
    };
  }
  return { shouldWarn: false, message: null };
}

/** Check if usage is above hard cutoff threshold. */
export function hardThresholdCheck(
  usedTokens: number,
  limitTokens: number,
  threshold: number,
): { shouldBlock: boolean; message: string | null } {
  const pct = usedTokens / limitTokens;
  if (pct >= threshold) {
    const pctDisplay = Math.round(pct * 100);
    return {
      shouldBlock: true,
      message:
        `\u274C Context budget exhausted (${pctDisplay}%). ` +
        `Only list_context_chunks, prune_chunks, and restore_chunks are allowed. ` +
        `Prune chunks to free space, or end your response.`,
    };
  }
  return { shouldBlock: false, message: null };
}

/** Check if usage crosses the soft threshold and generate warning if so. */
export function softThresholdCheck(
  usedTokens: number,
  limitTokens: number,
  threshold: number,
  wasActive: boolean,
): { shouldWarn: boolean; isActive: boolean; message: string | null } {
  const pct = usedTokens / limitTokens;
  const isActive = pct >= threshold;

  if (isActive && !wasActive) {
    const pctDisplay = Math.round(pct * 100);
    return {
      shouldWarn: true,
      isActive: true,
      message:
        `\u26A0\uFE0F Context usage at ${pctDisplay}%. Consider pruning chunks with ` +
        `list_context_chunks + prune_chunks to free space, or provide your final answer.`,
    };
  }

  return { shouldWarn: false, isActive, message: null };
}

// ---------------------------------------------------------------------------
// ChunkTracker
// ---------------------------------------------------------------------------

export class ChunkTracker {
  private chunks = new Map<string, ToolChunk>();

  /** Catalogue a tool result chunk. */
  catalogue(
    toolCallId: string,
    toolName: string,
    content: Array<{ type: string; text?: string }>,
  ): ToolChunk | null {
    if (!PRUNEABLE_TOOLS.has(toolName)) return null;

    const text = contentText(content);
    if (!text || text.length < 20) return null;

    const chunk: ToolChunk = {
      id: toolCallId,
      toolName,
      timestamp: Date.now(),
      estTokens: estimateTokens(text),
      label: makeLabel(toolName, text),
      pruned: false,
      originalContent: content as Array<{ type: string; text: string }>,
    };

    this.chunks.set(toolCallId, chunk);
    return chunk;
  }

  /** Get a chunk by id. */
  get(id: string): ToolChunk | undefined {
    return this.chunks.get(id);
  }

  /** Prune chunks by id. Returns per-chunk results. */
  prune(ids: string[], reason?: string): PruneResult[] {
    const results: PruneResult[] = [];
    for (const id of ids) {
      const chunk = this.chunks.get(id);
      if (!chunk) {
        results.push({ id, status: "not_found", tokens: 0 });
        continue;
      }
      if (chunk.pruned) {
        results.push({ id, status: "already_pruned", tokens: 0 });
        continue;
      }
      chunk.pruned = true;
      chunk.pruneReason = reason;
      results.push({ id, status: "pruned", tokens: chunk.estTokens });
    }
    return results;
  }

  /** Restore previously pruned chunks. Returns per-chunk results. */
  restore(ids: string[]): RestoreResult[] {
    const results: RestoreResult[] = [];
    for (const id of ids) {
      const chunk = this.chunks.get(id);
      if (!chunk) {
        results.push({ id, status: "not_found", tokens: 0 });
        continue;
      }
      if (!chunk.pruned) {
        results.push({ id, status: "not_pruned", tokens: 0 });
        continue;
      }
      if (!chunk.originalContent || chunk.originalContent.length === 0) {
        results.push({ id, status: "content_lost", tokens: 0 });
        continue;
      }
      chunk.pruned = false;
      chunk.pruneReason = undefined;
      results.push({ id, status: "restored", tokens: chunk.estTokens });
    }
    return results;
  }

  /** List chunks with optional filters. */
  list(opts?: { toolName?: string; pruned?: boolean; limit?: number }): ListOutput {
    let entries = [...this.chunks.values()];

    if (opts?.toolName) {
      entries = entries.filter((c) => c.toolName === opts.toolName);
    }
    if (opts?.pruned !== undefined) {
      entries = entries.filter((c) => c.pruned === opts.pruned);
    }

    // Sort newest first
    entries.sort((a, b) => b.timestamp - a.timestamp);

    const limit = opts?.limit ?? 20;
    const sliced = entries.slice(0, limit);

    const totalTokens = [...this.chunks.values()].reduce((s, c) => s + c.estTokens, 0);
    const prunedTokens = [...this.chunks.values()]
      .filter((c) => c.pruned)
      .reduce((s, c) => s + c.estTokens, 0);

    return {
      totalChunks: this.chunks.size,
      totalTokens,
      prunedTokens,
      listed: sliced.length,
      chunks: sliced.map((c) => ({
        id: c.id,
        toolName: c.toolName,
        label: c.label,
        estTokens: c.estTokens,
        pruned: c.pruned,
        timestamp: c.timestamp,
      })),
    };
  }

  /** Get all pruned chunk ids (for context hook). */
  prunedIds(): Set<string> {
    const ids = new Set<string>();
    for (const chunk of this.chunks.values()) {
      if (chunk.pruned) ids.add(chunk.id);
    }
    return ids;
  }

  /** Get persistence metadata (no original content). */
  persistenceMeta(): Record<
    string,
    { id: string; toolName: string; label: string; pruned: boolean; pruneReason?: string }
  > {
    const meta: Record<
      string,
      { id: string; toolName: string; label: string; pruned: boolean; pruneReason?: string }
    > = {};
    for (const [id, chunk] of this.chunks) {
      meta[id] = {
        id: chunk.id,
        toolName: chunk.toolName,
        label: chunk.label,
        pruned: chunk.pruned,
        pruneReason: chunk.pruneReason,
      };
    }
    return meta;
  }

  /** Restore pruned set from persistence metadata. */
  restorePrunedSet(meta: Record<string, { pruned: boolean; pruneReason?: string }>): number {
    let count = 0;
    for (const [id, m] of Object.entries(meta)) {
      if (m.pruned) {
        const chunk = this.chunks.get(id);
        if (chunk) {
          chunk.pruned = true;
          chunk.pruneReason = m.pruneReason;
          count++;
        }
      }
    }
    return count;
  }

  /** Summary for /prune-status command. */
  statusSummary(): {
    total: number;
    pruned: number;
    totalTokens: number;
    prunedTokens: number;
    activeByTool: Record<string, { count: number; tokens: number }>;
  } {
    let pruned = 0;
    let totalTokens = 0;
    let prunedTokens = 0;
    const activeByTool: Record<string, { count: number; tokens: number }> = {};

    for (const chunk of this.chunks.values()) {
      totalTokens += chunk.estTokens;
      if (chunk.pruned) {
        pruned++;
        prunedTokens += chunk.estTokens;
      } else {
        const bucket = activeByTool[chunk.toolName] ?? { count: 0, tokens: 0 };
        bucket.count++;
        bucket.tokens += chunk.estTokens;
        activeByTool[chunk.toolName] = bucket;
      }
    }

    return {
      total: this.chunks.size,
      pruned,
      totalTokens,
      prunedTokens,
      activeByTool,
    };
  }

  /** Render list output as formatted text. */
  renderList(output: ListOutput): string {
    const lines = [
      `Tracked chunks: ${output.totalChunks} total, ~${output.totalTokens} tokens (${output.prunedTokens} pruned)`,
      "",
      "id                                   tool                   pruned  tokens  label",
    ];

    for (const chunk of output.chunks) {
      const id = chunk.id.slice(0, 36).padEnd(36);
      const tool = chunk.toolName.slice(0, 20).padEnd(20);
      const pruned = chunk.pruned ? "yes" : "no";
      const tokens = String(chunk.estTokens).padStart(6);
      const label = chunk.label.slice(0, 50);
      lines.push(`${id} ${tool} ${pruned.padStart(6)}  ${tokens}  ${label}`);
    }

    return lines.join("\n");
  }
}
