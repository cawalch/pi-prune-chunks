import { estimateTokens } from "./text";
import type {
  ChunkActionResult,
  ContextChunk,
  ContextTelemetryEvent,
  ContextUsage,
  PruneChunksConfig,
  RestoreMode,
  TelemetryEventType,
} from "./types";

export type TelemetrySnapshot = {
  generatedAt: number;
  policy: string;
  modelProfile: string;
  usage: ContextUsage | null | undefined;
  chunks: {
    totalChunks: number;
    prunedChunks: number;
    pinnedChunks: number;
    totalTokens: number;
    activeTokens: number;
    prunedTokens: number;
    activeByKind: Record<string, { count: number; tokens: number }>;
    activeByTool: Record<string, { count: number; tokens: number }>;
  };
  metrics: TelemetryMetrics;
};

export type TelemetryMetrics = {
  events: number;
  collectedChunks: number;
  collectedTokens: number;
  manualPrunes: number;
  manualPrunedTokens: number;
  autoPrunes: number;
  autoPrunedTokens: number;
  restores: number;
  restoredTokens: number;
  restoreAttempts: number;
  restoreHitRate: number;
  restoreByMode: Record<RestoreMode, number>;
  unavailableRestores: number;
  falsePositiveAutoPrunes: number;
  pins: number;
  unpins: number;
  tombstoneEvents: number;
  tombstoneTokens: number;
  coalescingEvents: number;
  coalescedChunks: number;
};

type ChunkSummary = TelemetrySnapshot["chunks"];

type PressureSample = {
  activeTokens: number;
  prunedTokens: number;
  totalTokens: number;
  timestamp: number;
};

export class TelemetryRecorder {
  private events: ContextTelemetryEvent[] = [];
  private counter = 0;
  private lastPressureSample?: PressureSample;

  recordCollected(chunk: ContextChunk, now = Date.now()): void {
    this.record({ type: "collect", chunkId: chunk.id, tokens: chunk.tokenEstimate }, now);
  }

  recordActionResults(
    type: Extract<TelemetryEventType, "manual_prune" | "auto_prune" | "pin" | "unpin">,
    results: ChunkActionResult[],
    reason?: string,
    now = Date.now(),
  ): void {
    for (const result of results) {
      if (!actionCounts(type, result.status)) continue;
      this.record(
        {
          type,
          chunkId: result.id,
          tokens: result.tokens,
          status: result.status,
          reason,
        },
        now,
      );
    }
  }

  recordRestoreResults(results: ChunkActionResult[], now = Date.now()): void {
    for (const result of results) {
      this.record(
        {
          type: "restore",
          chunkId: result.id,
          tokens: result.tokens,
          restoreMode: result.restoreMode,
          status: result.status,
          reason: result.reason,
        },
        now,
      );
    }
  }

  recordTombstones(
    input: { tombstoneTokens?: number; coalesced?: boolean; coalescedCount?: number },
    now = Date.now(),
  ): void {
    if (input.tombstoneTokens != null && input.tombstoneTokens > 0) {
      this.record({ type: "tombstone", tokens: input.tombstoneTokens }, now);
    }
    if (input.coalesced) {
      this.record({ type: "coalesce", count: input.coalescedCount ?? 0 }, now);
    }
  }

  pressureDelta(summary: ChunkSummary, now = Date.now()): string {
    const current: PressureSample = {
      activeTokens: summary.activeTokens,
      prunedTokens: summary.prunedTokens,
      totalTokens: summary.totalTokens,
      timestamp: now,
    };
    const previous = this.lastPressureSample;
    this.lastPressureSample = current;
    if (!previous) return "Telemetry delta: first pressure sample in this session.";
    const activeDelta = current.activeTokens - previous.activeTokens;
    const prunedDelta = current.prunedTokens - previous.prunedTokens;
    const totalDelta = current.totalTokens - previous.totalTokens;
    return `Telemetry delta: active ${formatDelta(activeDelta)}t, pruned ${formatDelta(
      prunedDelta,
    )}t, tracked ${formatDelta(totalDelta)}t since last pressure check.`;
  }

