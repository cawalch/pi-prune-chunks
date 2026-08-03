import type { RetirementCandidate } from "./pruner";
import { activeToolBudget, contextPercent } from "./pruner";
import type { ChunkRegistry } from "./registry";
import type { ChunkActionResult, ChunkListOutput, ContextUsage, PruneChunksConfig } from "./types";

export function renderChunkList(output: ChunkListOutput): string {
  if (output.chunks.length === 0) return "No tracked chunks found.";
  const lines = [
    `Tracked chunks: ${output.totalChunks} total, ~${output.activeTokens}t active, ~${output.prunedTokens}t retired`,
    "",
    "id                 kind          risk    state    tokens restore          label",
  ];
  for (const chunk of output.chunks) {
    lines.push(
      [
        chunk.id.padEnd(18),
        chunk.kind.padEnd(13),
        chunk.risk.padEnd(7),
        (chunk.pruned ? "retired" : "active").padEnd(8),
        String(chunk.tokenEstimate).padStart(6),
        restoreLabel(chunk).padEnd(16),
        labelWithScope(chunk),
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
  const changedStatus = action === "restored" ? "restored" : "pruned";
  const changed = results.filter((result) => result.status === changedStatus).length;
  const tokens = results.reduce((sum, result) => sum + result.tokens, 0);
  const lines = [
    `${capitalize(action)} ${changed}/${ids.length} chunks, ~${tokens} tokens affected`,
    "",
  ];
  for (const result of results) {
    const reason = result.reason ? ` (${result.reason})` : "";
    const mode = result.restoreMode ? ` via ${result.restoreMode}` : "";
    lines.push(`  ${result.id}: ${result.status}${mode} (~${result.tokens}t)${reason}`);
  }
  return lines.join("\n");
}

export function renderCandidates(candidates: RetirementCandidate[]): string {
  if (candidates.length === 0) return "No safe retirement candidates found.";
  return candidates
    .map(
      (item) =>
        `  ${item.id}: ${item.kind}/${item.risk} ~${item.tokenEstimate}t ${item.label}; ${item.reason}`,
    )
    .join("\n");
}

export function renderStatus(
  registry: ChunkRegistry,
  usage: ContextUsage | null | undefined,
  config: PruneChunksConfig,
): string {
  const summary = registry.summary();
  const budget = activeToolBudget(usage?.contextWindow, config);
  const percent = contextPercent(usage);
  const provider =
    usage?.tokens != null && usage.contextWindow
      ? `~${usage.tokens}/${usage.contextWindow} (${percent == null ? "?" : Math.round(percent)}%)`
      : "unknown";
  return [
    `Provider context: ${provider}`,
    `Tool-output working set: ~${summary.activeTokens}/${budget} tokens`,
    `Tracked: ${summary.totalChunks}; retired: ${summary.prunedChunks} (~${summary.prunedTokens}t)`,
    `Budget: clamp(window × ${config.budget.windowFraction}, ${config.budget.minTokens}, ${config.budget.maxTokens})`,
    `Emergency headroom: ${config.emergency.minResponseHeadroomTokens} tokens; Pi owns compaction`,
  ].join("\n");
}

export function contextFooter(
  registry: ChunkRegistry,
  usage: ContextUsage | null | undefined,
  config: PruneChunksConfig,
): string {
  const summary = registry.summary();
  const budget = activeToolBudget(usage?.contextWindow, config);
  const percent = contextPercent(usage);
  return `[Context: ${percent == null ? "?" : Math.round(percent)}% | tool output: ~${summary.activeTokens}/${budget}t | retired: ${summary.prunedChunks}]`;
}

function labelWithScope(chunk: ChunkListOutput["chunks"][number]): string {
  const markers: string[] = [];
  if (chunk.part) markers.push(`part:${chunk.part.role}`);
  if (chunk.scope && chunk.scope.scope !== "main") markers.push(`scope:${chunk.scope.scope}`);
  return markers.length > 0 ? `${chunk.label} [${markers.join(" ")}]` : chunk.label;
}

function restoreLabel(chunk: ChunkListOutput["chunks"][number]): string {
  if (chunk.restoreAvailable) return chunk.restoreMode;
  return chunk.restoreUnavailableReason
    ? `unavailable: ${chunk.restoreUnavailableReason}`
    : "unavailable";
}

function capitalize(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}
