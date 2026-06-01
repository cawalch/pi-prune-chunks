import { truncateText } from "./text";
import type { ContentBlock, ContextChunk, PruneChunksConfig } from "./types";

export type TombstoneOptions = {
  compact?: boolean;
  coalesce?: boolean;
};

export function tombstoneFor(
  chunk: ContextChunk,
  config: PruneChunksConfig,
  options: TombstoneOptions = {},
): ContentBlock[] {
  if (options.compact) {
    return [
      {
        type: "text",
        text: `[pruned:${chunk.id} ${chunk.kind} ~${chunk.tokenEstimate}t; restore_chunks]`,
      },
    ];
  }

  const source = sourceText(chunk);
  const summary =
    config.tombstones.includeSummary && chunk.summary
      ? ` summary="${escapeField(truncateText(chunk.summary, config.tombstones.maxSummaryChars))}"`
      : "";
  const restore = config.tombstones.includeRestoreHint
    ? ` restore="restore_chunks({ids:['${chunk.id}']})"`
    : "";

  return [
    {
      type: "text",
      text:
        `[pruned:${chunk.id} ${chunk.kind}/${chunk.toolName} "${escapeField(chunk.label)}" ` +
        `~${chunk.tokenEstimate}t${source}${summary}${restore}]`,
    },
  ];
}

export function applyPrunedTombstones<
  T extends { role: string; toolCallId?: string; content?: ContentBlock[] },
>(
  messages: T[],
  getPrunedChunk: (toolCallId: string) => ContextChunk | undefined,
  config: PruneChunksConfig,
  options: TombstoneOptions = {},
): { messages: T[]; modified: boolean } {
  if (options.coalesce) {
    return applyCoalescedPrunedTombstones(messages, getPrunedChunk, config, options);
  }

  let modified = false;
  const mapped = messages.map((message) => {
    if (message.role !== "toolResult" || !message.toolCallId) return message;
    const chunk = getPrunedChunk(message.toolCallId);
    if (!chunk) return message;
    modified = true;
    return {
      ...message,
      content: tombstoneFor(chunk, config, options),
    };
  });
  return { messages: mapped, modified };
}

function applyCoalescedPrunedTombstones<
  T extends { role: string; toolCallId?: string; content?: ContentBlock[] },
>(
  messages: T[],
  getPrunedChunk: (toolCallId: string) => ContextChunk | undefined,
  config: PruneChunksConfig,
  options: TombstoneOptions,
): { messages: T[]; modified: boolean } {
  const pruned = prunedMessages(messages, getPrunedChunk);
  if (pruned.length <= 1) {
    return applyPrunedTombstones(messages, getPrunedChunk, config, {
      ...options,
      coalesce: false,
    });
  }

  const newestPruned = pruned[pruned.length - 1];
  const coalesced = pruned.slice(0, -1);
  const coalescedByIndex = new Map(coalesced.map((item) => [item.index, item.chunk]));
  const manifestIndex = coalesced[0]?.index;
  const output: T[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const chunk = coalescedByIndex.get(index);
    if (chunk) {
      if (index === manifestIndex) {
        output.push({
          ...message,
          content: coalescedManifest(
            coalesced.map((item) => item.chunk),
            config,
          ),
        });
      }
      continue;
    }

    if (index === newestPruned.index) {
      output.push({
        ...message,
        content: tombstoneFor(newestPruned.chunk, config, { ...options, compact: true }),
      });
      continue;
    }

    output.push(message);
  }

  return { messages: output, modified: true };
}

function prunedMessages<T extends { role: string; toolCallId?: string }>(
  messages: T[],
  getPrunedChunk: (toolCallId: string) => ContextChunk | undefined,
): Array<{ index: number; chunk: ContextChunk }> {
  const pruned: Array<{ index: number; chunk: ContextChunk }> = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== "toolResult" || !message.toolCallId) continue;
    const chunk = getPrunedChunk(message.toolCallId);
    if (chunk) pruned.push({ index, chunk });
  }
  return pruned;
}

function coalescedManifest(chunks: ContextChunk[], config: PruneChunksConfig): ContentBlock[] {
  const totalTokens = chunks.reduce((sum, chunk) => sum + chunk.tokenEstimate, 0);
  const maxEntries = Math.max(1, config.tombstones.maxCoalescedEntries);
  const listed = chunks.slice(0, maxEntries);
  const omitted = chunks.slice(maxEntries);
  const entries = listed
    .map((chunk) => `${chunk.id} ${chunk.kind} ~${chunk.tokenEstimate}t`)
    .join(", ");
  const omittedTokens = omitted.reduce((sum, chunk) => sum + chunk.tokenEstimate, 0);
  const omittedText =
    omitted.length > 0 ? `; omitted ${omitted.length} chunks ~${omittedTokens}t` : "";

  return [
    {
      type: "text",
      text:
        `[pruned-manifest: ${chunks.length} older chunks ~${totalTokens}t total; ` +
        `${entries}${omittedText}; restore_chunks by id]`,
    },
  ];
}

function sourceText(chunk: ContextChunk): string {
  const source = chunk.source;
  if (!source?.path) return "";
  if (source.startLine != null && source.endLine != null) {
    return ` source="${escapeField(`${source.path}:${source.startLine}-${source.endLine}`)}"`;
  }
  if (source.startLine != null) {
    return ` source="${escapeField(`${source.path}:${source.startLine}`)}"`;
  }
  return ` source="${escapeField(source.path)}"`;
}

function escapeField(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\s+/g, " ").trim();
}
