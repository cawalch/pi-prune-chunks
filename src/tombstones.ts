import { applyPartTombstonesToContent } from "./parts";
import type { ChunkRegistry } from "./registry";
import type { ContentBlock } from "./types";

const RETIRED_MARKER = "[historical tool output retired]";
const PARTIAL_MARKER = "[older bulk output retired]";

type ContextMessage = {
  role: string;
  toolCallId?: string;
  content?: ContentBlock[];
  [key: string]: unknown;
};

export type RewriteResult<T extends ContextMessage> = {
  messages: T[];
  modified: boolean;
  removedExchanges: number;
  fallbackMarkers: number;
  partialMarkers: number;
};

/**
 * Remove a retired tool call and its result together from the provider copy.
 * The saved transcript is never mutated. If pairing is incomplete, retain a
 * neutral result marker so provider tool-call invariants remain valid.
 */
export function rewriteRetiredExchanges<T extends ContextMessage>(
  messages: T[],
  registry: ChunkRegistry,
): RewriteResult<T> {
  const retiredIds = new Set<string>();
  for (const chunk of registry.all()) {
    if (!chunk.parentId && chunk.pruned && chunk.source?.toolCallId) {
      retiredIds.add(chunk.source.toolCallId);
    }
  }
  if (retiredIds.size === 0 && !registry.all().some((chunk) => chunk.parentId && chunk.pruned)) {
    return {
      messages,
      modified: false,
      removedExchanges: 0,
      fallbackMarkers: 0,
      partialMarkers: 0,
    };
  }

  const callCounts = new Map<string, number>();
  const resultCounts = new Map<string, number>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of message.content ?? []) {
        if (block.type === "toolCall" && typeof block.id === "string") {
          callCounts.set(block.id, (callCounts.get(block.id) ?? 0) + 1);
        }
      }
    } else if (message.role === "toolResult" && message.toolCallId) {
      const id = String(message.toolCallId);
      resultCounts.set(id, (resultCounts.get(id) ?? 0) + 1);
    }
  }

  const removable = new Set(
    [...retiredIds].filter((id) => callCounts.get(id) === 1 && resultCounts.get(id) === 1),
  );
  const malformedPairs = new Set(
    [...retiredIds].filter(
      (id) =>
        (callCounts.get(id) ?? 0) > 0 && (resultCounts.get(id) ?? 0) > 0 && !removable.has(id),
    ),
  );
  const retiredCallsWithoutResults = new Set(
    [...retiredIds].filter((id) => (callCounts.get(id) ?? 0) > 0 && !resultCounts.has(id)),
  );
  const retiredResultsWithoutCalls = new Set(
    [...retiredIds].filter((id) => (resultCounts.get(id) ?? 0) > 0 && !callCounts.has(id)),
  );
  const output: T[] = [];
  let removedExchanges = 0;
  let fallbackMarkers = 0;
  let partialMarkers = 0;
  let modified = false;
  const retainedMalformedCalls = new Set<string>();
  const retainedMalformedResults = new Set<string>();

  for (const message of messages) {
    if (message.role === "assistant" && message.content) {
      const filtered = message.content.filter((block) => {
        if (block.type !== "toolCall" || typeof block.id !== "string") return true;
        if (removable.has(block.id) || retiredCallsWithoutResults.has(block.id)) return false;
        if (!malformedPairs.has(block.id)) return true;
        if (retainedMalformedCalls.has(block.id)) return false;
        retainedMalformedCalls.add(block.id);
        return true;
      });
      if (filtered.length !== message.content.length) {
        modified = true;
        removedExchanges += message.content.length - filtered.length;
        if (filtered.length === 0) continue;
        output.push({ ...message, content: filtered });
        continue;
      }
    }

    if (message.role === "toolResult" && message.toolCallId) {
      const toolCallId = String(message.toolCallId);
      if (removable.has(toolCallId)) {
        modified = true;
        continue;
      }
      if (retiredResultsWithoutCalls.has(toolCallId)) {
        modified = true;
        continue;
      }
      if (malformedPairs.has(toolCallId)) {
        modified = true;
        if (retainedMalformedResults.has(toolCallId)) continue;
        retainedMalformedResults.add(toolCallId);
        fallbackMarkers += 1;
        output.push({ ...message, content: textBlock(RETIRED_MARKER) });
        continue;
      }
      if (retiredIds.has(toolCallId)) {
        modified = true;
        fallbackMarkers += 1;
        output.push({ ...message, content: textBlock(RETIRED_MARKER) });
        continue;
      }
      const parts = registry.prunedPartsForToolCall(toolCallId);
      if (parts.length > 0) {
        modified = true;
        partialMarkers += parts.length;
        output.push({
          ...message,
          content: applyPartTombstonesToContent(message.content ?? [], parts, () => PARTIAL_MARKER),
        });
        continue;
      }
    }
    output.push(message);
  }

  return { messages: output, modified, removedExchanges, fallbackMarkers, partialMarkers };
}

function textBlock(text: string): ContentBlock[] {
  return [{ type: "text", text }];
}
