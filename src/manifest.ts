import { chunkReasoningAnchors } from "./anchors";
import { compactDecisionCard } from "./cards";
import { contextPercent } from "./pruner";
import type { ChunkRegistry } from "./registry";
import type {
  ContextChunk,
  ContextUsage,
  ContinuationManifest,
  ContinuationManifestEntry,
  PreserveContext,
  PruneChunksConfig,
  TaskStateSummary,
} from "./types";

export type ContinuationPrepResult = {
  manifest?: ContinuationManifest;
  pinnedIds: string[];
  prepared: boolean;
};

export function isCompactionImminent(
  usage: ContextUsage | null | undefined,
  config: PruneChunksConfig,
): boolean {
  const pct = contextPercent(usage);
  if (pct != null && pct >= config.tombstones.compactAtPercent) return true;
  return !!usage?.contextWindow && usage.tokens != null && usage.tokens >= usage.contextWindow;
}

export function prepareContinuationManifest(
  registry: ChunkRegistry,
  usage: ContextUsage | null | undefined,
  config: PruneChunksConfig,
  preserve?: PreserveContext,
  now = Date.now(),
): ContinuationPrepResult {
  if (!isCompactionImminent(usage, config)) return { prepared: false, pinnedIds: [] };

  const manifest = buildContinuationManifest(registry, usage, config, preserve, now);
  const pinnedIds = manifest.pinnedChunkIds.filter((id) => !registry.get(id)?.pinned);
  if (pinnedIds.length > 0) {
    registry.pin(pinnedIds, `continuation manifest ${manifest.id}`);
  }
  return { prepared: true, manifest, pinnedIds };
}

export function buildContinuationManifest(
  registry: ChunkRegistry,
  usage: ContextUsage | null | undefined,
  config: PruneChunksConfig,
  preserve?: PreserveContext,
  now = Date.now(),
): ContinuationManifest {
  const active = registry.active();
  const pruned = registry.all().filter((chunk) => chunk.pruned);
  const modifiedPaths = [...(preserve?.paths ?? new Set<string>())].sort();
  const pinnedChunkIds = active
    .filter((chunk) => shouldPinForContinuation(chunk, preserve))
    .sort((a, b) => highValueScore(b, preserve) - highValueScore(a, preserve))
    .slice(0, 12)
    .map((chunk) => chunk.id);
  const activeEntries = active
    .filter((chunk) => isManifestWorthy(chunk, preserve))
    .sort((a, b) => highValueScore(b, preserve) - highValueScore(a, preserve))
    .slice(0, 8)
    .map((chunk) => manifestEntry(chunk, "active"));
  const prunedHighValue = pruned
    .filter((chunk) => isManifestWorthy(chunk, preserve) || chunk.risk !== "low")
    .sort((a, b) => highValueScore(b, preserve) - highValueScore(a, preserve))
    .slice(0, 8)
    .map((chunk) => manifestEntry(chunk, "pruned"));
  const unresolvedFailures = active
    .filter(isFailureLike)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 5)
    .map((chunk) => manifestEntry(chunk, "active"));
  const recentRestores = registry
    .all()
    .filter((chunk) => chunk.lastRestoredAt != null)
    .sort((a, b) => (b.lastRestoredAt ?? 0) - (a.lastRestoredAt ?? 0))
    .slice(0, 5)
    .map((chunk) => manifestEntry(chunk, chunk.pruned ? "pruned" : "active"));

  return {
    id: `cm_${now.toString(36)}`,
    generatedAt: now,
    reason: "provider context near compaction threshold",
    pressurePercent: contextPercent(usage),
    policy: config.autoPrune.policy,
    modelProfile: config.autoPrune.modelProfile,
    modifiedPaths,
    pinnedChunkIds,
    taskState: buildTaskStateSummary({
      active,
      prunedHighValue,
      unresolvedFailures,
      modifiedPaths,
      pinnedChunkIds,
    }),
    active: activeEntries,
    prunedHighValue,
    unresolvedFailures,
    recentRestores,
  };
}

