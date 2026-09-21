/**
 * Prune Chunks v0.4 - proactive working-set control for long-horizon tool output.
 */

import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { extractReasoningAnchors } from "./src/anchors";
import { collectToolResult } from "./src/collector";
import { mergeConfig, type RawPruneChunksConfig } from "./src/config";
import { compactFailedToolValidationMessages } from "./src/contextGuards";
import { CompositeChunkContentCache, DiskChunkContentCache } from "./src/diskCache";
import {
  manualRetirementPlan,
  type PressureSweepState,
  pressureRetirementPlan,
  type RetirementPlan,
  shouldRunPressureSweep,
  shouldRunWorkingSetSweep,
  type WorkingSetSweepState,
  workingSetRetirementPlan,
} from "./src/pruner";
import { ChunkRegistry, MemoryChunkContentCache } from "./src/registry";
import {
  contextFooter,
  renderActionResults,
  renderCandidates,
  renderChunkList,
  renderStatus,
} from "./src/render";
import { restoreChunks } from "./src/restorer";
import { renderTelemetryReport, TelemetryRecorder } from "./src/telemetry";
import { rewriteRetiredExchanges } from "./src/tombstones";
import type {
  ChunkScope,
  ChunkScopeKind,
  ContentBlock,
  ContextUsage,
  PersistedStateDelta,
  PreserveContext,
  PruneChunksConfig,
  StateDeltaAction,
} from "./src/types";

const STATE_TYPE = "prune-chunks-state-v3";

