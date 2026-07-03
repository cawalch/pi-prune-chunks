/**
 * Prune Chunks - restorable context garbage collection for bulky tool results.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { collectToolResult } from "./src/collector";
import { mergeConfig } from "./src/config";
import { compactFailedToolValidationMessages } from "./src/contextGuards";
import { CompositeChunkContentCache, DiskChunkContentCache } from "./src/diskCache";
import {
  isCompactionImminent,
  prepareContinuationManifest,
  renderContinuationManifestPreview,
} from "./src/manifest";
import {
  autoPrune,
  contextPercent,
  pruneReamerxExploratoryAfterTerminal,
  pruneSupersededAfterCollect,
  suggestPruneCandidates,
} from "./src/pruner";
import { ChunkRegistry, MemoryChunkContentCache } from "./src/registry";
import {
  contextFooter,
  renderActionResults,
  renderCandidates,
  renderChunkList,
  renderPressure,
} from "./src/render";
import { restoreChunks } from "./src/restorer";
import {
  renderTelemetryReport,
  TelemetryRecorder,
  telemetryTombstoneTokens,
} from "./src/telemetry";
import { applyPrunedTombstones } from "./src/tombstones";
import type {
  ChunkKind,
  ChunkScope,
  ChunkScopeKind,
  ContentBlock,
  ContextUsage,
  ContinuationManifest,
  PersistedPruneChunksState,
  PreserveContext,
  PruneChunksConfig,
} from "./src/types";

const STATE_TYPE = "prune-chunks-state-v1";

export default function (pi: ExtensionAPI) {
  const config = resolveConfig(pi);
  const registry = new ChunkRegistry(createContentCache(config));
  const telemetry = new TelemetryRecorder();
  let continuationManifest: ContinuationManifest | undefined;

  function persistState() {
    const state = registry.persistenceState();
    state.telemetry = telemetry.persistenceState();
    state.continuationManifest = continuationManifest;
    pi.appendEntry(STATE_TYPE, { state });
  }

  pi.on("session_start", async (_event, ctx) => {
    const state = latestPersistedState(ctx?.sessionManager?.getEntries?.() ?? []);
    if (state) {
      registry.restorePersistence(state);
      telemetry.restorePersistence(state.telemetry);
      continuationManifest = state.continuationManifest;
    }
  });

  pi.on("session_shutdown", async () => {
    registry.reset();
    telemetry.restorePersistence([]);
    continuationManifest = undefined;
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
    if (collected) {
      const chunk = registry.addCollected(collected);
      telemetry.recordCollected(chunk);
      const stalePrune = pruneSupersededAfterCollect(registry, chunk, config);
      telemetry.recordActionResults("auto_prune", stalePrune.pruned, "superseded on ingest");
      const reamerxPrune = pruneReamerxExploratoryAfterTerminal(registry, chunk, config);
      telemetry.recordActionResults(
        "auto_prune",
        reamerxPrune.pruned,
        "ReamerX exploratory superseded",
      );
      if (
        stalePrune.pruned.some((result) => result.status === "pruned") ||
        reamerxPrune.pruned.some((result) => result.status === "pruned")
      ) {
        persistState();
      }
    }
  });

  pi.on("context", async (event, ctx) => {
    const usage = getUsage(ctx);
    const preserve = preserveContext(event.messages ?? [], ctx);
    const continuationPrep = prepareContinuationManifest(registry, usage, config, preserve);
    if (continuationPrep.manifest) continuationManifest = continuationPrep.manifest;
    if (continuationPrep.manifest || continuationPrep.pinnedIds.length > 0) persistState();
    const pruneResult = autoPrune(registry, usage, config, { preserve });
    telemetry.recordActionResults("auto_prune", pruneResult.pruned, pruneResult.reason);
    if (pruneResult.pruned.some((result) => result.status === "pruned")) {
      persistState();
      if (ctx?.hasUI) {
        ctx.ui.notify(
          `Auto-pruned ${pruneResult.pruned.length} chunks, ~${pruneResult.savedTokens} tokens saved.`,
          "info",
        );
      }
    }

    for (const message of event.messages ?? []) {
      if (message.role === "toolResult" && message.toolCallId) {
        registry.markSeenByToolCallId(String(message.toolCallId));
      }
    }

    if (ctx?.hasUI) {
      ctx.ui.setStatus("prune-chunks", contextFooter(registry, usage));
    }

    const tombstones = applyPrunedTombstones(
      event.messages ?? [],
      (toolCallId) => registry.prunedForToolCall(toolCallId),
      config,
      {
        compact: shouldCompactTombstones(usage, config),
        coalesce: shouldCoalesceTombstones(usage, config),
      },
      (toolCallId) => registry.prunedPartsForToolCall(toolCallId),
    );
    const guarded = compactFailedToolValidationMessages(tombstones.messages, config);

    if (tombstones.modified || guarded.modified) {
      telemetry.recordTombstones({
        tombstoneTokens: telemetryTombstoneTokens(guarded.messages),
        coalesced: tombstones.coalesced,
        coalescedCount: tombstones.coalescedCount,
      });
      return { messages: guarded.messages };
    }
  });

  pi.registerTool({
    name: "list_context_chunks",
    label: "List context chunks",
    description:
      "List tracked restorable tool-result chunks with token estimates, kind, risk, pin/prune state, source, and restore availability.",
    promptSnippet: "List tracked context chunks and their prune/restore metadata",
    promptGuidelines: [
      "Use list_context_chunks before manual pruning or restoring.",
      "Prefer pruning old, low-risk, restorable chunks that are no longer task-critical.",
    ],
    parameters: Type.Object({
      toolName: Type.Optional(Type.String({ description: "Filter by exact tool name" })),
      kind: Type.Optional(Type.String({ description: "Filter by chunk kind" })),
      pruned: Type.Optional(Type.Boolean({ description: "Filter by pruned state" })),
      pinned: Type.Optional(Type.Boolean({ description: "Filter by pinned state" })),
      minTokens: Type.Optional(
        Type.Number({ description: "Only show chunks at or above this token estimate" }),
      ),
      scope: Type.Optional(
        Type.String({ description: "Filter by scope: main, subagent, or chain" }),
      ),
      limit: Type.Optional(Type.Number({ description: "Maximum rows to return, default 20" })),
      sortBy: Type.Optional(Type.String({ description: "tokens, age, recent, or risk" })),
    }),
    async execute(_toolCallId, params) {
      const output = registry.list({
        toolName: stringOrUndefined(params.toolName),
        kind: kindOrUndefined(params.kind),
        pruned: booleanOrUndefined(params.pruned),
        pinned: booleanOrUndefined(params.pinned),
        minTokens: numberOrUndefined(params.minTokens),
        scope: scopeOrUndefined(params.scope),
        limit: numberOrUndefined(params.limit),
        sortBy: sortOrUndefined(params.sortBy),
      });
      return {
        content: [{ type: "text", text: renderChunkList(output) }],
        details: output,
      };
    },
  });

  pi.registerTool({
    name: "prune_chunks",
    label: "Prune context chunks",
    description:
      "Mark selected chunks as pruned. Pruned tool results are replaced with tombstones in provider context only.",
    promptSnippet: "Prune selected context chunks by id",
    promptGuidelines: [
      "Pass explicit chunk ids from list_context_chunks.",
      "Do not prune recent failures, current diff summaries, or user/PR constraints.",
    ],
    parameters: Type.Object({
      ids: Type.Array(Type.String({ description: "Chunk ids to prune" })),
      reason: Type.Optional(Type.String({ description: "Reason for audit trail" })),
    }),
    async execute(_toolCallId, params) {
      const ids = arrayOfStrings(params.ids);
      const reason = stringOrUndefined(params.reason);
      const results = registry.prune(ids, reason);
      telemetry.recordActionResults("manual_prune", results, reason);
      persistState();
      return {
        content: [{ type: "text", text: renderActionResults("pruned", ids, results) }],
        details: { results },
      };
    },
  });

  pi.registerTool({
    name: "restore_chunks",
    label: "Restore context chunks",
    description:
      "Restore selected pruned chunks using same-session memory first, then source rehydration when available.",
    promptSnippet: "Restore pruned context chunks by id",
    promptGuidelines: ["Use restore_chunks when a tombstoned result is needed again."],
    parameters: Type.Object({
      ids: Type.Array(Type.String({ description: "Chunk ids to restore" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const ids = arrayOfStrings(params.ids);
      const results = await restoreChunks(registry, ids, config, {
        cwd: currentWorkingDirectory(ctx),
      });
      telemetry.recordRestoreResults(results);
      persistState();
      return {
        content: [{ type: "text", text: renderActionResults("restored", ids, results) }],
        details: { results },
      };
    },
  });

  pi.registerTool({
    name: "pin_chunks",
    label: "Pin context chunks",
    description: "Pin chunks so the auto-prune policy will not prune them.",
    promptSnippet: "Pin selected context chunks",
    promptGuidelines: [
      "Pin current failures, active plans, and chunks that are still task-critical.",
    ],
    parameters: Type.Object({
      ids: Type.Array(Type.String({ description: "Chunk ids to pin" })),
      reason: Type.Optional(Type.String({ description: "Reason for audit trail" })),
    }),
    async execute(_toolCallId, params) {
      const ids = arrayOfStrings(params.ids);
      const reason = stringOrUndefined(params.reason);
      const results = registry.pin(ids, reason);
      telemetry.recordActionResults("pin", results, reason);
      persistState();
      return {
        content: [{ type: "text", text: renderActionResults("pinned", ids, results) }],
        details: { results },
      };
    },
  });

  pi.registerTool({
    name: "unpin_chunks",
    label: "Unpin context chunks",
    description: "Unpin chunks so they can be considered by the auto-prune policy again.",
    promptSnippet: "Unpin selected context chunks",
    parameters: Type.Object({
      ids: Type.Array(Type.String({ description: "Chunk ids to unpin" })),
    }),
    async execute(_toolCallId, params) {
      const ids = arrayOfStrings(params.ids);
      const results = registry.unpin(ids);
      telemetry.recordActionResults("unpin", results);
      persistState();
      return {
        content: [{ type: "text", text: renderActionResults("unpinned", ids, results) }],
        details: { results },
      };
    },
  });

  pi.registerTool({
    name: "context_report",
    label: "Context telemetry report",
    description:
      "Return a Markdown telemetry report for tracked/pruned/restored chunks without raw tool output.",
    promptSnippet: "Generate a context pruning telemetry report",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const usage = getUsage(ctx);
      const snapshot = telemetry.snapshot(registry.summary(), config, usage);
      const report = renderTelemetryReport(snapshot);
      return {
        content: [{ type: "text", text: report }],
        details: snapshot,
      };
    },
  });

  pi.registerTool({
    name: "context_pressure",
    label: "Context pressure",
    description: "Return context chunk pressure, largest active chunks, and safe prune candidates.",
    promptSnippet: "Inspect context pressure and recommended prune candidates",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const usage = getUsage(ctx);
      const preserve = preserveContext([], ctx);
      const prep = prepareContinuationManifest(registry, usage, config, preserve);
      if (prep.manifest) continuationManifest = prep.manifest;
      if (prep.manifest || prep.pinnedIds.length > 0) persistState();
      const pressure = renderPressure(registry, usage, config, preserve, continuationManifest);
      const delta = telemetry.pressureDelta(registry.summary());
      return {
        content: [{ type: "text", text: `${pressure}\n\n${delta}` }],
        details: { pressure, delta, continuationManifest },
      };
    },
  });

  registerCommands(
    pi,
    registry,
    config,
    telemetry,
    () => continuationManifest,
    (manifest) => {
      continuationManifest = manifest;
    },
    persistState,
  );
}

function registerCommands(
  pi: ExtensionAPI,
  registry: ChunkRegistry,
  config: PruneChunksConfig,
  telemetry: TelemetryRecorder,
  getContinuationManifest: () => ContinuationManifest | undefined,
  setContinuationManifest: (manifest: ContinuationManifest | undefined) => void,
  persistState: () => void,
): void {
  pi.registerCommand("prune-status", {
    description: "Show context chunk tracking and pruning status",
    async run(_args, ctx) {
      const usage = getUsage(ctx);
      const preserve = preserveContext([], ctx);
      const prep = prepareContinuationManifest(registry, usage, config, preserve);
      if (prep.manifest) setContinuationManifest(prep.manifest);
      if (prep.manifest || prep.pinnedIds.length > 0) persistState();
      const manifest = getContinuationManifest();
      const pressure = renderPressure(registry, usage, config, preserve, manifest);
      notify(
        ctx,
        isCompactionImminent(usage, config) || manifest
          ? pressure
          : `${pressure}\n\n${renderContinuationManifestPreview(undefined)}`,
      );
    },
  });

  pi.registerCommand("prune-largest", {
    description: "Show largest unpruned chunks",
    async run(args, ctx) {
      const parsed = parseCommandArgs(args);
      const limit = numberOption(parsed, "--limit") ?? 10;
      const kind = kindOrUndefined(stringOption(parsed, "--kind"));
      const scope = scopeOrUndefined(stringOption(parsed, "--scope"));
      const output = registry.list({ pruned: false, kind, scope, sortBy: "tokens", limit });
      notify(ctx, renderChunkList(output));
    },
  });

  pi.registerCommand("prune-suggest", {
    description: "Show safe auto-prune candidates without pruning",
    async run(args, ctx) {
      const parsed = parseCommandArgs(args);
      const limit = numberOption(parsed, "--limit") ?? 10;
      notify(
        ctx,
        renderCandidates(
          suggestPruneCandidates(registry, config, {
            limit,
            preserve: preserveContext([], ctx),
          }),
        ),
      );
    },
  });

  pi.registerCommand("prune-report", {
    description: "Write a Markdown telemetry report for pruning activity",
    async run(args, ctx) {
      const parsed = parseCommandArgs(args);
      const output = stringOption(parsed, "--output") ?? "prune-report.md";
      const report = renderTelemetryReport(
        telemetry.snapshot(registry.summary(), config, getUsage(ctx)),
      );
      const destination = path.resolve(currentWorkingDirectory(ctx) ?? process.cwd(), output);
      await writeFile(destination, report, "utf8");
      notify(ctx, `Wrote prune telemetry report to ${output}`);
    },
  });

  pi.registerCommand("prune-now", {
    description: "Apply safe auto-pruning immediately",
    async run(args, ctx) {
      const parsed = parseCommandArgs(args);
      const dryRun = parsed.includes("--dry-run");
      const target = numberOption(parsed, "--target");
      const candidates = suggestPruneCandidates(registry, config, {
        limit: config.autoPrune.maxChunksPerPass,
        preserve: preserveContext([], ctx),
      });
      const ids = pickCandidateIds(
        candidates,
        target,
        getUsage(ctx),
        registry.summary().activeTokens,
      );
      if (dryRun) {
        notify(
          ctx,
          ids.length === 0
            ? "No safe prune candidates found."
            : renderCandidates(candidates.filter((c) => ids.includes(c.id))),
        );
        return;
      }
      const results = registry.prune(ids, "manual /prune-now", "auto_pruned");
      telemetry.recordActionResults("auto_prune", results, "manual /prune-now");
      persistState();
      notify(ctx, renderActionResults("pruned", ids, results));
    },
  });

  pi.registerCommand("prune-restore", {
    description: "Restore pruned chunks by ID",
    async run(args, ctx) {
      const ids = idsFromCommandArgs(parseCommandArgs(args));
      if (ids.length === 0) {
        notify(ctx, "Usage: /prune-restore <id> [id...]");
        return;
      }
      const results = await restoreChunks(registry, ids, config, {
        cwd: currentWorkingDirectory(ctx),
      });
      telemetry.recordRestoreResults(results);
      persistState();
      notify(ctx, renderActionResults("restored", ids, results));
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
    (pi as unknown as { config?: { pruneChunks?: Partial<PruneChunksConfig> } }).config
      ?.pruneChunks ??
    (pi as unknown as { settings?: { pruneChunks?: Partial<PruneChunksConfig> } }).settings
      ?.pruneChunks;
  return mergeConfig(raw);
}

function latestPersistedState(entries: unknown[]): PersistedPruneChunksState | undefined {
  let latest: PersistedPruneChunksState | undefined;
  for (const entry of entries) {
    const candidate = entry as {
      type?: string;
      customType?: string;
      data?: { state?: PersistedPruneChunksState } | PersistedPruneChunksState;
    };
    if (candidate.type !== "custom" || candidate.customType !== STATE_TYPE || !candidate.data)
      continue;
    if ("state" in candidate.data) {
      latest = candidate.data.state;
    } else if (isPersistedState(candidate.data)) {
      latest = candidate.data;
    }
  }
  return latest;
}

function isPersistedState(value: unknown): value is PersistedPruneChunksState {
  return (
    !!value &&
    typeof value === "object" &&
    (value as PersistedPruneChunksState).version === 1 &&
    Array.isArray((value as PersistedPruneChunksState).chunks) &&
    Array.isArray((value as PersistedPruneChunksState).audit)
  );
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
    ids: new Set(text.match(/pc_[0-9a-z]+_[0-9a-f]{6}/g) ?? []),
    paths: new Set([...pathsReferencedInText(text), ...modifiedPaths(ctx)].map(normalizePath)),
  };
}

function latestUserAndAssistantText(
  messages: Array<{ role: string; content?: ContentBlock[] }>,
): string {
  const parts: string[] = [];
  let sawAssistant = false;
  let sawUser = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "assistant" && !sawAssistant) {
      parts.push(
        normalizeContent(message.content)
          .map((block) => block.text ?? "")
          .join("\n"),
      );
      sawAssistant = true;
    } else if (message.role === "user" && !sawUser) {
      parts.push(
        normalizeContent(message.content)
          .map((block) => block.text ?? "")
          .join("\n"),
      );
      sawUser = true;
    }
    if (sawAssistant && sawUser) break;
  }
  return parts.join("\n");
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
    (ctx as { git?: { modifiedFiles?: unknown; modifiedFilePaths?: unknown } } | undefined)?.git
      ?.modifiedFiles,
    (ctx as { git?: { modifiedFiles?: unknown; modifiedFilePaths?: unknown } } | undefined)?.git
      ?.modifiedFilePaths,
  ];

  const paths: string[] = [];
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === "string") {
        paths.push(item);
      } else if (item && typeof item === "object") {
        const pathValue =
          (item as { path?: unknown }).path ??
          (item as { file?: unknown }).file ??
          (item as { filePath?: unknown }).filePath;
        if (typeof pathValue === "string") paths.push(pathValue);
      }
    }
  }
  return paths;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function currentWorkingDirectory(ctx: unknown): string | undefined {
  const cwd = (ctx as { cwd?: unknown } | undefined)?.cwd;
  return typeof cwd === "string" ? cwd : undefined;
}

function shouldCompactTombstones(usage: ContextUsage | null, config: PruneChunksConfig): boolean {
  if (shouldCoalesceTombstones(usage, config)) return true;
  const pct = contextPercent(usage);
  if (pct != null && pct >= config.tombstones.compactAtPercent) return true;
  return !!usage?.contextWindow && usage.tokens != null && usage.tokens > usage.contextWindow;
}

function shouldCoalesceTombstones(usage: ContextUsage | null, config: PruneChunksConfig): boolean {
  const pct = contextPercent(usage);
  if (pct != null && pct >= config.tombstones.coalesceAtPercent) return true;
  return !!usage?.contextWindow && usage.tokens != null && usage.tokens > usage.contextWindow;
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

function idsFromCommandArgs(args: string[]): string[] {
  return args
    .filter((arg) => !arg.startsWith("--"))
    .flatMap((arg) => arg.split(","))
    .map((arg) => arg.trim())
    .filter(Boolean);
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

function pickCandidateIds(
  candidates: ReturnType<typeof suggestPruneCandidates>,
  targetTokens: number | undefined,
  usage: ContextUsage | null,
  activeTokens: number,
): string[] {
  if (targetTokens == null) return candidates.map((candidate) => candidate.id);

  const currentTokens = usage?.tokens ?? activeTokens;
  let toFree = Math.max(0, currentTokens - targetTokens);
  const ids: string[] = [];
  for (const candidate of candidates) {
    if (toFree <= 0) break;
    ids.push(candidate.id);
    toFree -= candidate.tokenEstimate;
  }
  return ids;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function kindOrUndefined(value: unknown): ChunkKind | undefined {
  const kind = stringOrUndefined(value);
  if (
    kind === "file_read" ||
    kind === "search" ||
    kind === "flow_trace" ||
    kind === "context_pack" ||
    kind === "shell" ||
    kind === "test_output" ||
    kind === "diff" ||
    kind === "outline" ||
    kind === "symbol" ||
    kind === "other"
  ) {
    return kind;
  }
  return undefined;
}

function sortOrUndefined(value: unknown): "tokens" | "age" | "recent" | "risk" | undefined {
  const sort = stringOrUndefined(value);
  if (sort === "tokens" || sort === "age" || sort === "recent" || sort === "risk") return sort;
  return undefined;
}

function scopeOrUndefined(value: unknown): ChunkScopeKind | undefined {
  const scope = stringOrUndefined(value);
  if (scope === "main" || scope === "subagent" || scope === "chain") return scope;
  return undefined;
}

function normalizeScope(
  raw: string | undefined,
  hints: { runId?: string; parentRunId?: string; agentName?: string },
): ChunkScopeKind {
  const normalized = raw?.toLowerCase();
  if (normalized === "subagent" || normalized === "child" || normalized === "agent") {
    return "subagent";
  }
  if (normalized === "chain") return "chain";
  if (normalized === "main" || normalized === "parent") return "main";
  if (hints.parentRunId || hints.agentName) return "subagent";
  return "main";
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
