import { truncateText } from "./text";
import type { ContentBlock, ContextChunk, PruneChunksConfig } from "./types";

export function tombstoneFor(chunk: ContextChunk, config: PruneChunksConfig): ContentBlock[] {
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
): { messages: T[]; modified: boolean } {
  let modified = false;
  const mapped = messages.map((message) => {
    if (message.role !== "toolResult" || !message.toolCallId) return message;
    const chunk = getPrunedChunk(message.toolCallId);
    if (!chunk) return message;
    modified = true;
    return {
      ...message,
      content: tombstoneFor(chunk, config),
    };
  });
  return { messages: mapped, modified };
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