export default function (pi: ExtensionAPI) {
  let resolvedConfig = loadConfig();
  let config = resolvedConfig.config;
  let configSource = resolvedConfig.sourceSummary;
  let configError = resolvedConfig.error;
  let cacheSignature: string | undefined;

  // Project overrides are only available once a lifecycle context exists.
  const registry = new ChunkRegistry();
  const telemetry = new TelemetryRecorder();
  const pendingArchives = new Set<Promise<void>>();
  let workingSetState: WorkingSetSweepState | undefined;
  let pressureState: PressureSweepState | undefined;
  let pendingProviderRewrite = false;
  let reconcileAfterCompaction = false;
  let signedHistory = false;

  async function refreshLifecycleConfig(ctx?: unknown): Promise<boolean> {
    let next = loadConfig(ctx);
    const nextCacheSignature = contentCacheSignature(next.config);
    if (nextCacheSignature !== cacheSignature) {
      await Promise.allSettled([...pendingArchives]);
      try {
        registry.reset(createContentCache(next.config));
        cacheSignature = nextCacheSignature;
      } catch (error) {
        next = disabledConfig(`Cannot initialize prune-chunks cache: ${errorMessage(error)}`);
        registry.reset(new MemoryChunkContentCache());
        cacheSignature = undefined;
      }
    }
    resolvedConfig = next;
    config = resolvedConfig.config;
    configSource = resolvedConfig.sourceSummary;
    configError = resolvedConfig.error;
    if (configError) {
      registry.reset();
      resetSweepState();
      reportConfigurationError(ctx, configError);
      return false;
    }
    return true;
  }

  function resetSweepState(): void {
    workingSetState = undefined;
    pressureState = undefined;
    pendingProviderRewrite = false;
    reconcileAfterCompaction = false;
    signedHistory = false;
  }

  function persistActions(actions: StateDeltaAction[]): void {
    if (actions.length === 0) return;
    const delta: PersistedStateDelta = { version: 3, actions };
    pi.appendEntry(STATE_TYPE, delta);
  }

  function scheduleArchive(ids: string[]): void {
    if (ids.length === 0) return;
    const startedAt = performance.now();
    const pending = registry
      .archive(ids)
      .then(() => telemetry.recordArchiveDuration(performance.now() - startedAt))
      .catch((error) => {
        if (config.debug) {
          pi.log?.(
            "warn",
            `prune-chunks: archive failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      })
      .finally(() => pendingArchives.delete(pending));
    pendingArchives.add(pending);
  }

  function retirePlan(
    plan: RetirementPlan,
    automatic: boolean,
    reason: string = plan.cause,
  ): ReturnType<ChunkRegistry["prune"]> {
    const ids = plan.candidates.map((candidate) => candidate.id);
    const results = registry.prune(ids, reason, automatic ? "auto_pruned" : "pruned");
    const retiredIds = results
      .filter((result) => result.status === "pruned")
      .map((result) => result.id);
    scheduleArchive(retiredIds);
    telemetry.recordRetirements(results, automatic, reason);
    persistActions(
      retiredIds.map((id) => ({
        id,
        state: "pruned",
        reason,
        timestamp: Date.now(),
      })),
    );
    return results;
  }

  pi.on("session_start", async (_event, ctx) => {
    if (!(await refreshLifecycleConfig(ctx))) return;
    const compactedIds = rebuildRegistry(registry, currentBranchEntries(ctx), config);
    scheduleArchive(compactedIds);
    resetSweepState();
  });

  pi.on("session_shutdown", async () => {
    await Promise.allSettled([...pendingArchives]);
    registry.reset();
    telemetry.reset();
    resetSweepState();
  });

  pi.on("session_compact", async () => {
    telemetry.recordCompaction();
    workingSetState = undefined;
    pressureState = undefined;
    reconcileAfterCompaction = true;
  });

  pi.on("session_tree", async (_event, ctx) => {
    if (!(await refreshLifecycleConfig(ctx))) return;
    const compactedIds = rebuildRegistry(registry, currentBranchEntries(ctx), config);
    scheduleArchive(compactedIds);
    resetSweepState();
  });

  pi.on("tool_result", async (event) => {
    const collected = collectToolResult({
      toolCallId: String(event.toolCallId),
      toolName: String(event.toolName),
      content: normalizeContent(event.content),
      params: extractParams(event),
      scope: extractScope(event),
      config,
    });
    if (!collected) return;

    const chunk = registry.addCollected(collected);
    telemetry.recordCollected(chunk);
  });

  pi.on("context", async (event, ctx) => {
    if (!config.enabled) return;
    const startedAt = performance.now();
    const originalMessages = event.messages ?? [];
    signedHistory ||= protectsThinkingPrefix(ctx, originalMessages);
    if (signedHistory) {
      // Keep persisted retirements stable: resurrecting earlier output can also
      // invalidate signatures produced against the already-pruned projection.
      const rewritten = rewriteRetiredExchanges(originalMessages, registry);
      pendingProviderRewrite = rewritten.modified;
      if (ctx?.hasUI)
        ctx.ui.setStatus("prune-chunks", "Pruning paused: protected thinking history");
      return rewritten.modified ? { messages: rewritten.messages } : undefined;
    }
    const reportedUsage = getUsage(ctx);
    const usage = withProviderEstimateFloor(reportedUsage, originalMessages);
    const preserve = preserveContext(originalMessages, ctx);
    const presentToolCallIds = toolResultIds(originalMessages);
    const hasUnseenPresentResult = [...presentToolCallIds].some(
      (toolCallId) => registry.getByToolCallId(toolCallId)?.lastSeenAt == null,
    );

    const absentIds = registry.absentFromContext(presentToolCallIds, reconcileAfterCompaction);
    reconcileAfterCompaction = false;
    if (absentIds.length > 0) {
      retirePlan(planForIds(registry, absentIds, "compacted out of live context"), true);
    }

    let retiredTokensThisPass = 0;
    const activeTokensBeforeWorkingSet = registry.summary().activeTokens;
    if (shouldRunWorkingSetSweep(activeTokensBeforeWorkingSet, config, workingSetState)) {
      const workingSet = workingSetRetirementPlan(registry, config, { preserve });
      const before = registry.summary().activeTokens;
      retirePlan(workingSet, true, "long-horizon working-set sweep");
      const retiredTokens = Math.max(0, before - registry.summary().activeTokens);
      retiredTokensThisPass += retiredTokens;
      if (workingSet.estimatedSavings >= workingSet.targetSavings || !hasUnseenPresentResult) {
        workingSetState = { activeTokens: activeTokensBeforeWorkingSet };
      }
    }
    if (registry.summary().activeTokens < config.workingSet.triggerTokens) {
      workingSetState = undefined;
    }

    if (shouldRunPressureSweep(usage, config, pressureState)) {
      const pressureUsage = usageAfterRetirement(usage, retiredTokensThisPass);
      const pressure = pressureRetirementPlan(registry, pressureUsage, config, { preserve });
      retirePlan(pressure, true, "pressure safety sweep");
      if (pressure.estimatedSavings >= pressure.targetSavings || !hasUnseenPresentResult) {
        pressureState = {
          usageTokens: usage?.tokens ?? 0,
        };
      }
    } else if (
      usage?.tokens != null &&
      usage.contextWindow != null &&
      (usage.tokens / usage.contextWindow) * 100 < config.pressure.triggerPercent
    ) {
      pressureState = undefined;
    }

    // A result becomes retirement-eligible only after one provider pass.
    for (const toolCallId of presentToolCallIds) registry.markSeenByToolCallId(toolCallId);

    const rewritten = rewriteRetiredExchanges(originalMessages, registry);
    const guarded = compactFailedToolValidationMessages(rewritten.messages, config);
    const modified = rewritten.modified || guarded.modified;
    const effectiveTokensSaved = modified
      ? Math.max(
          0,
          estimateProviderTokens(originalMessages) - estimateProviderTokens(guarded.messages),
        )
      : 0;
    telemetry.recordContextPass({
      durationMs: performance.now() - startedAt,
      modified,
      removedExchanges: rewritten.removedExchanges,
      fallbackMarkers: rewritten.fallbackMarkers,
      partialMarkers: rewritten.partialMarkers,
      effectiveTokensSaved,
    });
    pendingProviderRewrite = modified;

    if (ctx?.hasUI) {
      ctx.ui.setStatus("prune-chunks", contextFooter(registry, usage, config));
    }
    if (modified) return { messages: guarded.messages };
  });

  pi.on("message_end", async (event) => {
    signedHistory ||= protectsThinkingPrefix(undefined, [event.message]);
    const providerUsage = assistantProviderUsage(event);
    if (!providerUsage) return;
    telemetry.recordProviderResponse(providerUsage, pendingProviderRewrite);
    pendingProviderRewrite = false;
  });

  registerCommands(
    pi,
    registry,
    () => config,
    () => configSource,
    () => configError,
    (ctx) =>
      signedHistory ||
      protectsThinkingPrefix(
        ctx,
        currentBranchEntries(ctx).map((entry) => (entry as { message?: unknown }).message),
      ),
    telemetry,
    retirePlan,
    persistActions,
  );
}

function registerCommands(
  pi: ExtensionAPI,
  registry: ChunkRegistry,
  getConfig: () => PruneChunksConfig,
  getConfigSource: () => string,
  getConfigError: () => string | undefined,
  historyProtected: (ctx: unknown) => boolean,
  telemetry: TelemetryRecorder,
  retirePlan: (
    plan: RetirementPlan,
    automatic: boolean,
    reason?: string,
  ) => ReturnType<ChunkRegistry["prune"]>,
  persistActions: (actions: StateDeltaAction[]) => void,
): void {
  pi.registerCommand("prune-status", {
    description: "Show long-horizon working-set and tracked tool output status",
    async handler(_args, ctx) {
      notify(
        ctx,
        [
          renderStatus(registry, getUsage(ctx), getConfig(), getConfigSource(), getConfigError()),
          ...(historyProtected(ctx) ? ["Pruning paused: protected thinking history"] : []),
        ].join("\n"),
      );
    },
  });

  pi.registerCommand("prune-largest", {
    description: "Inspect the largest tracked tool results",
    async handler(args, ctx) {
      const parsed = parseCommandArgs(args);
      const limit = numberOption(parsed, "--limit") ?? 10;
      const scope = scopeOrUndefined(stringOption(parsed, "--scope"));
      notify(
        ctx,
        renderChunkList(registry.list({ pruned: false, scope, sortBy: "tokens", limit })),
      );
    },
  });

  pi.registerCommand("prune-suggest", {
    description: "Inspect safe manual cleanup candidates",
    async handler(args, ctx) {
      const parsed = parseCommandArgs(args);
      const limit = numberOption(parsed, "--limit") ?? 10;
      const plan = manualRetirementPlan(registry, getConfig(), {
        limit,
        preserve: preserveContext([], ctx),
      });
      notify(ctx, renderCandidates(plan.candidates));
    },
  });

  pi.registerCommand("prune-now", {
    description: "Retire selected chunks or apply safe manual cleanup",
    async handler(args, ctx) {
      const parsed = parseCommandArgs(args);
      const explicitIds = parsed.filter((arg) => arg.startsWith("pc_"));
      const limit = numberOption(parsed, "--limit") ?? 10;
      const plan =
        explicitIds.length > 0
          ? planForIds(registry, explicitIds, "manual selection")
          : manualRetirementPlan(registry, getConfig(), {
              limit,
              preserve: preserveContext([], ctx),
            });
      if (parsed.includes("--dry-run")) {
        notify(ctx, renderCandidates(plan.candidates));
        return;
      }
      if (historyProtected(ctx)) {
        notify(
          ctx,
          "Pruning paused: changing protected thinking history can invalidate reasoning. Start a new session to change retirement state.",
        );
        return;
      }
      const results = retirePlan(plan, false, "manual /prune-now");
      notify(
        ctx,
        renderActionResults(
          "pruned",
          plan.candidates.map((item) => item.id),
          results,
        ),
      );
    },
  });

  pi.registerCommand("prune-restore", {
    description: "Restore retired tool output by chunk ID",
    async handler(args, ctx) {
      const ids = parseCommandArgs(args).filter((arg) => arg.startsWith("pc_"));
      if (ids.length === 0) {
        notify(ctx, "Usage: /prune-restore <id> [id...]");
        return;
      }
      if (historyProtected(ctx)) {
        notify(
          ctx,
          "Restore paused: changing protected thinking history can invalidate reasoning. The saved transcript remains intact.",
        );
        return;
      }
      const results = await restoreChunks(registry, ids, getConfig(), {
        cwd: currentWorkingDirectory(ctx),
      });
      telemetry.recordRestoreResults(results);
      persistActions(
        results
          .filter((result) => result.status === "restored")
          .map((result) => ({
            id: result.id,
            state: "active",
            timestamp: Date.now(),
          })),
      );
      notify(ctx, renderActionResults("restored", ids, results));
    },
  });

  pi.registerCommand("prune-report", {
    description: "Write a tool-output hygiene report",
    async handler(args, ctx) {
      const parsed = parseCommandArgs(args);
      const output = stringOption(parsed, "--output") ?? "prune-report.md";
      const destination = path.resolve(currentWorkingDirectory(ctx) ?? process.cwd(), output);
      await writeFile(
        destination,
        renderTelemetryReport(telemetry.snapshot(registry.summary(), getUsage(ctx))),
        "utf8",
      );
      notify(ctx, `Wrote tool-output hygiene report to ${output}`);
    },
  });
}

/** Reasoning capability alone does not imply a signed or prefix-bound history. */
function protectsThinkingPrefix(ctx: unknown, messages: unknown[]): boolean {
  const context = ctx as
    | {
        model?: { compat?: { supportsMidConvoEffort?: boolean } };
      }
    | undefined;
  if (context?.model?.compat?.supportsMidConvoEffort === true) return true;
  return messages.some((message) => {
    const candidate = message as { role?: string; content?: ContentBlock[] } | undefined;
    return (
      candidate?.role === "assistant" &&
      Array.isArray(candidate.content) &&
      candidate.content.some(
        (block) =>
          block.type === "redacted_thinking" ||
          (block.type === "thinking" &&
            (block.redacted === true ||
              [block.thinkingSignature, block.signature].some(
                (signature) => typeof signature === "string" && signature.trim().length > 0,
              ))),
      )
    );
  });
}

function createContentCache(config: PruneChunksConfig) {
  const memory = new MemoryChunkContentCache();
  if (!config.enabled || !config.restore.diskCache.enabled) return memory;
  return new CompositeChunkContentCache(
    memory,
    new DiskChunkContentCache(config.restore.diskCache),
  );
}

function contentCacheSignature(config: PruneChunksConfig): string {
  const disk = config.restore.diskCache;
  return JSON.stringify({
    enabled: config.enabled && disk.enabled,
    directory: disk.directory,
    maxAgeDays: disk.maxAgeDays,
    maxBlobBytes: disk.maxBlobBytes,
    maxBytes: disk.maxBytes,
  });
}

type ResolvedConfig = {
  config: PruneChunksConfig;
  sourceSummary: string;
  error?: string;
};

type ConfigLoadContext = {
  cwd?: unknown;
  sessionManager?: {
    getCwd?: () => string;
  };
  isProjectTrusted?: () => boolean;
};

function loadConfig(ctx?: unknown): ResolvedConfig {
  try {
    const loaded = loadRawConfig(ctx);
    try {
      return {
        config: mergeConfig(loaded.raw),
        sourceSummary: loaded.sourceSummary,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid pruneChunks settings from ${loaded.sourceSummary}: ${message}`);
    }
  } catch (error) {
    return disabledConfig(errorMessage(error));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function disabledConfig(error: string): ResolvedConfig {
  return {
    config: mergeConfig({ enabled: false, restore: { diskCache: false } }),
    sourceSummary: "configuration error; pruning disabled until settings are valid",
    error,
  };
}

function reportConfigurationError(ctx: unknown, error: string): void {
  const context = ctx as {
    hasUI?: boolean;
    ui?: { notify?: (text: string, level: string) => void };
  };
  const message = `prune-chunks disabled: ${error}. Fix settings and reload Pi.`;
  if (context?.hasUI && typeof context.ui?.notify === "function") {
    context.ui.notify(message, "error");
  } else {
    process.stderr.write(`${message}\n`);
  }
}

function loadRawConfig(ctx?: unknown): { raw?: RawPruneChunksConfig; sourceSummary: string } {
  const sources: string[] = [];
  let raw: RawPruneChunksConfig | undefined;

  const globalPath = path.join(getAgentDir(), "settings.json");
  const globalConfig = readPruneChunksSettings(globalPath, "global");
  if (globalConfig) {
    raw = mergeRawPruneConfig(raw, globalConfig);
    sources.push(`global ${globalPath}`);
  }

  const cwd = configCwd(ctx);
  if (cwd && isTrustedProject(ctx)) {
    const projectPath = path.join(cwd, CONFIG_DIR_NAME, "settings.json");
    const projectConfig = readPruneChunksSettings(projectPath, "trusted project");
    if (projectConfig) {
      raw = mergeRawPruneConfig(raw, projectConfig);
      sources.push(`project ${projectPath}`);
    }
  }

  const projectNote = cwd
    ? isTrustedProject(ctx)
      ? "trusted project settings checked"
      : "project settings ignored because project is not trusted"
    : "no project cwd available";
  return {
    raw,
    sourceSummary: sources.length > 0 ? sources.join("; ") : `defaults (${projectNote})`,
  };
}

function readPruneChunksSettings(
  settingsPath: string,
  label: "global" | "trusted project",
): RawPruneChunksConfig | undefined {
  if (!existsSync(settingsPath)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(
      `Invalid ${label} settings at ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid ${label} settings at ${settingsPath}: expected a JSON object`);
  }
  const raw = (parsed as { pruneChunks?: unknown }).pruneChunks;
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Invalid ${label} pruneChunks settings at ${settingsPath}: expected an object`);
  }
  return raw as RawPruneChunksConfig;
}

function mergeRawPruneConfig(
  base: RawPruneChunksConfig | undefined,
  override: RawPruneChunksConfig,
): RawPruneChunksConfig {
  return deepMergePlainObjects(base ?? {}, override) as RawPruneChunksConfig;
}

function deepMergePlainObjects(base: Record<string, unknown>, override: Record<string, unknown>) {
  const output: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = output[key];
    output[key] =
      isPlainObject(existing) && isPlainObject(value)
        ? deepMergePlainObjects(existing, value)
        : cloneJsonValue(value);
  }
  return output;
}

function cloneJsonValue<T>(value: T): T {
  if (value === undefined) return value;
  return structuredClone(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function configCwd(ctx?: unknown): string | undefined {
  const candidate = ctx as ConfigLoadContext | undefined;
  if (typeof candidate?.cwd === "string") return candidate.cwd;
  const sessionCwd = candidate?.sessionManager?.getCwd?.();
  return typeof sessionCwd === "string" ? sessionCwd : undefined;
}

function isTrustedProject(ctx?: unknown): boolean {
  const trust = (ctx as ConfigLoadContext | undefined)?.isProjectTrusted;
  return typeof trust === "function" && trust() === true;
}

function currentBranchEntries(ctx?: unknown): unknown[] {
  const sessionManager = (ctx as { sessionManager?: unknown } | undefined)?.sessionManager as
    | {
        getBranch?: () => unknown[];
        getEntries?: () => unknown[];
      }
    | undefined;
  return sessionManager?.getBranch?.() ?? sessionManager?.getEntries?.() ?? [];
}

function rebuildRegistry(
  registry: ChunkRegistry,
  entries: unknown[],
  config: PruneChunksConfig,
): string[] {
  registry.reset();
  const paramsByToolCall = new Map<string, Record<string, unknown>>();
  const entryIndexById = new Map<string, number>();
  const resultIndexByToolCall = new Map<string, number>();
  const compactedIds = new Set<string>();

  for (const [entryIndex, entry] of entries.entries()) {
    const parsed = entry as {
      type?: string;
      id?: string;
      customType?: string;
      data?: unknown;
      timestamp?: string;
      firstKeptEntryId?: string;
      message?: {
        role?: string;
        toolCallId?: string;
        toolName?: string;
        content?: ContentBlock[];
      };
    };
    if (parsed.id) entryIndexById.set(parsed.id, entryIndex);
    if (parsed.type === "message" && parsed.message?.role === "assistant") {
      for (const block of normalizeContent(parsed.message.content)) {
        if (block.type === "toolCall" && typeof block.id === "string") {
          paramsByToolCall.set(
            block.id,
            block.arguments && typeof block.arguments === "object" ? block.arguments : {},
          );
        }
      }
      continue;
    }
    if (parsed.type === "message" && parsed.message?.role === "toolResult") {
      const toolCallId = String(parsed.message.toolCallId ?? "");
      const toolName = String(parsed.message.toolName ?? "unknown");
      if (!toolCallId) continue;
      const collected = collectToolResult({
        toolCallId,
        toolName,
        content: normalizeContent(parsed.message.content),
        params: paramsByToolCall.get(toolCallId),
        config,
      });
      if (!collected) continue;
      const timestamp = Date.parse(parsed.timestamp ?? "");
      registry.addCollected(collected, Number.isFinite(timestamp) ? timestamp : Date.now());
      registry.markSeenByToolCallId(
        toolCallId,
        Number.isFinite(timestamp) ? timestamp : Date.now(),
      );
      resultIndexByToolCall.set(toolCallId, entryIndex);
    }
  }

  for (const entry of entries) {
    const parsed = entry as {
      type?: string;
      customType?: string;
      data?: unknown;
      firstKeptEntryId?: string;
    };
    const delta = persistedDelta(parsed.type, parsed.customType, parsed.data);
    if (delta) {
      for (const action of delta.actions) registry.applyDelta(action);
      continue;
    }
    if (parsed.type !== "compaction" || !parsed.firstKeptEntryId) continue;
    const cutoff = entryIndexById.get(parsed.firstKeptEntryId);
    if (cutoff == null) continue;
    const ids = registry
      .active()
      .filter(
        (chunk) =>
          !chunk.parentId &&
          !!chunk.source?.toolCallId &&
          (resultIndexByToolCall.get(chunk.source.toolCallId) ?? Number.POSITIVE_INFINITY) < cutoff,
      )
      .map((chunk) => chunk.id);
    const results = registry.prune(ids, "retired by Pi compaction", "auto_pruned");
    for (const result of results) {
      if (result.status === "pruned") compactedIds.add(result.id);
    }
  }
  return [...compactedIds];
}

function persistedDelta(
  type: string | undefined,
  customType: string | undefined,
  data: unknown,
): PersistedStateDelta | undefined {
  if (type !== "custom" || customType !== STATE_TYPE || !data || typeof data !== "object") {
    return undefined;
  }
  const candidate = data as Partial<PersistedStateDelta>;
  if (candidate.version !== 3 || !Array.isArray(candidate.actions)) return undefined;
  return candidate as PersistedStateDelta;
}

function planForIds(registry: ChunkRegistry, ids: string[], reason: string): RetirementPlan {
  const candidates = ids
    .map((id) => registry.get(id))
    .filter((chunk): chunk is NonNullable<typeof chunk> => !!chunk && !chunk.pruned)
    .map((chunk) => ({
      id: chunk.id,
      label: chunk.label,
      kind: chunk.kind,
      risk: chunk.risk,
      tokenEstimate: chunk.tokenEstimate,
      reason,
    }));
  return {
    cause: "manual",
    targetTokens: null,
    activeTokens: registry.summary().activeTokens,
    targetSavings: candidates.reduce((sum, item) => sum + item.tokenEstimate, 0),
    estimatedSavings: candidates.reduce((sum, item) => sum + item.tokenEstimate, 0),
    candidates,
  };
}

function normalizeContent(content: unknown): ContentBlock[] {
  if (Array.isArray(content)) return content as ContentBlock[];
  if (typeof content === "string") return [{ type: "text", text: content }];
  return [];
}

function extractParams(event: Record<string, unknown>): Record<string, unknown> | undefined {
  const possible = event.params ?? event.input ?? event.args ?? event.toolInput;
  return possible && typeof possible === "object" && !Array.isArray(possible)
    ? (possible as Record<string, unknown>)
    : undefined;
}

function extractScope(event: Record<string, unknown>): ChunkScope | undefined {
  const metadata = objectValue(event.metadata) ?? objectValue(event.context) ?? {};
  const params = extractParams(event) ?? {};
  const rawScope =
    stringValue(event.scope) ??
    stringValue(metadata.scope) ??
    stringValue(params.scope) ??
    stringValue(metadata.runScope);
  const runId =
    stringValue(event.runId) ?? stringValue(metadata.runId) ?? stringValue(params.runId);
  const parentRunId =
    stringValue(event.parentRunId) ??
    stringValue(metadata.parentRunId) ??
    stringValue(params.parentRunId);
  const agentName =
    stringValue(event.agentName) ??
    stringValue(metadata.agentName) ??
    stringValue(params.agentName) ??
    stringValue(metadata.agent);
  const scope = normalizeScope(rawScope, { runId, parentRunId, agentName });
  if (scope === "main" && !runId && !parentRunId && !agentName) return undefined;
  return { scope, runId, parentRunId, agentName };
}

function normalizeScope(
  raw: string | undefined,
  hints: { runId?: string; parentRunId?: string; agentName?: string },
): ChunkScopeKind {
  const normalized = raw?.toLowerCase();
  if (normalized === "subagent" || normalized === "agent" || normalized === "child") {
    return "subagent";
  }
  if (normalized === "chain" || normalized === "multi-agent" || normalized === "multiagent") {
    return "chain";
  }
  if (normalized === "main" || normalized === "root") return "main";
  if (hints.parentRunId || hints.agentName) return "subagent";
  return "main";
}

function getUsage(ctx: unknown): ContextUsage | null {
  const getter = (ctx as { getContextUsage?: () => ContextUsage | null } | undefined)
    ?.getContextUsage;
  return typeof getter === "function" ? getter.call(ctx) : null;
}

export function preserveContext(
  messages: Array<{ role: string; content?: ContentBlock[] }>,
  ctx: unknown,
): PreserveContext {
  const text = latestUserAndAssistantText(messages);
  return {
    ids: new Set(text.match(/pc_[0-9a-f]{12}(?:#[a-z0-9_-]+)?/g) ?? []),
    paths: new Set([...pathsReferencedInText(text), ...modifiedPaths(ctx)].map(normalizePath)),
    anchors: new Set(extractReasoningAnchors(text)),
  };
}

function latestUserAndAssistantText(
  messages: Array<{ role: string; content?: ContentBlock[] }>,
): string {
  const parts: string[] = [];
  let sawAssistant = false;
  let sawUser = false;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "assistant" && !sawAssistant) {
      parts.push(textFromContent(message.content));
      sawAssistant = true;
    } else if (message.role === "user" && !sawUser) {
      parts.push(textFromContent(message.content));
      sawUser = true;
    }
    if (sawAssistant && sawUser) break;
  }
  return parts.join("\n");
}

function textFromContent(content: unknown): string {
  return normalizeContent(content)
    .map((block) => block.text ?? "")
    .join("\n");
}

function pathsReferencedInText(text: string): string[] {
  const matches = text.match(
    /(?:^|[\s"'(`])((?:\.\/|\.\.\/|\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+)/gm,
  );
  if (!matches) return [];
  return matches.map((match) => match.trim().replace(/^["'(`]+|[),.;:"'`]+$/g, "")).filter(Boolean);
}

function modifiedPaths(ctx: unknown): string[] {
  const values = [
    (ctx as { modifiedFiles?: unknown } | undefined)?.modifiedFiles,
    (ctx as { modifiedFilePaths?: unknown } | undefined)?.modifiedFilePaths,
    (ctx as { git?: { modifiedFiles?: unknown } } | undefined)?.git?.modifiedFiles,
    (ctx as { git?: { modifiedFilePaths?: unknown } } | undefined)?.git?.modifiedFilePaths,
  ];
  const paths: string[] = [];
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === "string") paths.push(item);
      else if (item && typeof item === "object") {
        const candidate =
          (item as { path?: unknown }).path ??
          (item as { file?: unknown }).file ??
          (item as { filePath?: unknown }).filePath;
        if (typeof candidate === "string") paths.push(candidate);
      }
    }
  }
  return paths;
}

function toolResultIds(messages: Array<{ role: string; toolCallId?: unknown }>): Set<string> {
  return new Set(
    messages
      .filter((message) => message.role === "toolResult" && message.toolCallId != null)
      .map((message) => String(message.toolCallId)),
  );
}

function estimateProviderTokens(messages: unknown[]): number {
  let characters = 0;
  for (const message of messages) {
    const candidate = message as { role?: string; content?: unknown };
    if (candidate.role === "user" || candidate.role === "toolResult") {
      characters += textFromContent(candidate.content).length;
      continue;
    }
    for (const block of normalizeContent(candidate.content)) {
      if (block.type === "text") characters += block.text?.length ?? 0;
      else if (block.type === "thinking") characters += String(block.thinking ?? "").length;
      else characters += String(block.name ?? "").length + safeJsonLength(block.arguments);
    }
  }
  return Math.ceil(characters / 4);
}

function withProviderEstimateFloor(
  usage: ContextUsage | null,
  messages: unknown[],
): ContextUsage | null {
  if (usage?.contextWindow == null) return usage;
  const tokens = Math.max(usage.tokens ?? 0, estimateProviderTokens(messages));
  return {
    tokens,
    contextWindow: usage.contextWindow,
    percent: (tokens / usage.contextWindow) * 100,
  };
}

function usageAfterRetirement(
  usage: ContextUsage | null | undefined,
  retiredTokens: number,
): ContextUsage | null | undefined {
  if (!usage || usage.tokens == null || retiredTokens <= 0) return usage;
  const tokens = Math.max(0, usage.tokens - retiredTokens);
  return {
    ...usage,
    tokens,
    percent: usage.contextWindow ? (tokens / usage.contextWindow) * 100 : usage.percent,
  };
}

type ProviderUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
};

function assistantProviderUsage(event: unknown): ProviderUsage | undefined {
  const candidate = event as {
    message?: {
      role?: unknown;
      usage?: {
        input?: unknown;
        output?: unknown;
        cacheRead?: unknown;
        cacheWrite?: unknown;
        cost?: { total?: unknown } | unknown;
      };
    };
  };
  if (candidate.message?.role !== "assistant" || !candidate.message.usage) return undefined;
  const usage = candidate.message.usage;
  const cost =
    usage.cost && typeof usage.cost === "object"
      ? numberValue((usage.cost as { total?: unknown }).total)
      : numberValue(usage.cost);
  return {
    input: numberValue(usage.input),
    output: numberValue(usage.output),
    cacheRead: numberValue(usage.cacheRead),
    cacheWrite: numberValue(usage.cacheWrite),
    cost,
  };
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function safeJsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 16;
  }
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function currentWorkingDirectory(ctx: unknown): string | undefined {
  const cwd = (ctx as { cwd?: unknown } | undefined)?.cwd;
  return typeof cwd === "string" ? cwd : undefined;
}

function notify(ctx: unknown, text: string): void {
  const ui = (ctx as { ui?: { notify?: (message: string, level?: string) => void } } | undefined)
    ?.ui;
  if (typeof ui?.notify === "function") ui.notify(text, "info");
}

function parseCommandArgs(args: unknown): string[] {
  if (Array.isArray(args)) return args.map(String);
  if (typeof args === "string") return args.trim().split(/\s+/).filter(Boolean);
  if (
    args &&
    typeof args === "object" &&
    "raw" in args &&
    typeof (args as { raw?: unknown }).raw === "string"
  ) {
    return parseCommandArgs((args as { raw: string }).raw);
  }
  return [];
}

function stringOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function numberOption(args: string[], name: string): number | undefined {
  const raw = stringOption(args, name);
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function scopeOrUndefined(value: unknown): ChunkScopeKind | undefined {
  return value === "main" || value === "subagent" || value === "chain" ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
