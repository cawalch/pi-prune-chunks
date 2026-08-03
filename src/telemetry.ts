import type { ChunkActionResult, ContextChunk, ContextUsage, RestoreMode } from "./types";

type ChunkSummary = {
  totalChunks: number;
  prunedChunks: number;
  pinnedChunks: number;
  totalTokens: number;
  activeTokens: number;
  prunedTokens: number;
  activeByKind: Record<string, { count: number; tokens: number }>;
  activeByTool: Record<string, { count: number; tokens: number }>;
  prunedByKind?: Record<string, { count: number; tokens: number }>;
  prunedByTool?: Record<string, { count: number; tokens: number }>;
  restoreByMode?: Record<string, { count: number; tokens: number }>;
};

export type HygieneMetrics = {
  collectedChunks: number;
  collectedTokens: number;
  automaticRetirements: number;
  automaticRetiredTokens: number;
  manualRetirements: number;
  manualRetiredTokens: number;
  retirementsByCause: Record<string, { count: number; tokens: number }>;
  restores: number;
  restoreAttempts: number;
  restoredTokens: number;
  restoreByMode: Record<RestoreMode, number>;
  contextPasses: number;
  rewrittenPasses: number;
  removedExchanges: number;
  fallbackMarkers: number;
  partialMarkers: number;
  effectiveTokensSaved: number;
  rewriteDurationMs: number;
  archiveDurationMs: number;
  compactions: number;
};

export type TelemetrySnapshot = {
  generatedAt: number;
  usage: ContextUsage | null | undefined;
  chunks: ChunkSummary;
  metrics: HygieneMetrics;
};

export class TelemetryRecorder {
  private metrics: HygieneMetrics = emptyMetrics();

  recordCollected(chunk: ContextChunk): void {
    this.metrics.collectedChunks += 1;
    this.metrics.collectedTokens += chunk.tokenEstimate;
  }

  recordRetirements(results: ChunkActionResult[], automatic: boolean, cause: string): void {
    const retired = results.filter((result) => result.status === "pruned");
    if (retired.length === 0) return;
    const tokens = retired.reduce((sum, result) => sum + result.tokens, 0);
    if (automatic) {
      this.metrics.automaticRetirements += retired.length;
      this.metrics.automaticRetiredTokens += tokens;
    } else {
      this.metrics.manualRetirements += retired.length;
      this.metrics.manualRetiredTokens += tokens;
    }
    const bucket = this.metrics.retirementsByCause[cause] ?? { count: 0, tokens: 0 };
    bucket.count += retired.length;
    bucket.tokens += tokens;
    this.metrics.retirementsByCause[cause] = bucket;
  }

  recordRestoreResults(results: ChunkActionResult[]): void {
    for (const result of results) {
      this.metrics.restoreAttempts += 1;
      if (result.status !== "restored") continue;
      this.metrics.restores += 1;
      this.metrics.restoredTokens += result.tokens;
      this.metrics.restoreByMode[result.restoreMode ?? "unavailable"] += 1;
    }
  }

  recordContextPass(input: {
    durationMs: number;
    modified: boolean;
    removedExchanges: number;
    fallbackMarkers: number;
    partialMarkers: number;
    effectiveTokensSaved: number;
  }): void {
    this.metrics.contextPasses += 1;
    this.metrics.rewriteDurationMs += input.durationMs;
    if (input.modified) this.metrics.rewrittenPasses += 1;
    this.metrics.removedExchanges += input.removedExchanges;
    this.metrics.fallbackMarkers += input.fallbackMarkers;
    this.metrics.partialMarkers += input.partialMarkers;
    this.metrics.effectiveTokensSaved += input.effectiveTokensSaved;
  }

  recordArchiveDuration(durationMs: number): void {
    this.metrics.archiveDurationMs += durationMs;
  }

  recordCompaction(): void {
    this.metrics.compactions += 1;
  }

  snapshot(
    summary: ChunkSummary,
    usage?: ContextUsage | null,
    now = Date.now(),
  ): TelemetrySnapshot {
    return { generatedAt: now, usage, chunks: summary, metrics: cloneMetrics(this.metrics) };
  }

