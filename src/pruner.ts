import { matchingReasoningAnchor } from "./anchors";
import { isReamerxExploratoryTool, isReamerxTerminalTool } from "./collector";
import type { ChunkRegistry } from "./registry";
import type {
  ChunkActionResult,
  ContextChunk,
  ContextUsage,
  PreserveContext,
  PruneChunksConfig,
} from "./types";

export type PruneCandidate = {
  id: string;
  label: string;
  kind: string;
  risk: string;
  tokenEstimate: number;
  score: number;
  confidence: "low" | "medium" | "high";
  policy: "heuristic-v1" | "adaptive-v1";
  reasons: string[];
};

export type BlockedPruneCandidate = {
  id: string;
  label: string;
  kind: string;
  risk: string;
  tokenEstimate: number;
  reason: string;
};

export type AutoPruneResult = {
  triggered: boolean;
  pruned: ChunkActionResult[];
  savedTokens: number;
  reason?: string;
};

export type SupersededPruneResult = {
  pruned: ChunkActionResult[];
  savedTokens: number;
};

export type ReamerxTerminalPruneResult = {
  triggered: boolean;
  pruned: ChunkActionResult[];
  savedTokens: number;
};

type PressureBand = "normal" | "high" | "extreme";

type TaskPhase = "exploration" | "editing" | "verification";

type SessionSignals = {
  pressureBand: PressureBand;
  taskPhase: TaskPhase;
  modelProfile: PruneChunksConfig["autoPrune"]["modelProfile"];
  subagentManifestScopes: Set<string>;
};

export function contextPercent(usage?: ContextUsage | null): number | null {
  if (!usage) return null;
  if (usage.percent != null) return usage.percent;
  if (usage.tokens != null && usage.contextWindow) {
    return (usage.tokens / usage.contextWindow) * 100;
  }
  return null;
}

export function suggestPruneCandidates(
  registry: ChunkRegistry,
  config: PruneChunksConfig,
  options: {
    now?: number;
    limit?: number;
    preserve?: PreserveContext;
    pressurePercent?: number | null;
  } = {},
): PruneCandidate[] {
  const now = options.now ?? Date.now();
  const active = registry.active();
  const signals = inferSessionSignals(active, config, options.pressurePercent);
  const recentProtected = recentChunkIds(
    active,
    protectedRecentChunkCount(config, options.pressurePercent),
  );
  const duplicateHashes = duplicateContentHashes(active);
  const candidates: PruneCandidate[] = [];

  for (const chunk of active) {
    if (!chunk.part && registry.hasChildren(chunk.id)) continue;
    const blockedReason = autoPruneBlockedReason(
      chunk,
      config,
      now,
      recentProtected,
      options.preserve,
      options.pressurePercent,
    );
    if (blockedReason) continue;
    candidates.push(scoreCandidate(chunk, now, duplicateHashes, config, signals));
  }

  candidates.sort((a, b) => b.score - a.score || b.tokenEstimate - a.tokenEstimate);
  return candidates.slice(0, Math.max(0, options.limit ?? config.autoPrune.maxChunksPerPass));
}

export function autoPrune(
  registry: ChunkRegistry,
  usage: ContextUsage | null | undefined,
  config: PruneChunksConfig,
  options: { now?: number; preserve?: PreserveContext } = {},
): AutoPruneResult {
  if (!config.autoPrune.enabled) return { triggered: false, pruned: [], savedTokens: 0 };

  const pct = contextPercent(usage);
  if (pct == null || pct < config.autoPrune.startAtPercent) {
    return { triggered: false, pruned: [], savedTokens: 0 };
  }
  if (usage?.tokens == null || !usage.contextWindow) {
    return { triggered: false, pruned: [], savedTokens: 0 };
  }

  const targetTokens = Math.floor(usage.contextWindow * (config.autoPrune.targetPercent / 100));
  const targetSavings = Math.max(0, usage.tokens - targetTokens);
  if (targetSavings <= 0) return { triggered: false, pruned: [], savedTokens: 0 };

  const candidates = suggestPruneCandidates(registry, config, {
    now: options.now,
    limit: config.autoPrune.maxChunksPerPass,
    preserve: options.preserve,
    pressurePercent: pct,
  });

  const ids: string[] = [];
  let estimatedSavings = 0;
  for (const candidate of candidates) {
    ids.push(candidate.id);
    estimatedSavings += candidate.tokenEstimate;
    if (estimatedSavings >= targetSavings) break;
  }

  if (ids.length === 0) {
    return {
      triggered: true,
      pruned: [],
      savedTokens: 0,
      reason: `context at ${Math.round(pct)}%, no safe auto-prune candidates`,
    };
  }

  const reason = `auto-prune: context at ${Math.round(pct)}%, target ${config.autoPrune.targetPercent}%`;
  const pruned = registry.prune(ids, reason, "auto_pruned");
  return {
    triggered: true,
    pruned,
    savedTokens: pruned.reduce((sum, result) => sum + result.tokens, 0),
    reason,
  };
}

