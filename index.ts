/**
 * Prune Chunks v0.3 - pressure-only safety rail for bulky tool output.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
  let config: PruneChunksConfig;
  try {
    config = resolveConfig(pi);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pi.log?.("error", message);
    throw error;
  }

  const registry = new ChunkRegistry(createContentCache(config));
  const telemetry = new TelemetryRecorder();
  const pendingArchives = new Set<Promise<void>>();
  let pressureState: PressureSweepState | undefined;
  let pendingProviderRewrite = false;
  let reconcileAfterCompaction = false;

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
    const compactedIds = rebuildRegistry(
      registry,
      ctx?.sessionManager?.getEntries?.() ?? [],
      config,
    );
    scheduleArchive(compactedIds);
    pressureState = undefined;
    pendingProviderRewrite = false;
    reconcileAfterCompaction = false;
  });

  pi.on("session_shutdown", async () => {
    await Promise.allSettled([...pendingArchives]);
    registry.reset();
    telemetry.reset();
    pressureState = undefined;
    pendingProviderRewrite = false;
    reconcileAfterCompaction = false;
  });

  pi.on("session_compact", async () => {
    telemetry.recordCompaction();
    pressureState = undefined;
    reconcileAfterCompaction = true;
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

    if (shouldRunPressureSweep(usage, config, pressureState)) {
      const pressure = pressureRetirementPlan(registry, usage, config, { preserve });
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

    // A result becomes pressure-eligible only after one provider pass.
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
    const providerUsage = assistantProviderUsage(event);
    if (!providerUsage) return;
    telemetry.recordProviderResponse(providerUsage, pendingProviderRewrite);
    pendingProviderRewrite = false;
  });

  registerCommands(pi, registry, config, telemetry, retirePlan, persistActions);
}

function registerCommands(
  pi: ExtensionAPI,
  registry: ChunkRegistry,
  config: PruneChunksConfig,
  telemetry: TelemetryRecorder,
  retirePlan: (
    plan: RetirementPlan,
    automatic: boolean,
    reason?: string,
  ) => ReturnType<ChunkRegistry["prune"]>,
  persistActions: (actions: StateDeltaAction[]) => void,
): void {
  pi.registerCommand("prune-status", {
    description: "Show pressure safety-rail and tracked tool output status",
    async handler(_args, ctx) {
      notify(ctx, renderStatus(registry, getUsage(ctx), config));
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
      const plan = manualRetirementPlan(registry, config, {
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
          : manualRetirementPlan(registry, config, {
              limit,
              preserve: preserveContext([], ctx),
            });
      if (parsed.includes("--dry-run")) {
        notify(ctx, renderCandidates(plan.candidates));
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
      const results = await restoreChunks(registry, ids, config, {
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

function createContentCache(config: PruneChunksConfig) {
  const memory = new MemoryChunkContentCache();
  if (!config.restore.diskCache.enabled) return memory;
  return new CompositeChunkContentCache(
    memory,
    new DiskChunkContentCache(config.restore.diskCache),
  );
}

function resolveConfig(pi: ExtensionAPI): PruneChunksConfig {
  const raw =
    (pi as unknown as { config?: { pruneChunks?: RawPruneChunksConfig } }).config?.pruneChunks ??
    (pi as unknown as { settings?: { pruneChunks?: RawPruneChunksConfig } }).settings?.pruneChunks;
  return mergeConfig(raw);
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