export function renderContinuationManifestPreview(
  manifest: ContinuationManifest | undefined,
): string {
  if (!manifest) return "Continuation manifest: none prepared.";
  const pct =
    manifest.pressurePercent == null ? "unknown" : `${Math.round(manifest.pressurePercent)}%`;
  const lines = [
    `Continuation manifest: ${manifest.id} (${pct}, ${manifest.policy}/${manifest.modelProfile})`,
    `  prepared: ${new Date(manifest.generatedAt).toISOString()}; reason: ${manifest.reason}`,
    `  pinned for carry-forward: ${manifest.pinnedChunkIds.length > 0 ? manifest.pinnedChunkIds.join(", ") : "none"}`,
  ];
  if (manifest.modifiedPaths.length > 0) {
    lines.push(`  modified/mentioned paths: ${manifest.modifiedPaths.slice(0, 6).join(", ")}`);
  }
  const taskState = manifest.taskState ?? legacyTaskStateSummary(manifest);
  lines.push("  task state:");
  lines.push(`    - ${taskState.headline}`);
  for (const line of compactTaskStateLines(taskState)) lines.push(`    - ${line}`);
  if (manifest.active.length > 0) {
    lines.push("  active working set:");
    for (const entry of manifest.active.slice(0, 5)) lines.push(`    - ${entryLine(entry)}`);
  }
  if (manifest.prunedHighValue.length > 0) {
    lines.push("  restorable pruned evidence:");
    for (const entry of manifest.prunedHighValue.slice(0, 5))
      lines.push(`    - ${entryLine(entry)}`);
  }
  if (manifest.unresolvedFailures.length > 0) {
    lines.push("  unresolved failures/tests:");
    for (const entry of manifest.unresolvedFailures.slice(0, 3))
      lines.push(`    - ${entryLine(entry)}`);
  }
  if (manifest.recentRestores.length > 0) {
    lines.push("  recent restores:");
    for (const entry of manifest.recentRestores.slice(0, 3))
      lines.push(`    - ${entryLine(entry)}`);
  }
  return lines.join("\n");
}

function buildTaskStateSummary(input: {
  active: ContextChunk[];
  prunedHighValue: ContinuationManifestEntry[];
  unresolvedFailures: ContinuationManifestEntry[];
  modifiedPaths: string[];
  pinnedChunkIds: string[];
}): TaskStateSummary {
  const changedFiles = uniqueStrings(
    input.active
      .filter((chunk) => chunk.kind === "diff")
      .flatMap(
        (chunk) =>
          chunk.decisionCard?.sourceAnchors ?? (chunk.source?.path ? [chunk.source.path] : []),
      ),
  ).slice(0, 6);
  const activePaths = uniqueStrings([...input.modifiedPaths, ...changedFiles]).slice(0, 8);
  const reasoningAnchors = uniqueStrings(
    input.active.flatMap((chunk) => chunkReasoningAnchors(chunk)),
  ).slice(0, 8);
  const protectedChunks = input.pinnedChunkIds.slice(0, 6);
  const openFailures = input.unresolvedFailures
    .map((entry) => entrySummary(entry))
    .filter(Boolean)
    .slice(0, 5);
  const restoreHints = input.prunedHighValue
    .filter((entry) => entry.restoreHint)
    .map((entry) => entrySummary(entry))
    .slice(0, 5);

  return {
    headline:
      `${activePaths.length} active path${activePaths.length === 1 ? "" : "s"}, ` +
      `${openFailures.length} open failure${openFailures.length === 1 ? "" : "s"}, ` +
      `${changedFiles.length} changed-file hint${changedFiles.length === 1 ? "" : "s"}, ` +
      `${reasoningAnchors.length} reasoning anchor${reasoningAnchors.length === 1 ? "" : "s"}, ` +
      `${restoreHints.length} restore hint${restoreHints.length === 1 ? "" : "s"}`,
    activePaths,
    openFailures,
    changedFiles,
    reasoningAnchors,
    protectedChunks,
    restoreHints,
  };
}

function legacyTaskStateSummary(manifest: ContinuationManifest): TaskStateSummary {
  return {
    headline:
      `${manifest.modifiedPaths.length} active path${manifest.modifiedPaths.length === 1 ? "" : "s"}, ` +
      `${manifest.unresolvedFailures.length} open failure${manifest.unresolvedFailures.length === 1 ? "" : "s"}, ` +
      "legacy manifest without task-state details",
    activePaths: manifest.modifiedPaths.slice(0, 8),
    openFailures: manifest.unresolvedFailures.map((entry) => entrySummary(entry)).slice(0, 5),
    changedFiles: [],
    reasoningAnchors: [],
    protectedChunks: manifest.pinnedChunkIds.slice(0, 6),
    restoreHints: manifest.prunedHighValue
      .filter((entry) => entry.restoreHint)
      .map((entry) => entrySummary(entry))
      .slice(0, 5),
  };
}