export function pruneSupersededAfterCollect(
  registry: ChunkRegistry,
  chunk: ContextChunk,
  config: PruneChunksConfig,
): SupersededPruneResult {
  if (!config.autoPrune.enabled || !config.autoPrune.pruneSupersededOnIngest) {
    return { pruned: [], savedTokens: 0 };
  }

  const reasons = new Map<string, string>();
  if (config.autoPrune.pruneZeroMatchSearchesOnIngest && isZeroMatchSearch(chunk)) {
    reasons.set(chunk.id, "auto-prune: zero-match search result");
  }

  for (const previous of registry.active()) {
    if (previous.id === chunk.id) continue;
    if (!previous.part && registry.hasChildren(previous.id)) continue;
    if (previous.pinned || previous.risk === "high" || !previous.restoreAvailable) continue;

    const reason = supersededReason(previous, chunk);
    if (reason) reasons.set(previous.id, `auto-prune: ${reason}`);
  }

  const pruned: ChunkActionResult[] = [];
  for (const [id, reason] of reasons) {
    pruned.push(...registry.prune([id], reason, "auto_pruned"));
  }

  return {
    pruned,
    savedTokens: pruned.reduce((sum, result) => sum + result.tokens, 0),
  };
}

export function pruneReamerxExploratoryAfterTerminal(
  registry: ChunkRegistry,
  terminalChunk: ContextChunk,
  config: PruneChunksConfig,
): ReamerxTerminalPruneResult {
  if (!config.autoPrune.enabled || !config.reamerx.pruneExploratoryAfterTerminal) {
    return { triggered: false, pruned: [], savedTokens: 0 };
  }
  if (!isReamerxTerminalTool(terminalChunk.toolName)) {
    return { triggered: false, pruned: [], savedTokens: 0 };
  }

  const ids: string[] = [];
  for (const chunk of registry.active()) {
    if (chunk.id === terminalChunk.id) continue;
    if (chunk.createdAt > terminalChunk.createdAt) continue;
    if (!isReamerxExploratoryTool(chunk.toolName)) continue;
    if (chunk.pinned || chunk.risk === "high" || !chunk.restoreAvailable) continue;
    ids.push(chunk.id);
  }

  if (ids.length === 0) return { triggered: true, pruned: [], savedTokens: 0 };

  const pruned = registry.prune(
    ids,
    `auto-prune: ReamerX exploratory results superseded by ${terminalChunk.toolName}`,
    "auto_pruned",
  );
  return {
    triggered: true,
    pruned,
    savedTokens: pruned.reduce((sum, result) => sum + result.tokens, 0),
  };
}

