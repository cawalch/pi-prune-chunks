#!/usr/bin/env node

import { collectToolResult } from "../src/collector";
import { mergeConfig } from "../src/config";
import { pressureRetirementPlan, shouldRunPressureSweep } from "../src/pruner";
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
  pressure: {
    triggerPercent: 90,
    targetPercent: 80,
    retryAfterGrowthTokens: 1_000,
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

const belowPressureUsage = { tokens: 8_900, contextWindow: 10_000, percent: 89 };
if (shouldRunPressureSweep(belowPressureUsage, cfg)) {
  throw new Error("v0.3 unexpectedly triggered below its pressure threshold");
}
const belowPressure = messages;

const pressureUsage = { tokens: 9_200, contextWindow: 10_000, percent: 92 };
if (!shouldRunPressureSweep(pressureUsage, cfg)) {
  throw new Error("v0.3 failed to trigger at pressure");
}
const pressurePlan = pressureRetirementPlan(registry, pressureUsage, cfg);
registry.prune(
  pressurePlan.candidates.map((candidate) => candidate.id),
  "pressure safety sweep",
  "auto_pruned",
);
const pressureSweep = rewriteRetiredExchanges(messages, registry).messages;

const rows = [
  summarize("no cleanup", messages),
  summarize("v0.3 below pressure", belowPressure),
  summarize("v0.3 pressure safety sweep", pressureSweep),
];

console.log("Replay comparison (facts are counted only when present in provider context)");
for (const row of rows) {
  console.log(
    `  ${row.name.padEnd(27)} ${String(row.tokens).padStart(6)}t | facts ${row.facts}/${allFacts.length} | critical ${row.critical}/${criticalFacts.length} | paired=${row.paired}`,
  );
}

if (JSON.stringify(messages) !== JSON.stringify(belowPressure)) {
  throw new Error("v0.3 changed provider context below pressure");
}
if (rows[0].tokens !== rows[1].tokens || rows[0].facts !== rows[1].facts) {
  throw new Error("v0.3 below-pressure replay is not identical to no cleanup");
}
const pressureRow = rows[2];
if (!pressureRow.paired || pressureRow.critical !== criticalFacts.length) {
  throw new Error("v0.3 pressure sweep lost a protected fact or produced an orphaned result");
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
