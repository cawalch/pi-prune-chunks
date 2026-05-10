/**
 * Prune Chunks — Context management companion for pi/Reamer/FlowTrace tool outputs.
 *
 * Tracks tool-result chunks, lets the agent list/prune/restore them.
 * Pruning replaces content with compact tombstones in the `context` hook,
 * preserving provenance without burning tokens.
 *
 * Usage:
 *   pi --extension path/to/pi-prune-chunks
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  ChunkTracker,
  checkPruneStreak,
  contextFooter,
  hardThresholdCheck,
  softThresholdCheck,
  tombstoneFor,
} from "./src/tracker";

const STATE_TYPE = "prune-chunks-state";

export default function (pi: ExtensionAPI) {
  const tracker = new ChunkTracker();

  // Threshold enforcement state
  let softThresholdActive = false;

  // Streak prevention state
  let consecutivePruneCount = 0;

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  function persistState() {
    pi.appendEntry(STATE_TYPE, { meta: tracker.persistenceMeta() });
  }

  // -----------------------------------------------------------------------
  // Hook: session_start — restore pruned set
  // -----------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === STATE_TYPE) {
        const data = entry.data as {
          meta?: Record<string, { pruned: boolean; pruneReason?: string }>;
        };
        if (data?.meta) {
          tracker.restorePrunedSet(data.meta);
        }
      }
    }
  });

  // -----------------------------------------------------------------------
  // Hook: tool_result — catalogue new chunks
  // -----------------------------------------------------------------------

  pi.on("tool_result", async (event, _ctx) => {
    tracker.catalogue(
      event.toolCallId,
      event.toolName,
      event.content as Array<{ type: string; text?: string }>,
    );
  });

  // -----------------------------------------------------------------------
  // Hook: context — replace pruned chunks with tombstones
  // -----------------------------------------------------------------------

  pi.on("context", async (event, ctx) => {
    let modified = false;
    let messages = event.messages;

    // 1. Replace pruned chunks with tombstones
    const prunedIds = tracker.prunedIds();
    if (prunedIds.size > 0) {
      messages = messages.map((msg) => {
        if (msg.role !== "toolResult") return msg;
        if (!prunedIds.has(msg.toolCallId)) return msg;

        const chunk = tracker.get(msg.toolCallId);
        if (!chunk) return msg;

        modified = true;
        return {
          ...msg,
          content: tombstoneFor(chunk),
        };
      });
    }

    // 2. Append context usage footer for agent visibility
    const usage = ctx.getContextUsage();
    if (usage) {
      const summary = tracker.statusSummary();
      const footer = contextFooter(usage.tokens, usage.limit, summary);

      // Append as a user-scope tool result after the last message
      // so the model sees it in its next observation
      messages = [
        ...messages,
        {
          role: "toolResult" as const,
          toolCallId: "__prune_chunks_usage__",
          content: [{ type: "text" as const, text: footer }],
        },
      ];
      modified = true;

      // 3. Soft threshold warning — shift from exploration to selective retention
      const softCheck = softThresholdCheck(usage.tokens, usage.limit, 0.5, softThresholdActive);
      softThresholdActive = softCheck.isActive;
      if (softCheck.shouldWarn && softCheck.message) {
        messages = [
          ...messages,
          {
            role: "toolResult" as const,
            toolCallId: "__prune_chunks_soft_warning__",
            content: [{ type: "text" as const, text: softCheck.message }],
          },
        ];
      }
    }

    if (modified) {
      return { messages };
    }
  });

  // -----------------------------------------------------------------------
  // Hook: tool_call — hard cutoff enforcement near context limit
  // -----------------------------------------------------------------------

  const ALWAYS_ALLOWED_TOOLS = new Set(["list_context_chunks", "prune_chunks", "restore_chunks"]);

  pi.on("tool_call", async (event, ctx) => {
    // Reset prune streak counter on non-prune tool calls
    if (event.toolName !== "prune_chunks") {
      consecutivePruneCount = 0;
    }

    if (ALWAYS_ALLOWED_TOOLS.has(event.toolName)) return;

    const usage = ctx.getContextUsage();
    if (!usage) return;

    const check = hardThresholdCheck(usage.tokens, usage.limit, 0.9);
    if (check.shouldBlock) {
      return {
        block: true,
        reason: check.message!,
      };
    }
  });

  // -----------------------------------------------------------------------
  // Tool: list_context_chunks
  // -----------------------------------------------------------------------

  pi.registerTool({
    name: "list_context_chunks",
    label: "List context chunks",
    description:
      "List tracked tool-result chunks in context. Shows chunk id, tool name, label, " +
      "token estimate, and pruned status. Use this before pruning to identify expendable chunks.",
    promptSnippet: "List tracked context chunks and their token estimates",
    promptGuidelines: [
      "Use list_context_chunks to see what tool results are consuming context before pruning.",
      "After a long sequence of tool calls, use list_context_chunks to identify chunks that are no longer needed.",
    ],
    parameters: Type.Object({
      toolName: Type.Optional(
        Type.String({ description: "Filter by tool name (e.g. code_context, flow_trace)" }),
      ),
      pruned: Type.Optional(
        Type.Boolean({ description: "Filter by pruned status. Default: show all" }),
      ),
      limit: Type.Optional(Type.Number({ description: "Max chunks to list (default 20)" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const output = tracker.list({
        toolName: params.toolName,
        pruned: params.pruned,
        limit: params.limit,
      });

      if (output.chunks.length === 0) {
        return {
          content: [{ type: "text", text: "No tracked chunks found." }],
        };
      }

      return {
        content: [{ type: "text", text: tracker.renderList(output) }],
        details: output,
      };
    },
  });

  // -----------------------------------------------------------------------
  // Tool: prune_chunks
  // -----------------------------------------------------------------------

  pi.registerTool({
    name: "prune_chunks",
    label: "Prune context chunks",
    description:
      "Replace the content of tracked tool-result chunks with compact tombstones, freeing " +
      "context tokens. Pruned chunks remain in the transcript but their content is replaced " +
      "before each LLM call. Use list_context_chunks first to identify expendable chunks.",
    promptSnippet: "Prune context chunks by id to free tokens",
    promptGuidelines: [
      "Use prune_chunks when context is getting large and earlier tool results are no longer needed.",
      "Always list_context_chunks before pruning to identify the right chunk ids.",
      "Pruning is reversible — use restore_chunks to recover pruned content within the same session.",
      "Prefer pruning older chunks from completed exploration steps rather than recent ones.",
    ],
    parameters: Type.Object({
      ids: Type.Array(
        Type.String({ description: "Chunk ids to prune (from list_context_chunks)" }),
        {
          description: "Array of chunk ids to prune",
        },
      ),
      reason: Type.Optional(Type.String({ description: "Reason for pruning (for audit trail)" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      // Streak detection — enforce batching
      consecutivePruneCount++;
      const streakResult = checkPruneStreak(consecutivePruneCount, params.ids.length, 3);

      const results = tracker.prune(params.ids, params.reason);
      const prunedResults = results.filter((r) => r.status === "pruned");
      const freedTokens = prunedResults.reduce((s, r) => s + r.tokens, 0);

      persistState();

      const lines = [
        `Pruned ${prunedResults.length}/${params.ids.length} chunks, freed ~${freedTokens} tokens`,
        "",
        ...results.map((r) => `  ${r.id.slice(0, 36)}: ${r.status} (~${r.tokens}t)`),
      ];

      if (streakResult.shouldWarn && streakResult.message) {
        lines.push("", streakResult.message);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { prunedCount: prunedResults.length, freedTokens, results },
      };
    },
  });

  // -----------------------------------------------------------------------
  // Tool: restore_chunks
  // -----------------------------------------------------------------------

  pi.registerTool({
    name: "restore_chunks",
    label: "Restore pruned chunks",
    description:
      "Restore previously pruned chunks to full content. Only works within the same session " +
      "(original content is not persisted across reloads).",
    promptSnippet: "Restore pruned chunks by id",
    promptGuidelines: [
      "Use restore_chunks to recover pruned content if you realize you still need it.",
      "Restored chunks will reappear with their full content in subsequent LLM calls.",
    ],
    parameters: Type.Object({
      ids: Type.Array(Type.String({ description: "Chunk ids to restore" }), {
        description: "Array of chunk ids to restore",
      }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const results = tracker.restore(params.ids);
      const restoredResults = results.filter((r) => r.status === "restored");
      const restoredTokens = restoredResults.reduce((s, r) => s + r.tokens, 0);

      persistState();

      const lines = [
        `Restored ${restoredResults.length}/${params.ids.length} chunks, ~${restoredTokens} tokens returned`,
        "",
        ...results.map((r) => `  ${r.id.slice(0, 36)}: ${r.status} (~${r.tokens}t)`),
      ];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { restoredCount: restoredResults.length, restoredTokens, results },
      };
    },
  });

  // -----------------------------------------------------------------------
  // Command: /prune-status
  // -----------------------------------------------------------------------

  pi.registerCommand("prune-status", {
    description: "Show context chunk tracking and pruning status",
    async run(_args, ctx) {
      const summary = tracker.statusSummary();

      const usage = ctx.getContextUsage();

      let output = `Context chunks: ${summary.total} tracked, ${summary.pruned} pruned\n`;
      output += `Token estimate: ~${summary.totalTokens} total, ~${summary.prunedTokens} pruned (~${summary.totalTokens - summary.prunedTokens} active)\n`;
      if (usage) {
        output += `Provider context: ~${usage.tokens} tokens used of ~${usage.limit}\n`;
      }

      const sorted = Object.entries(summary.activeByTool).sort((a, b) => b[1].tokens - a[1].tokens);
      if (sorted.length > 0) {
        output += "\nActive chunks by tool:\n";
        for (const [tool, { count, tokens }] of sorted) {
          output += `  ${tool}: ${count} chunks, ~${tokens} tokens\n`;
        }
      }

      ctx.ui.notify(output, "info");
    },
  });
}