function compactTaskStateLines(taskState: TaskStateSummary): string[] {
  const lines: string[] = [];
  if (taskState.activePaths.length > 0) {
    lines.push(`active paths: ${taskState.activePaths.slice(0, 5).join(", ")}`);
  }
  if (taskState.openFailures.length > 0) {
    lines.push(`open failures: ${taskState.openFailures.slice(0, 3).join("; ")}`);
  }
  if (taskState.reasoningAnchors.length > 0) {
    lines.push(`reasoning anchors: ${taskState.reasoningAnchors.slice(0, 6).join(", ")}`);
  }
  if (taskState.protectedChunks.length > 0) {
    lines.push(`protected chunks: ${taskState.protectedChunks.slice(0, 6).join(", ")}`);
  }
  if (taskState.restoreHints.length > 0) {
    lines.push(`restore hints: ${taskState.restoreHints.slice(0, 3).join("; ")}`);
  }
  return lines;
}

function manifestEntry(
  chunk: ContextChunk,
  status: "active" | "pruned",
): ContinuationManifestEntry {
  return {
    id: chunk.id,
    label: chunk.label,
    kind: chunk.kind,
    risk: chunk.risk,
    tokenEstimate: chunk.tokenEstimate,
    status,
    card: chunk.decisionCard ? compactDecisionCard(chunk.decisionCard, 140) : chunk.summary,
    restoreHint: chunk.pruned ? `restore_chunks({ids:['${chunk.id}']})` : undefined,
    sourceAnchors: chunk.decisionCard?.sourceAnchors,
  };
}

function shouldPinForContinuation(chunk: ContextChunk, preserve?: PreserveContext): boolean {
  if (chunk.pruned || chunk.pinned) return false;
  if (chunk.risk === "high") return true;
  if (chunk.kind === "diff") return true;
  if (isFailureLike(chunk)) return true;
  if (chunk.source?.path && preserve?.paths?.has(normalizePath(chunk.source.path))) return true;
  return false;
}

function isManifestWorthy(chunk: ContextChunk, preserve?: PreserveContext): boolean {
  if (chunk.risk === "high") return true;
  if (chunk.kind === "diff" || chunk.kind === "test_output" || chunk.kind === "context_pack")
    return true;
  if (chunk.lastRestoredAt != null) return true;
  if (chunk.source?.path && preserve?.paths?.has(normalizePath(chunk.source.path))) return true;
  return false;
}

function isFailureLike(chunk: ContextChunk): boolean {
  if (chunk.kind !== "test_output") return false;
  if (chunk.risk === "high") return true;
  const text = `${chunk.label}\n${chunk.summary ?? ""}\n${chunk.decisionCard?.evidence.join("\n") ?? ""}`;
  return /\b(FAIL|failed|error|AssertionError|Traceback)\b/i.test(text);
}

function highValueScore(chunk: ContextChunk, preserve?: PreserveContext): number {
  let score = chunk.tokenEstimate;
  if (chunk.risk === "high") score += 5_000;
  if (chunk.kind === "diff") score += 2_000;
  if (isFailureLike(chunk)) score += 2_000;
  if (chunk.kind === "context_pack") score += 1_000;
  if (chunk.lastRestoredAt != null) score += 1_000 + (chunk.restoreCount ?? 0) * 250;
  if (chunk.source?.path && preserve?.paths?.has(normalizePath(chunk.source.path))) score += 2_000;
  if (chunk.pruned && chunk.restoreAvailable) score += 500;
  return score;
}

function entryLine(entry: ContinuationManifestEntry): string {
  const restore = entry.restoreHint ? `; ${entry.restoreHint}` : "";
  const card = entry.card ? `; ${entry.card}` : "";
  return `${entry.id} ${entry.kind}/${entry.risk} ${entry.status} ~${entry.tokenEstimate}t ${entry.label}${restore}${card}`;
}

function entrySummary(entry: ContinuationManifestEntry): string {
  const restore = entry.restoreHint ? `; ${entry.restoreHint}` : "";
  const card = entry.card ? `; ${entry.card}` : "";
  return `${entry.id} ${entry.kind}/${entry.risk} ${entry.label}${restore}${card}`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}