  snapshot(
    summary: ChunkSummary,
    config: PruneChunksConfig,
    usage?: ContextUsage | null,
    now = Date.now(),
  ): TelemetrySnapshot {
    return {
      generatedAt: now,
      policy: config.autoPrune.policy,
      modelProfile: config.autoPrune.modelProfile,
      usage,
      chunks: summary,
      metrics: computeMetrics(this.events),
    };
  }

  persistenceState(): ContextTelemetryEvent[] {
    return this.events.map((event) => ({ ...event }));
  }

  restorePersistence(events: ContextTelemetryEvent[] | undefined | null): void {
    this.events = Array.isArray(events) ? events.map((event) => ({ ...event })) : [];
    this.counter = this.events.reduce((max, event) => Math.max(max, counterFromId(event.id)), 0);
  }

  private record(
    event: Omit<ContextTelemetryEvent, "id" | "timestamp">,
    timestamp = Date.now(),
  ): void {
    this.counter += 1;
    this.events.push({
      id: `tel_${this.counter.toString(36).padStart(4, "0")}`,
      timestamp,
      ...event,
    });
    if (this.events.length > 2_000) this.events.splice(0, this.events.length - 2_000);
  }
}

export function computeMetrics(events: ContextTelemetryEvent[]): TelemetryMetrics {
  const metrics: TelemetryMetrics = {
    events: events.length,
    collectedChunks: 0,
    collectedTokens: 0,
    manualPrunes: 0,
    manualPrunedTokens: 0,
    autoPrunes: 0,
    autoPrunedTokens: 0,
    restores: 0,
    restoredTokens: 0,
    restoreAttempts: 0,
    restoreHitRate: 0,
    restoreByMode: { memory: 0, disk_cache: 0, source_rehydrate: 0, unavailable: 0 },
    unavailableRestores: 0,
    falsePositiveAutoPrunes: 0,
    pins: 0,
    unpins: 0,
    tombstoneEvents: 0,
    tombstoneTokens: 0,
    coalescingEvents: 0,
    coalescedChunks: 0,
  };
  const autoPruned = new Set<string>();
  const restoredAfterAutoPrune = new Set<string>();

  for (const event of events) {
    const tokens = event.tokens ?? 0;
    switch (event.type) {
      case "collect":
        metrics.collectedChunks += 1;
        metrics.collectedTokens += tokens;
        break;
      case "manual_prune":
        metrics.manualPrunes += 1;
        metrics.manualPrunedTokens += tokens;
        break;
      case "auto_prune":
        metrics.autoPrunes += 1;
        metrics.autoPrunedTokens += tokens;
        if (event.chunkId) autoPruned.add(event.chunkId);
        break;
      case "restore":
        metrics.restoreAttempts += 1;
        if (event.status === "restored") {
          metrics.restores += 1;
          metrics.restoredTokens += tokens;
          metrics.restoreByMode[event.restoreMode ?? "unavailable"] += 1;
          if (event.chunkId && autoPruned.has(event.chunkId))
            restoredAfterAutoPrune.add(event.chunkId);
        } else if (event.status === "unavailable" || event.restoreMode === "unavailable") {
          metrics.unavailableRestores += 1;
        }
        break;
      case "pin":
        metrics.pins += 1;
        break;
      case "unpin":
        metrics.unpins += 1;
        break;
      case "tombstone":
        metrics.tombstoneEvents += 1;
        metrics.tombstoneTokens += tokens;
        break;
      case "coalesce":
        metrics.coalescingEvents += 1;
        metrics.coalescedChunks += event.count ?? 0;
        break;
    }
  }

  metrics.falsePositiveAutoPrunes = restoredAfterAutoPrune.size;
  metrics.restoreHitRate =
    metrics.restoreAttempts === 0 ? 0 : metrics.restores / metrics.restoreAttempts;
  return metrics;
}