  reset(): void {
    this.metrics = emptyMetrics();
  }
}

export function renderTelemetryReport(snapshot: TelemetrySnapshot): string {
  const usage = snapshot.usage;
  const usageText =
    usage?.tokens != null && usage.contextWindow
      ? `${usage.tokens}/${usage.contextWindow} (${Math.round(
          usage.percent ?? (usage.tokens / usage.contextWindow) * 100,
        )}%)`
      : "unknown";
  const averageRewrite =
    snapshot.metrics.contextPasses === 0
      ? 0
      : snapshot.metrics.rewriteDurationMs / snapshot.metrics.contextPasses;
  return [
    "# Prune Chunks v0.2 Hygiene Report",
    "",
    `Generated: ${new Date(snapshot.generatedAt).toISOString()}`,
    `Provider context: ${usageText}`,
    "",
    "## Working set",
    "",
    `- Tracked chunks: ${snapshot.chunks.totalChunks}`,
    `- Active tool tokens: ~${snapshot.chunks.activeTokens}`,
    `- Retired tool tokens: ~${snapshot.chunks.prunedTokens}`,
    "",
    "## Activity",
    "",
    `- Collected: ${snapshot.metrics.collectedChunks} chunks (~${snapshot.metrics.collectedTokens}t)`,
    `- Automatic retirements: ${snapshot.metrics.automaticRetirements} (~${snapshot.metrics.automaticRetiredTokens}t)`,
    `- Manual retirements: ${snapshot.metrics.manualRetirements} (~${snapshot.metrics.manualRetiredTokens}t)`,
    `- Causes: ${renderCauses(snapshot.metrics.retirementsByCause)}`,
    `- Restores: ${snapshot.metrics.restores}/${snapshot.metrics.restoreAttempts} (~${snapshot.metrics.restoredTokens}t)`,
    `- Provider exchanges removed: ${snapshot.metrics.removedExchanges}`,
    `- Effective provider tokens saved: ~${snapshot.metrics.effectiveTokensSaved}`,
    `- Neutral fallbacks/partial markers: ${snapshot.metrics.fallbackMarkers}/${snapshot.metrics.partialMarkers}`,
    `- Context rewrites: ${snapshot.metrics.rewrittenPasses}/${snapshot.metrics.contextPasses}; average hook ${averageRewrite.toFixed(2)}ms`,
    `- Archive time: ${snapshot.metrics.archiveDurationMs.toFixed(2)}ms`,
    `- Pi compactions observed: ${snapshot.metrics.compactions}`,
    "",
    "Raw tool output is not included in telemetry.",
  ].join("\n");
}

function emptyMetrics(): HygieneMetrics {
  return {
    collectedChunks: 0,
    collectedTokens: 0,
    automaticRetirements: 0,
    automaticRetiredTokens: 0,
    manualRetirements: 0,
    manualRetiredTokens: 0,
    retirementsByCause: {},
    restores: 0,
    restoreAttempts: 0,
    restoredTokens: 0,
    restoreByMode: { memory: 0, disk_cache: 0, source_rehydrate: 0, unavailable: 0 },
    contextPasses: 0,
    rewrittenPasses: 0,
    removedExchanges: 0,
    fallbackMarkers: 0,
    partialMarkers: 0,
    effectiveTokensSaved: 0,
    rewriteDurationMs: 0,
    archiveDurationMs: 0,
    compactions: 0,
  };
}

function cloneMetrics(metrics: HygieneMetrics): HygieneMetrics {
  return {
    ...metrics,
    restoreByMode: { ...metrics.restoreByMode },
    retirementsByCause: Object.fromEntries(
      Object.entries(metrics.retirementsByCause).map(([cause, bucket]) => [cause, { ...bucket }]),
    ),
  };
}

function renderCauses(causes: HygieneMetrics["retirementsByCause"]): string {
  const entries = Object.entries(causes);
  if (entries.length === 0) return "none";
  return entries.map(([cause, bucket]) => `${cause}=${bucket.count}/~${bucket.tokens}t`).join(", ");
}
