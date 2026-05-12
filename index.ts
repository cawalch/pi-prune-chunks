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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AGE_REGEX = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/;

/** Parse a human-readable age string (e.g. '5m', '1h', '30s') into milliseconds. */
export function parseAge(age: string): number | null {
  const match = AGE_REGEX.exec(age.trim());
  if (!match) return null;
  const value = parseFloat(match[1]);
  const unit = match[2] ?? "ms";
  switch (unit) {
    case "ms":
      return value;
    case "s":
      return value * 1000;
    case "m":
      return value * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    default:
      return null;
  }
}

export default function (pi: ExtensionAPI) {
  const tracker = new ChunkTracker();

  // Threshold enforcement state
  let lastWarnedTier = -1;
  let consecutivePruneCount = 0;
  // Tracks whether we've already suggested pruning this turn
  let suggestedPruneThisTurn = false;

  // -----------------------------------------------------------------------
  // Hook: session_shutdown — clear in-memory state
  // -----------------------------------------------------------------------

  pi.on("session_shutdown", async (_event, _ctx) => {
    tracker.reset();
    lastWarnedTier = -1;
    consecutivePruneCount = 0;
    suggestedPruneThisTurn = false;
  });

  // -----------------------------------------------------------------------
  // Hook: model_select — reset threshold state on model change
  // -----------------------------------------------------------------------

  pi.on("model_select", async (_event, _ctx) => {
    lastWarnedTier = -1;
  });

  // -----------------------------------------------------------------------
  // Hook: turn_start — reset per-turn state
  // -----------------------------------------------------------------------

  pi.on("turn_start", async (_event, _ctx) => {
    suggestedPruneThisTurn = false;
  });

  // -----------------------------------------------------------------------
  // Hook: turn_end — proactive pruning suggestion
  // -----------------------------------------------------------------------

  pi.on("turn_end", async (_event, ctx) => {
    if (suggestedPruneThisTurn) return;

    const usage = ctx.getContextUsage();
    if (!usage || !ctx.hasUI) return;

    const pct =
      usage.percent != null
        ? usage.percent / 100
        : usage.tokens != null && usage.contextWindow
          ? usage.tokens / usage.contextWindow
          : null;
    if (pct == null) return;

    // Suggest pruning when context is 70%+ and there are active chunks
    if (pct >= 0.7) {
      const summary = tracker.statusSummary();
      const activeChunks = summary.total - summary.pruned;
      if (activeChunks > 0) {
        suggestedPruneThisTurn = true;
        const pctDisplay = Math.round(pct * 100);
        ctx.ui.notify(
          `📊 Context at ${pctDisplay}% with ${activeChunks} active chunks. ` +
            `Consider list_context_chunks → prune_chunks to free space.`,
          "info",
        );
      }
    }
  });

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

    // 2. Show context usage in TUI footer bar + notify on threshold escalation
    const usage = ctx.getContextUsage();
    if (usage) {
      const summary = tracker.statusSummary();
      const footer = contextFooter(usage.tokens, usage.contextWindow, usage.percent, summary);

      // TUI footer status bar — always visible to the user, not injected into messages
      if (ctx.hasUI) {
        ctx.ui.setStatus("prune-chunks", footer);
      }

      // 3. Soft threshold warning — escalate through tiers as context grows
      const softCheck = softThresholdCheck(
        usage.tokens,
        usage.contextWindow,
        usage.percent,
        lastWarnedTier,
      );
      lastWarnedTier = softCheck.currentTier;
      if (softCheck.shouldWarn && softCheck.message && ctx.hasUI) {
        ctx.ui.notify(softCheck.message, "warn");
      }
    }

    if (modified) {
      return { messages };
    }
  });

  // -----------------------------------------------------------------------
  // Hook: tool_call — hard cutoff + streak reset
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

    const check = hardThresholdCheck(usage.tokens, usage.contextWindow, usage.percent, 0.9);
    if (check.shouldBlock) {
      // If all tracked chunks are already pruned, there's nothing left to free.
      // Lifting the block avoids a deadlock where the agent can't prune further
      // but also can't proceed with any other tool.
      const summary = tracker.statusSummary();
      if (summary.total > 0 && summary.pruned >= summary.total) {
        return; // allow the call through
      }

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
      "before each LLM call. Use list_context_chunks first to identify expendable chunks, " +
      "or use olderThan/largest for convenience pruning.",
    promptSnippet: "Prune context chunks by id, age, or size to free tokens",
    promptGuidelines: [
      "Use prune_chunks when context is getting large and earlier tool results are no longer needed.",
      "Always list_context_chunks before pruning to identify the right chunk ids.",
      "For quick cleanup, use prune_chunks with olderThan (e.g. '5m') to prune stale exploration results.",
      "Use prune_chunks with largest: N to prune the N biggest chunks by token estimate.",
      "Pruning is reversible — use restore_chunks to recover pruned content within the same session.",
      "Prefer pruning older chunks from completed exploration steps rather than recent ones.",
    ],
    parameters: Type.Object({
      ids: Type.Optional(
        Type.Array(Type.String({ description: "Chunk ids to prune (from list_context_chunks)" }), {
          description: "Array of chunk ids to prune",
        }),
      ),
      olderThan: Type.Optional(
        Type.String({
          description:
            "Prune active chunks older than this age (e.g. '5m', '1h', '30s'). " +
            "Mutually exclusive with ids.",
        }),
      ),
      largest: Type.Optional(
        Type.Number({
          description:
            "Prune the N largest active chunks by token estimate. " +
            "Mutually exclusive with ids.",
        }),
      ),
      toolName: Type.Optional(
        Type.String({
          description: "Filter: only prune chunks from this tool (used with olderThan/largest)",
        }),
      ),
      reason: Type.Optional(Type.String({ description: "Reason for pruning (for audit trail)" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      // Resolve chunk ids from parameters
      let ids: string[];
      const reason = params.reason;

      if (params.ids && params.ids.length > 0) {
        ids = params.ids;
      } else if (params.olderThan) {
        const ageMs = parseAge(params.olderThan);
        if (ageMs == null) {
          return {
            content: [
              {
                type: "text",
                text: `Invalid olderThan format: '${params.olderThan}'. Use e.g. '5m', '1h', '30s'.`,
              },
            ],
            isError: true,
          };
        }
        ids = tracker.idsOlderThan(ageMs, {
          toolName: params.toolName,
          onlyActive: true,
        });
        if (ids.length === 0) {
          return {
            content: [{ type: "text", text: "No active chunks match the olderThan criteria." }],
          };
        }
      } else if (params.largest != null && params.largest > 0) {
        ids = tracker.idsLargest(params.largest, {
          toolName: params.toolName,
        });
        if (ids.length === 0) {
          return {
            content: [{ type: "text", text: "No active chunks to prune." }],
          };
        }
      } else {
        return {
          content: [
            {
              type: "text",
              text: "Provide one of: ids, olderThan, or largest.",
            },
          ],
          isError: true,
        };
      }

      // Streak detection — enforce batching
      consecutivePruneCount++;
      const streakResult = checkPruneStreak(consecutivePruneCount, ids.length, 3);

      const results = tracker.prune(ids, reason);
      const prunedResults = results.filter((r) => r.status === "pruned");
      const freedTokens = prunedResults.reduce((s, r) => s + r.tokens, 0);

      persistState();

      const lines = [
        `Pruned ${prunedResults.length}/${ids.length} chunks, freed ~${freedTokens} tokens`,
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
        output += `Provider context: ~${usage.tokens} tokens used of ~${usage.contextWindow}\n`;
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