export function pressureSummary(
  registry: ChunkRegistry,
  usage: ContextUsage | null | undefined,
  config: PruneChunksConfig,
  preserve?: PreserveContext,
): {
  estimatedActiveChunkTokens: number;
  estimatedPrunedTokens: number;
  largestUnprunedChunks: PruneCandidate[];
  autoPrune: {
    enabled: boolean;
    profile: PruneChunksConfig["profile"];
    policy: "heuristic-v1" | "adaptive-v1";
    modelProfile: PruneChunksConfig["autoPrune"]["modelProfile"];
    pressureBand: PressureBand;
    currentPercent: number | null;
    startAtPercent: number;
    targetPercent: number;
    minChunkTokens: number;
    maxChunksPerPass: number;
    nonChunkTokens: number | null;
    bestPossiblePercent: number | null;
    targetReachableByChunks: boolean | null;
  };
  recommendedCandidates: PruneCandidate[];
  blockedCandidates: BlockedPruneCandidate[];
} {
  const summary = registry.summary();
  const pct = contextPercent(usage);
  const nonChunkTokens =
    usage?.tokens != null ? Math.max(0, usage.tokens - summary.activeTokens) : null;
  const bestPossiblePercent =
    nonChunkTokens != null && usage?.contextWindow
      ? (nonChunkTokens / usage.contextWindow) * 100
      : null;
  return {
    estimatedActiveChunkTokens: summary.activeTokens,
    estimatedPrunedTokens: summary.prunedTokens,
    largestUnprunedChunks: registry
      .list({ pruned: false, sortBy: "tokens", limit: 5 })
      .chunks.map((chunk) => ({
        id: chunk.id,
        label: chunk.label,
        kind: chunk.kind,
        risk: chunk.risk,
        tokenEstimate: chunk.tokenEstimate,
        score: chunk.tokenEstimate,
        confidence: "low",
        policy: config.autoPrune.policy,
        reasons: ["largest active chunk"],
      })),
    autoPrune: {
      enabled: config.autoPrune.enabled,
      currentPercent: contextPercent(usage),
      profile: config.profile,
      policy: config.autoPrune.policy,
      modelProfile: config.autoPrune.modelProfile,
      pressureBand: pressureBand(pct, config),
      startAtPercent: config.autoPrune.startAtPercent,
      targetPercent: config.autoPrune.targetPercent,
      minChunkTokens: config.autoPrune.minChunkTokens,
      maxChunksPerPass: config.autoPrune.maxChunksPerPass,
      nonChunkTokens,
      bestPossiblePercent,
      targetReachableByChunks:
        bestPossiblePercent == null ? null : bestPossiblePercent <= config.autoPrune.targetPercent,
    },
    recommendedCandidates: suggestPruneCandidates(registry, config, {
      limit: 10,
      pressurePercent: pct,
      preserve,
    }),
    blockedCandidates: blockedPruneCandidates(registry, config, {
      limit: 10,
      pressurePercent: pct,
      preserve,
    }),
  };
}

export function blockedPruneCandidates(
  registry: ChunkRegistry,
  config: PruneChunksConfig,
  options: {
    now?: number;
    limit?: number;
    preserve?: PreserveContext;
    pressurePercent?: number | null;
  } = {},
): BlockedPruneCandidate[] {
  const now = options.now ?? Date.now();
  const recentProtected = recentChunkIds(
    registry.active(),
    protectedRecentChunkCount(config, options.pressurePercent),
  );
  const blocked: BlockedPruneCandidate[] = [];

  for (const chunk of registry.active()) {
    const reason = autoPruneBlockedReason(
      chunk,
      config,
      now,
      recentProtected,
      options.preserve,
      options.pressurePercent,
    );
    if (!reason) continue;
    blocked.push({
      id: chunk.id,
      label: chunk.label,
      kind: chunk.kind,
      risk: chunk.risk,
      tokenEstimate: chunk.tokenEstimate,
      reason,
    });
  }

  blocked.sort((a, b) => b.tokenEstimate - a.tokenEstimate);
  return blocked.slice(0, Math.max(0, options.limit ?? 10));
}

function autoPruneBlockedReason(
  chunk: ContextChunk,
  config: PruneChunksConfig,
  now: number,
  recentProtected: Set<string>,
  preserve?: PreserveContext,
  pressurePercent?: number | null,
): string | null {
  return config.autoPrune.policy === "adaptive-v1"
    ? adaptiveBlockedReason(chunk, config, now, recentProtected, preserve, pressurePercent)
    : heuristicBlockedReason(chunk, config, now, recentProtected, preserve, pressurePercent);
}

