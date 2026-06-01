/**
 * Prune Chunks - restorable context garbage collection for bulky tool results.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { collectToolResult } from "./src/collector";
import { mergeConfig } from "./src/config";
import { autoPrune, suggestPruneCandidates } from "./src/pruner";
import { ChunkRegistry } from "./src/registry";
import {
  contextFooter,
  renderActionResults,
  renderCandidates,
  renderChunkList,
  renderPressure,
} from "./src/render";
import { restoreChunks } from "./src/restorer";
import { applyPrunedTombstones } from "./src/tombstones";
import type {
  ChunkKind,
  ContentBlock,
  ContextUsage,
  PersistedPruneChunksState,
  PreserveContext,
  PruneChunksConfig,
} from "./src/types";

const STATE_TYPE = "prune-chunks-state-v1";

export default function (pi: ExtensionAPI) {
  const config = resolveConfig(pi);
  const registry = new ChunkRegistry();

  function persistState() {
    pi.appendEntry(STATE_TYPE, { state: registry.persistenceState() });
  }

  pi.on("session_start", async (_event, ctx) => {
    const state = latestPersistedState(ctx?.sessionManager?.getEntries?.() ?? []);
    if (state) registry.restorePersistence(state);
  });

  pi.on("session_shutdown", async () => {
    registry.reset();
  });

  pi.on("tool_result", async (event) => {
    const collected = collectToolResult({
      toolCallId: String(event.toolCallId),
      toolName: String(event.toolName),
      content: normalizeContent(event.content),
      params: extractParams(event),
      config,
    });
    if (collected) registry.addCollected(collected);
  });

  pi.on("context", async (event, ctx) => {
    const usage = getUsage(ctx);
    const preserve = preserveContext(event.messages ?? [], ctx);
    const pruneResult = autoPrune(registry, usage, config, { preserve });
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

    const replacement = applyPrunedTombstones(
      event.messages ?? [],
      (toolCallId) => registry.prunedForToolCall(toolCallId),
      config,
    );

    if (replacement.modified) {
      return { messages: replacement.messages };
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
      const results = registry.prune(ids, stringOrUndefined(params.reason));
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
      const results = registry.pin(ids, stringOrUndefined(params.reason));
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
      persistState();
      return {
        content: [{ type: "text", text: renderActionResults("unpinned", ids, results) }],
        details: { results },
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
      const pressure = renderPressure(registry, usage, config, preserveContext([], ctx));
      return {
        content: [{ type: "text", text: pressure }],
        details: { pressure },
      };
    },
  });

  registerCommands(pi, registry, config, persistState);
}

function registerCommands(
  pi: ExtensionAPI,
  registry: ChunkRegistry,
  config: PruneChunksConfig,
  persistState: () => void,
): void {
  pi.registerCommand("prune-status", {
    description: "Show context chunk tracking and pruning status",
    async run(_args, ctx) {
      notify(ctx, renderPressure(registry, getUsage(ctx), config, preserveContext([], ctx)));
    },
  });

  pi.registerCommand("prune-largest", {
    description: "Show largest unpruned chunks",
    async run(args, ctx) {
      const parsed = parseCommandArgs(args);
      const limit = numberOption(parsed, "--limit") ?? 10;
      const kind = kindOrUndefined(stringOption(parsed, "--kind"));
      const output = registry.list({ pruned: false, kind, sortBy: "tokens", limit });
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
      persistState();
      notify(ctx, renderActionResults("restored", ids, results));
    },
  });
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
