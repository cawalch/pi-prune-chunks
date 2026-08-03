#!/usr/bin/env node

import { collectToolResult } from "../src/collector";
import { mergeConfig } from "../src/config";
import { budgetRetirementPlan } from "../src/pruner";
import { ChunkRegistry } from "../src/registry";
import { rewriteRetiredExchanges } from "../src/tombstones";
import type { ContentBlock } from "../src/types";

type Message = {
  role: string;
  toolCallId?: string;
  content: ContentBlock[];
};

const cfg = mergeConfig({
  track: { minChunkTokens: 1 },
  budget: {
    minTokens: 1_200,
    maxTokens: 1_200,
    preserveRecentResults: 6,
    preserveRecentMinutes: 0,
  },
  restore: { diskCache: false },
});
const registry = new ChunkRegistry();
const messages: Message[] = [];
const allFacts: string[] = [];
const criticalFacts = ["issue #918", "src/active.ts", "AssertionError: paired output required"];

for (let index = 0; index < 16; index++) {
  const id = `search-${index}`;
  const fact = `fact-${index}-retained-only-if-visible`;
  allFacts.push(fact);
  const output = [
    `search batch ${index}`,
    ...Array.from({ length: 60 }, (_, line) => `src/module-${index}.ts:${line + 1}: ordinary hit`),
    fact,
  ].join("\n");
  const collected = collectToolResult({
    toolCallId: id,
    toolName: "rg",
    content: [{ type: "text", text: output }],
    config: cfg,
  });
  if (!collected) throw new Error("fixture was not collected");
  registry.addCollected(collected, Date.now() - (20 - index) * 60_000);
  registry.markSeenByToolCallId(id);
  messages.push({
    role: "assistant",
    content: [{ type: "toolCall", id, name: "rg", arguments: { query: `batch-${index}` } }],
  });
  messages.push({
    role: "toolResult",
    toolCallId: id,
    content: [{ type: "text", text: output }],
  });
}

const failureId = "failure";
const failureOutput = [
  "npm test",
  "FAIL test/provider-shape.test.ts",
  "AssertionError: paired output required",
  "issue #918",
  "src/active.ts",
].join("\n");
const failure = collectToolResult({
  toolCallId: failureId,
  toolName: "bash",
  content: [{ type: "text", text: failureOutput }],
  config: cfg,
});
if (!failure) throw new Error("failure fixture was not collected");
registry.addCollected(failure);
registry.markSeenByToolCallId(failureId);
messages.push({
  role: "assistant",
  content: [{ type: "toolCall", id: failureId, name: "bash", arguments: { command: "npm test" } }],
});
messages.push({
  role: "toolResult",
  toolCallId: failureId,
  content: [{ type: "text", text: failureOutput }],
});

const v2Plan = budgetRetirementPlan(
  registry,
  { tokens: 22_400, contextWindow: 32_000, percent: 70 },
  cfg,
);
registry.prune(v2Plan.candidates.map((candidate) => candidate.id), "budget", "auto_pruned");
const v2 = rewriteRetiredExchanges(messages, registry).messages;

const legacyIds = new Set(
  messages
    .filter((message) => message.role === "toolResult")
    .slice(0, 10)
    .map((message) => message.toolCallId as string),
);
const v1 = messages.map((message) => {
  if (message.role !== "toolResult" || !message.toolCallId || !legacyIds.has(message.toolCallId)) {
    return message;
  }
  const firstLine = String(message.content[0]?.text ?? "").split("\n")[0];
  return { ...message, content: [{ type: "text", text: `[pruned ${firstLine}; restore_chunks available]` }] };
});

const rows = [
  summarize("no cleanup", messages),
  summarize("v0.1 pressure/tombstones", v1),
  summarize("v0.2 bounded working set", v2),
];

console.log("Replay comparison (facts are counted only when present in provider context)");
for (const row of rows) {
  console.log(
    `  ${row.name.padEnd(27)} ${String(row.tokens).padStart(6)}t | facts ${row.facts}/${allFacts.length} | critical ${row.critical}/${criticalFacts.length} | paired=${row.paired}`,
  );
}

const v2Row = rows[2];
if (!v2Row.paired || v2Row.critical !== criticalFacts.length) {
  throw new Error("v0.2 lost a critical retained fact or produced an orphaned tool result");
}

function summarize(name: string, providerMessages: Message[]) {
  const providerText = JSON.stringify(providerMessages).toLowerCase();
  return {
    name,
    tokens: Math.ceil(providerText.length / 4),
    facts: allFacts.filter((fact) => providerText.includes(fact.toLowerCase())).length,
    critical: criticalFacts.filter((fact) => providerText.includes(fact.toLowerCase())).length,
    paired: hasValidPairs(providerMessages),
  };
}

function hasValidPairs(providerMessages: Message[]): boolean {
  const calls = new Set<string>();
  for (const message of providerMessages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type === "toolCall" && typeof block.id === "string") calls.add(block.id);
    }
  }
  return providerMessages.every(
    (message) => message.role !== "toolResult" || (!!message.toolCallId && calls.has(message.toolCallId)),
  );
}