function heuristicBlockedReason(
  chunk: ContextChunk,
  config: PruneChunksConfig,
  now: number,
  recentProtected: Set<string>,
  preserve?: PreserveContext,
  pressurePercent?: number | null,
): string | null {
  const relaxedForPressure =
    pressurePercent != null && pressurePercent >= config.autoPrune.startAtPercent + 5;
  const minChunkTokens = relaxedForPressure
    ? Math.min(config.autoPrune.minChunkTokens, config.track.minChunkTokens)
    : config.autoPrune.minChunkTokens;

  if (chunk.pruned) return "already pruned";
  if (chunk.pinned) return "pinned";
  if (chunk.risk === "high") return "high risk";
  if (chunk.lastSeenAt == null) return "not yet seen in model context";
  if (isPathPreserved(chunk, preserve?.paths)) return "referenced by active working context";
  const anchor = matchingReasoningAnchor(chunk, preserve?.anchors);
  if (anchor) return `contains active reasoning anchor: ${anchor}`;
  if (
    chunk.kind === "file_read" &&
    chunk.risk === "medium" &&
    chunk.source?.path &&
    (pressurePercent == null || pressurePercent < config.autoPrune.startAtPercent + 15)
  ) {
    return "unbounded file read below high-pressure threshold";
  }
  if (chunk.tokenEstimate < minChunkTokens) return "below token floor";
  if (recentProtected.has(chunk.id)) return "recent protected chunk";
  if (preserve?.ids?.has(chunk.id)) return "referenced by latest assistant message";
  const preserveMs = config.autoPrune.preserveRecentMinutes * 60 * 1000;
  if (!relaxedForPressure && now - chunk.createdAt < preserveMs) return "created recently";
  if (chunk.lastRestoredAt != null && now - chunk.lastRestoredAt < preserveMs) {
    return "restored recently";
  }
  return null;
}

function adaptiveBlockedReason(
  chunk: ContextChunk,
  config: PruneChunksConfig,
  now: number,
  recentProtected: Set<string>,
  preserve?: PreserveContext,
  pressurePercent?: number | null,
): string | null {
  const modelProfile = config.autoPrune.modelProfile;
  const band = pressureBand(pressurePercent, config);
  const start = config.autoPrune.startAtPercent;
  const preserveMs = config.autoPrune.preserveRecentMinutes * 60 * 1000;
  const relaxedForPressure =
    pressurePercent != null && pressurePercent >= config.autoPrune.startAtPercent + 5;
  const minChunkTokens = relaxedForPressure
    ? Math.min(config.autoPrune.minChunkTokens, config.track.minChunkTokens)
    : adaptiveMinChunkTokens(config, band);

  if (chunk.pruned) return "already pruned";
  if (chunk.pinned) return "pinned";
  if (chunk.risk === "high") return "high risk";
  if (chunk.lastSeenAt == null) return "not yet seen in model context";
  if (isPathPreserved(chunk, preserve?.paths)) return "referenced by active working context";
  const anchor = matchingReasoningAnchor(chunk, preserve?.anchors);
  if (anchor) return `contains active reasoning anchor: ${anchor}`;
  if (preserve?.ids?.has(chunk.id)) return "referenced by latest assistant message";
  if (chunk.tokenEstimate < minChunkTokens) return "below adaptive token floor";
  if (recentProtected.has(chunk.id)) return "recent protected chunk";

  if (
    chunk.kind === "file_read" &&
    chunk.risk === "medium" &&
    chunk.source?.path &&
    (pressurePercent == null || pressurePercent < unboundedReadPressureFloor(modelProfile, start))
  ) {
    return "unbounded file read below adaptive pressure threshold";
  }

  if (
    preserveMs > 0 &&
    chunk.lastRestoredAt != null &&
    now - chunk.lastRestoredAt < preserveMs * 2
  ) {
    return "restored recently";
  }
  if (!relaxedForPressure && preserveMs > 0 && now - chunk.createdAt < preserveMs) {
    return "created recently";
  }
  if (
    modelProfile === "cloud-1m" &&
    band !== "extreme" &&
    chunk.restoreCount &&
    chunk.restoreCount > 1
  ) {
    return "frequently restored on large-window profile";
  }
  return null;
}