export function renderTelemetryReport(snapshot: TelemetrySnapshot): string {
  const usage = snapshot.usage;
  const usageText =
    usage?.tokens != null && usage.contextWindow
      ? `${usage.tokens}/${usage.contextWindow} (${Math.round(
          usage.percent ?? (usage.tokens / usage.contextWindow) * 100,
        )}%)`
      : "unknown";
  const lines = [
    "# Prune Chunks Telemetry Report",
    "",
    `Generated: ${new Date(snapshot.generatedAt).toISOString()}`,
    `Policy: ${snapshot.policy}`,
    `Model profile: ${snapshot.modelProfile}`,
    `Provider context: ${usageText}`,
    "",
    "## Chunk inventory",
    "",
    `- Total chunks: ${snapshot.chunks.totalChunks}`,
    `- Pinned chunks: ${snapshot.chunks.pinnedChunks}`,
    `- Active tokens: ~${snapshot.chunks.activeTokens}`,
    `- Pruned tokens: ~${snapshot.chunks.prunedTokens}`,
    `- Total tracked tokens: ~${snapshot.chunks.totalTokens}`,
    "",
    "## Session metrics",
    "",
    `- Collected chunks: ${snapshot.metrics.collectedChunks} (~${snapshot.metrics.collectedTokens}t)`,
    `- Auto-prunes: ${snapshot.metrics.autoPrunes} (~${snapshot.metrics.autoPrunedTokens}t)`,
    `- Manual prunes: ${snapshot.metrics.manualPrunes} (~${snapshot.metrics.manualPrunedTokens}t)`,
    `- Restores: ${snapshot.metrics.restores}/${snapshot.metrics.restoreAttempts} (${Math.round(
      snapshot.metrics.restoreHitRate * 100,
    )}% hit rate, ~${snapshot.metrics.restoredTokens}t)`,
    `- Restore modes: memory=${snapshot.metrics.restoreByMode.memory}, disk=${snapshot.metrics.restoreByMode.disk_cache}, source=${snapshot.metrics.restoreByMode.source_rehydrate}, unavailable=${snapshot.metrics.unavailableRestores}`,
    `- Restored after auto-prune: ${snapshot.metrics.falsePositiveAutoPrunes}`,
    `- Pins/unpins: ${snapshot.metrics.pins}/${snapshot.metrics.unpins}`,
    `- Tombstone overhead observed: ~${snapshot.metrics.tombstoneTokens}t across ${snapshot.metrics.tombstoneEvents} context rewrites`,
    `- Coalescing events: ${snapshot.metrics.coalescingEvents} (${snapshot.metrics.coalescedChunks} chunks coalesced)`,
    "",
    "## Active tokens by kind",
    "",
    ...renderBuckets(snapshot.chunks.activeByKind),
    "",
    "## Active tokens by tool",
    "",
    ...renderBuckets(snapshot.chunks.activeByTool),
    "",
    "Raw tool output is not included in telemetry.",
  ];
  return lines.join("\n");
}

export function telemetryTombstoneTokens(
  messages: Array<{ role: string; content?: unknown }>,
): number {
  const text = messages
    .filter((message) => message.role === "toolResult")
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .map((block) =>
      block && typeof block === "object" ? (block as { text?: unknown }).text : undefined,
    )
    .filter((text): text is string => typeof text === "string" && text.includes("[pruned"))
    .join("\n");
  return estimateTokens(text);
}

function renderBuckets(buckets: Record<string, { count: number; tokens: number }>): string[] {
  const entries = Object.entries(buckets).sort((a, b) => b[1].tokens - a[1].tokens);
  if (entries.length === 0) return ["- none"];
  return entries.map(([name, bucket]) => `- ${name}: ${bucket.count} chunks, ~${bucket.tokens}t`);
}

function actionCounts(type: TelemetryEventType, status: string): boolean {
  if (type === "pin") return status === "pinned";
  if (type === "unpin") return status === "unpinned";
  return status === "pruned";
}

function formatDelta(value: number): string {
  return value >= 0 ? `+${value}` : String(value);
}

function counterFromId(id: string): number {
  const match = /^tel_([0-9a-z]+)$/.exec(id);
  return match ? parseInt(match[1], 36) : 0;
}
