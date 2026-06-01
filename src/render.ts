import type { PruneCandidate } from "./pruner";
import { contextPercent, pressureSummary } from "./pruner";
import type { ChunkRegistry } from "./registry";
import type {
  ChunkActionResult,
  ChunkListOutput,
  ContextUsage,
  PreserveContext,
  PruneChunksConfig,
} from "./types";

export function renderChunkList(output: ChunkListOutput): string {
  if (output.chunks.length === 0) {
    return "No tracked chunks found.";
  }

  const lines = [
    `Tracked chunks: ${output.totalChunks} total, ~${output.totalTokens}t tracked, ~${output.prunedTokens}t pruned`,
    "",
    "id              kind          risk    pin prune tokens label",
  ];

  for (const chunk of output.chunks) {
    lines.push(
      [
        chunk.id.padEnd(15),
        chunk.kind.padEnd(13),
        chunk.risk.padEnd(7),
        (chunk.pinned ? "yes" : "no ").padEnd(3),
        (chunk.pruned ? "yes" : "no ").padEnd(5),
        String(chunk.tokenEstimate).padStart(6),
        chunk.label,
      ].join(" "),
    );
  }

  return lines.join("\n");
}

export function renderActionResults(
  action: string,
  ids: string[],
  results: ChunkActionResult[],
): string {
  const changed = results.filter((result) => result.status === action).length;
  const tokens = results.reduce((sum, result) => sum + result.tokens, 0);
  const lines = [
    `${capitalize(action)} ${changed}/${ids.length} chunks, ~${tokens} tokens affected`,
    "",
  ];
  for (const result of results) {
    const detail = result.reason ? ` (${result.reason})` : "";
    const mode = result.restoreMode ? ` via ${result.restoreMode}` : "";
    lines.push(`  ${result.id}: ${result.status}${mode} (~${result.tokens}t)${detail}`);
  }
  return lines.join("\n");
}

export function renderPressure(
  registry: ChunkRegistry,
  usage: ContextUsage | null | undefined,
  config: PruneChunksConfig,
  preserve?: PreserveContext,
): string {
  const pressure = pressureSummary(registry, usage, config, preserve);
  const pct = pressure.autoPrune.currentPercent;
  const providerTokens =
    usage?.tokens != null && usage.contextWindow != null
      ? ` (~${usage.tokens}/${usage.contextWindow} provider tokens)`
      : "";
  const lines = [
    `Context pressure: ${pct == null ? "unknown" : `${Math.round(pct)}%${providerTokens}`}`,
    `Active chunk tokens: ~${pressure.estimatedActiveChunkTokens}`,
    `Pruned chunk tokens: ~${pressure.estimatedPrunedTokens}`,
    `Auto-prune: ${pressure.autoPrune.enabled ? "enabled" : "disabled"} start=${pressure.autoPrune.startAtPercent}% target=${pressure.autoPrune.targetPercent}%`,
  ];

  if (pressure.autoPrune.nonChunkTokens != null) {
    const bestPossible =
      pressure.autoPrune.bestPossiblePercent == null
        ? "unknown"
        : `${Math.round(pressure.autoPrune.bestPossiblePercent)}%`;
    lines.push(
      `Non-chunk tokens: ~${pressure.autoPrune.nonChunkTokens}; best possible after chunk pruning: ${bestPossible}`,
    );
    if (pressure.autoPrune.targetReachableByChunks === false) {
      lines.push("Auto-prune target cannot be reached by pruning tracked chunks alone.");
    }
  }

  if (pressure.recommendedCandidates.length > 0) {
    lines.push("", "Recommended prune candidates:");
    for (const candidate of pressure.recommendedCandidates.slice(0, 5)) {
      lines.push(renderCandidate(candidate));
    }
  }

  if (pressure.blockedCandidates.length > 0) {
    lines.push("", "Protected active chunks:");
    for (const candidate of pressure.blockedCandidates.slice(0, 5)) {
      lines.push(
        `  ${candidate.id}: ${candidate.kind}/${candidate.risk} ~${candidate.tokenEstimate}t ${candidate.label}; ${candidate.reason}`,
      );
    }
  }

  return lines.join("\n");
}

export function renderCandidates(candidates: PruneCandidate[]): string {
  if (candidates.length === 0) return "No safe prune candidates found.";
  return candidates.map(renderCandidate).join("\n");
}

export function contextFooter(
  registry: ChunkRegistry,
  usage: ContextUsage | null | undefined,
): string {
  const summary = registry.summary();
  const pct = contextPercent(usage);
  const tokenStr = usage?.tokens != null ? `~${usage.tokens}` : "?";
  const windowStr = usage?.contextWindow != null ? String(usage.contextWindow) : "?";
  const pctStr = pct == null ? "?%" : `${Math.round(pct)}%`;
  return (
    `[Context: ${tokenStr}/${windowStr} (${pctStr}) | ` +
    `chunks: ${summary.totalChunks} tracked, ${summary.prunedChunks} pruned, ` +
    `~${summary.activeTokens}t active]`
  );
}

function renderCandidate(candidate: PruneCandidate): string {
  const reasons = candidate.reasons.length > 0 ? `; ${candidate.reasons.join(", ")}` : "";
  return `  ${candidate.id}: ${candidate.kind}/${candidate.risk} ~${candidate.tokenEstimate}t ${candidate.label}${reasons}`;
}

function capitalize(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}