function isPathPreserved(chunk: ContextChunk, preservedPaths: Set<string> | undefined): boolean {
  if (!chunk.source?.path || !preservedPaths || preservedPaths.size === 0) return false;
  const chunkPath = normalizePath(chunk.source.path);
  for (const preservedPath of preservedPaths) {
    if (chunkPath === preservedPath) return true;
    if (chunkPath.endsWith(`/${preservedPath}`)) return true;
    if (preservedPath.endsWith(`/${chunkPath}`)) return true;
  }
  return false;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function scoreCandidate(
  chunk: ContextChunk,
  now: number,
  duplicateHashes: Set<string> = new Set(),
  config?: PruneChunksConfig,
  signals?: SessionSignals,
): PruneCandidate {
  const policy = config?.autoPrune.policy ?? "heuristic-v1";
  const heuristic = scoreCandidateHeuristic(chunk, now, duplicateHashes);
  if (policy !== "adaptive-v1") return heuristic;
  return scoreCandidateAdaptive(
    chunk,
    heuristic,
    signals ?? inferSessionSignals([chunk], config, null),
  );
}

function scoreCandidateHeuristic(
  chunk: ContextChunk,
  now: number,
  duplicateHashes: Set<string> = new Set(),
): PruneCandidate {
  const ageMinutes = Math.max(0, (now - chunk.createdAt) / 60_000);
  const reasons: string[] = [];
  let score = chunk.tokenEstimate;

  if (chunk.source?.contentHash && duplicateHashes.has(chunk.source.contentHash)) {
    score += 500;
    reasons.push("duplicate content");
  }
  if (isZeroMatchSearch(chunk)) {
    score += 500;
    reasons.push("zero-match search");
  }
  if (chunk.restoreAvailable) {
    score += 300;
    reasons.push("restorable");
  }
  if (chunk.risk === "low") {
    score += 250;
    reasons.push("low risk");
  }
  if (["search", "flow_trace", "outline", "symbol"].includes(chunk.kind)) {
    score += 200;
    reasons.push("stale exploration");
  }
  if (chunk.kind === "test_output" && chunk.risk === "low") {
    score += 150;
    reasons.push("successful test output");
  }
  if (ageMinutes >= 30) {
    score += 300;
    reasons.push("old");
  } else if (ageMinutes >= 10) {
    score += 100;
    reasons.push("not recent");
  }

  return {
    id: chunk.id,
    label: chunk.label,
    kind: chunk.kind,
    risk: chunk.risk,
    tokenEstimate: chunk.tokenEstimate,
    score,
    confidence: candidateConfidence(score, chunk.tokenEstimate, reasons),
    policy: "heuristic-v1",
    reasons,
  };
}

function scoreCandidateAdaptive(
  chunk: ContextChunk,
  heuristic: PruneCandidate,
  signals: SessionSignals,
): PruneCandidate {
  const reasons = [...heuristic.reasons];
  let score = heuristic.score;

  switch (chunk.restoreMode) {
    case "memory":
      score += 350;
      reasons.push("restore cost: memory");
      break;
    case "disk_cache":
      score += 250;
      reasons.push("restore cost: disk cache");
      break;
    case "source_rehydrate":
      score += 100;
      reasons.push("restore cost: source rehydrate");
      break;
    case "unavailable":
      score -= 500;
      reasons.push("restore unavailable");
      break;
  }

  if (signals.pressureBand === "high") {
    score += 200;
    reasons.push("high pressure");
  } else if (signals.pressureBand === "extreme") {
    score += 600;
    reasons.push("extreme pressure");
  }

  if (signals.modelProfile === "local-32k" || signals.modelProfile === "local-64k") {
    score += Math.round(chunk.tokenEstimate * (signals.modelProfile === "local-32k" ? 0.25 : 0.15));
    reasons.push(`${signals.modelProfile} tighter window`);
  } else if (signals.modelProfile === "cloud-1m") {
    score -= 300;
    reasons.push("cloud-1m preserves more context");
  }

  if (isSubagentExplorationAfterManifest(chunk, signals)) {
    score += 600;
    reasons.push("subagent context isolated after child manifest");
  }

  if (
    signals.taskPhase === "verification" &&
    ["search", "flow_trace", "outline", "symbol"].includes(chunk.kind)
  ) {
    score += 250;
    reasons.push("pre-verification exploration");
  } else if (signals.taskPhase === "verification" && chunk.kind === "test_output") {
    score -= 250;
    reasons.push("verification evidence");
  } else if (
    signals.taskPhase === "editing" &&
    ["search", "outline", "flow_trace"].includes(chunk.kind)
  ) {
    score += 150;
    reasons.push("exploration superseded by editing");
  }

  if (chunk.kind === "file_read" && chunk.source?.path && chunk.risk === "medium") {
    score -= 150;
    reasons.push("source anchor");
  }
  if (chunk.restoreCount && chunk.restoreCount > 0) {
    score -= Math.min(900, 300 * chunk.restoreCount);
    reasons.push(`restored ${chunk.restoreCount}x before`);
  }

  return {
    ...heuristic,
    score,
    confidence: candidateConfidence(score, chunk.tokenEstimate, reasons),
    policy: "adaptive-v1",
    reasons,
  };
}

function inferSessionSignals(
  active: ContextChunk[],
  config: PruneChunksConfig,
  pressurePercent?: number | null,
): SessionSignals {
  const recent = [...active]
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)
    .slice(0, 6);
  return {
    pressureBand: pressureBand(pressurePercent, config),
    taskPhase: inferTaskPhase(recent),
    modelProfile: config.autoPrune.modelProfile,
    subagentManifestScopes: subagentManifestScopes(active),
  };
}

function inferTaskPhase(recent: ContextChunk[]): TaskPhase {
  if (recent.some((chunk) => chunk.kind === "test_output")) return "verification";
  if (
    recent.some(
      (chunk) => chunk.kind === "diff" || (chunk.kind === "file_read" && chunk.source?.path),
    )
  ) {
    return "editing";
  }
  return "exploration";
}

function pressureBand(
  pressurePercent: number | null | undefined,
  config: PruneChunksConfig,
): PressureBand {
  if (pressurePercent == null) return "normal";
  if (pressurePercent >= config.tombstones.coalesceAtPercent) return "extreme";
  if (pressurePercent >= config.autoPrune.startAtPercent + 10) return "high";
  return "normal";
}

function adaptiveMinChunkTokens(config: PruneChunksConfig, band: PressureBand): number {
  if (band === "extreme")
    return Math.min(config.track.minChunkTokens, config.autoPrune.minChunkTokens);
  if (
    (config.autoPrune.modelProfile === "local-32k" ||
      config.autoPrune.modelProfile === "local-64k") &&
    band === "high"
  ) {
    return Math.min(config.track.minChunkTokens, config.autoPrune.minChunkTokens);
  }
  if (config.autoPrune.modelProfile === "cloud-1m" && band === "normal") {
    return Math.max(config.autoPrune.minChunkTokens, config.track.minChunkTokens * 2);
  }
  return config.autoPrune.minChunkTokens;
}

function unboundedReadPressureFloor(
  modelProfile: PruneChunksConfig["autoPrune"]["modelProfile"],
  startAtPercent: number,
): number {
  if (modelProfile === "local-32k") return startAtPercent + 10;
  if (modelProfile === "local-64k") return startAtPercent + 12;
  if (modelProfile === "cloud-200k") return startAtPercent + 18;
  if (modelProfile === "cloud-1m") return startAtPercent + 20;
  return startAtPercent + 15;
}

function candidateConfidence(
  score: number,
  tokenEstimate: number,
  reasons: string[],
): "low" | "medium" | "high" {
  const lift = score - tokenEstimate;
  if (lift >= 900 || reasons.length >= 5) return "high";
  if (lift >= 350 || reasons.length >= 3) return "medium";
  return "low";
}

function subagentManifestScopes(chunks: ContextChunk[]): Set<string> {
  const scopes = new Set<string>();
  for (const chunk of chunks) {
    if ((chunk.scope?.scope ?? "main") === "main") continue;
    if (["context_pack", "other", "test_output"].includes(chunk.kind)) {
      scopes.add(scopeKey(chunk));
    }
  }
  return scopes;
}

function isSubagentExplorationAfterManifest(chunk: ContextChunk, signals: SessionSignals): boolean {
  if ((chunk.scope?.scope ?? "main") === "main") return false;
  if (!["search", "flow_trace", "outline", "symbol"].includes(chunk.kind)) return false;
  return signals.subagentManifestScopes.has(scopeKey(chunk));
}

function scopeKey(chunk: ContextChunk): string {
  const scope = chunk.scope;
  return [
    scope?.scope ?? "main",
    scope?.parentRunId ?? "",
    scope?.runId ?? "",
    scope?.agentName ?? "",
  ]
    .join(":")
    .toLowerCase();
}

function supersededReason(previous: ContextChunk, current: ContextChunk): string | null {
  if (sameContent(previous, current)) return "duplicate output superseded by newer result";
  if (sameCommand(previous, current)) return "duplicate command superseded by newer result";
  if (overlappingFileRead(previous, current)) {
    return "overlapping file read superseded by newer result";
  }
  if (supersededDiff(previous, current)) return "diff superseded by newer diff";
  return null;
}

function sameContent(previous: ContextChunk, current: ContextChunk): boolean {
  return (
    !!previous.source?.contentHash &&
    previous.source.contentHash === current.source?.contentHash &&
    previous.kind === current.kind
  );
}

function sameCommand(previous: ContextChunk, current: ContextChunk): boolean {
  const previousCommand = normalizeCommand(previous.source?.command);
  const currentCommand = normalizeCommand(current.source?.command);
  return (
    !!previousCommand &&
    previousCommand === currentCommand &&
    previous.kind === current.kind &&
    ["shell", "search", "test_output"].includes(current.kind)
  );
}

function overlappingFileRead(previous: ContextChunk, current: ContextChunk): boolean {
  if (previous.kind !== "file_read" || current.kind !== "file_read") return false;
  if (!samePath(previous, current)) return false;
  if (previous.risk === "high" || current.risk === "high") return false;

  const previousRange = sourceRange(previous);
  const currentRange = sourceRange(current);
  if (!previousRange || !currentRange) return sameContent(previous, current);

  return previousRange.start <= currentRange.end && currentRange.start <= previousRange.end;
}

function supersededDiff(previous: ContextChunk, current: ContextChunk): boolean {
  return previous.kind === "diff" && current.kind === "diff" && samePath(previous, current);
}

function samePath(previous: ContextChunk, current: ContextChunk): boolean {
  const previousPath = previous.source?.path ? normalizePath(previous.source.path) : undefined;
  const currentPath = current.source?.path ? normalizePath(current.source.path) : undefined;
  return !!previousPath && previousPath === currentPath;
}

function sourceRange(chunk: ContextChunk): { start: number; end: number } | null {
  if (chunk.source?.startLine == null || chunk.source.endLine == null) return null;
  return {
    start: Math.min(chunk.source.startLine, chunk.source.endLine),
    end: Math.max(chunk.source.startLine, chunk.source.endLine),
  };
}

function isZeroMatchSearch(chunk: ContextChunk): boolean {
  if (chunk.kind !== "search") return false;
  const text = `${chunk.label}\n${chunk.summary ?? ""}`;
  return /\b0\s+(exact\s+)?(matches|results|hits)\b/i.test(text);
}

function normalizeCommand(command: string | undefined): string | undefined {
  const normalized = command?.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function protectedRecentChunkCount(
  config: PruneChunksConfig,
  pressurePercent?: number | null,
): number {
  const configured = Math.max(0, config.autoPrune.preserveRecentChunks);
  if (pressurePercent == null) return configured;
  if (config.autoPrune.policy === "adaptive-v1") {
    if (
      config.autoPrune.modelProfile === "local-32k" ||
      config.autoPrune.modelProfile === "local-64k"
    ) {
      const relaxAt = config.autoPrune.modelProfile === "local-32k" ? 5 : 8;
      if (pressurePercent >= config.autoPrune.startAtPercent + relaxAt) return 0;
      return Math.min(configured, 2);
    }
    if (
      config.autoPrune.modelProfile === "cloud-200k" ||
      config.autoPrune.modelProfile === "cloud-1m"
    ) {
      const relaxAt = config.autoPrune.modelProfile === "cloud-1m" ? 20 : 15;
      if (pressurePercent >= config.autoPrune.startAtPercent + relaxAt)
        return Math.min(configured, 2);
      return configured + (config.autoPrune.modelProfile === "cloud-1m" ? 2 : 1);
    }
  }
  if (pressurePercent >= config.autoPrune.startAtPercent + 10) return 0;
  if (pressurePercent >= config.autoPrune.startAtPercent + 3) return Math.min(configured, 2);
  return configured;
}

function duplicateContentHashes(chunks: ContextChunk[]): Set<string> {
  const counts = new Map<string, number>();
  for (const chunk of chunks) {
    const hash = chunk.source?.contentHash;
    if (!hash) continue;
    counts.set(hash, (counts.get(hash) ?? 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([hash]) => hash));
}

function recentChunkIds(chunks: ContextChunk[], count: number): Set<string> {
  if (count <= 0) return new Set();
  return new Set(
    [...chunks]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, count)
      .map((chunk) => chunk.id),
  );
}
