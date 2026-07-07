#!/usr/bin/env node
// bench/e2e-pruning-impact.ts — deterministic end-to-end pruning strategy fixture.

import {
  buildContinuationManifest,
  collectToolResult,
  estimateTokens,
  mergeConfig,
  renderContinuationManifestPreview,
  tombstoneFor,
  ChunkRegistry,
} from "../src/tracker";
import type { ContentBlock, ContextChunk, PreserveContext } from "../src/tracker";

type FixtureStep = {
  id: string;
  toolName: string;
  text: string;
  params?: Record<string, unknown>;
  requiredAnchors?: string[];
};

type StrategyResult = {
  strategy: string;
  requestTokens: number;
  activeTokens: number;
  prunedTokens: number;
  prunedChunks: number;
  restoreHints: number;
  retainedAnchors: number;
  requiredAnchors: number;
  retentionPercent: number;
  badPruneEvents: number;
  withinWindow: boolean;
  successProxy: boolean;
  latencyProxyMs: number;
};

const CONTEXT_WINDOW = 32_000;
const PRUNE_KEEP_RECENT = 6;

const config = mergeConfig({
  track: { minChunkTokens: 1 },
  autoPrune: {
    enabled: true,
    policy: "adaptive-v1",
    modelProfile: "local-32k",
    startAtPercent: 55,
    targetPercent: 42,
    preserveRecentChunks: 0,
    preserveRecentMinutes: 0,
    minChunkTokens: 1,
    maxChunksPerPass: 20,
    pruneSupersededOnIngest: true,
    pruneZeroMatchSearchesOnIngest: true,
  },
  tombstones: {
    includeSummary: true,
    includeRestoreHint: true,
    maxSummaryChars: 160,
    compactAtPercent: 85,
    coalesceAtPercent: 95,
    coalesceMinChunks: 8,
    maxCoalescedEntries: 120,
  },
});

const fixture: FixtureStep[] = [
  {
    id: "issue",
    toolName: "gh_issue",
    text: block([
      "Issue #57: Offload large tool inputs, not only tool results",
      "Acceptance: compact explicit tool-input echoes while preserving source path hints.",
      "Do not mutate the saved transcript; provider context only.",
    ]),
    requiredAnchors: ["Issue #57", "tool-input echoes", "saved transcript"],
  },
  {
    id: "repo_map",
    toolName: "reamerx_repo_map",
    text: block(["Repo map", "src/contextGuards.ts", "index.ts", "test/architecture.test.ts"]),
    requiredAnchors: ["src/contextGuards.ts", "test/architecture.test.ts"],
  },
  {
    id: "context_guard_read",
    toolName: "read",
    params: { path: "src/contextGuards.ts", startLine: 1, endLine: 120 },
    text: block([
      "src/contextGuards.ts:1-120",
      "function compactFailedToolValidationMessages(messages, config) { ... }",
      "Guard currently handles Validation failed for tool messages and Received arguments.",
    ]),
    requiredAnchors: ["compactFailedToolValidationMessages", "Received arguments"],
  },
  {
    id: "test_read",
    toolName: "read",
    params: { path: "test/architecture.test.ts", startLine: 1868, endLine: 1914 },
    text: block([
      "test/architecture.test.ts:1868-1914",
      "test(\"context hook compacts oversized failed tool validation payloads\", async () => { ... })",
      "The next fixture should cover compacted-tool-input.",
    ]),
    requiredAnchors: ["compacted-tool-input"],
  },
  ...Array.from({ length: 12 }, (_, index) => ({
    id: `explore_${index}`,
    toolName: index % 2 === 0 ? "code_search" : "read",
    params: index % 2 === 0 ? undefined : { path: `src/exploratory-${index}.ts` },
    text: block([
      `Exploratory result ${index}`,
      `src/exploratory-${index}.ts:${10 + index}: unrelated helper`,
      "Long irrelevant context line about an abandoned implementation path.",
    ]),
  })),
  {
    id: "edit_diff",
    toolName: "bash",
    text: block([
      "diff --git a/src/contextGuards.ts b/src/contextGuards.ts",
      "+[compacted-tool-input: tool=\"write\" original~1234t sha1=abcdef1234; paths=src/generated.ts; arguments omitted]",
      "diff --git a/test/architecture.test.ts b/test/architecture.test.ts",
      "+test(\"context hook compacts oversized tool input echoes\", async () => { ... })",
    ]),
    requiredAnchors: ["src/generated.ts", "context hook compacts oversized tool input echoes"],
  },
  {
    id: "check",
    toolName: "bash",
    params: { command: "npm run check" },
    text: block([
      "npm run check",
      "PASS test/architecture.test.ts",
      "50 tests passing",
      "typecheck green; lint green",
    ]),
    requiredAnchors: ["npm run check", "50 tests passing"],
  },
  ...Array.from({ length: 10 }, (_, index) => ({
    id: `post_check_noise_${index}`,
    toolName: "code_context",
    text: block([
      `Post-check unrelated context ${index}`,
      "A long output that should be cheap to hide behind a tombstone.",
      "No required task fact is present here.",
    ]),
  })),
];

const requiredAnchors = unique(
  fixture.flatMap((step) => step.requiredAnchors ?? []).map((anchor) => normalize(anchor)),
);

function main() {
  const results = [runNoPrune(), runPrune(false), runPrune(true)];
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ contextWindow: CONTEXT_WINDOW, results }, null, 2));
    return;
  }
  printMarkdown(results);
}

function runNoPrune(): StrategyResult {
  const rendered = fixture.map((step) => step.text).join("\n");
  return summarizeStrategy("no-prune", rendered, [], 0, 0);
}

function runPrune(withSummary: boolean): StrategyResult {
  const registry = new ChunkRegistry();
  const orderedIds: string[] = [];
  let now = Date.now() - 60 * 60_000;

  for (const step of fixture) {
    const collected = collectToolResult({
      toolCallId: step.id,
      toolName: step.toolName,
      content: textBlock(step.text),
      params: step.params,
      config,
    });
    if (!collected) continue;
    registry.addCollected(collected, now);
    registry.markSeenByToolCallId(step.id, now + 1);
    orderedIds.push(step.id);
    now += 60_000;

    const pruneable = registry
      .active()
      .filter((chunk) => chunk.risk !== "high")
      .slice(0, Math.max(0, registry.active().length - PRUNE_KEEP_RECENT))
      .map((chunk) => chunk.id);
    if (pruneable.length > 0) registry.prune(pruneable, "e2e fixture: hide stale tool output");
  }

  const chunks = orderedIds
    .map((id) => registry.getByToolCallId(id))
    .filter((chunk): chunk is ContextChunk => !!chunk);
  const renderedParts = chunks.map((chunk) =>
    chunk.pruned ? (tombstoneFor(chunk, config)[0].text ?? "") : registry.getContent(chunk.id)?.[0]?.text ?? "",
  );

  let summaryTokens = 0;
  if (withSummary) {
    const preserve: PreserveContext = {
      paths: new Set(["src/contextguards.ts", "test/architecture.test.ts"]),
      anchors: new Set(requiredAnchors),
    };
    const manifest = buildContinuationManifest(
      registry,
      { tokens: CONTEXT_WINDOW * 0.92, contextWindow: CONTEXT_WINDOW, percent: 92 },
      config,
      preserve,
    );
    const summary = `${renderContinuationManifestPreview(manifest)}\n\n${compactTaskStateSummary()}`;
    summaryTokens = estimateTokens(summary);
    renderedParts.unshift(summary);
  }

  const rendered = renderedParts.join("\n");
  const summary = registry.summary();
  return summarizeStrategy(
    withSummary ? "pruning+task-summary" : "pruning",
    rendered,
    registry.all().filter((chunk) => chunk.pruned),
    summary.prunedChunks,
    summary.prunedTokens,
    summaryTokens,
  );
}

function summarizeStrategy(
  strategy: string,
  rendered: string,
  prunedChunks: ContextChunk[],
  prunedChunkCount: number,
  prunedTokens: number,
  summaryTokens = 0,
): StrategyResult {
  const normalizedRendered = normalize(rendered);
  const retainedAnchors = requiredAnchors.filter((anchor) => normalizedRendered.includes(anchor)).length;
  const badPruneEvents = requiredAnchors.filter((anchor) => {
    if (normalizedRendered.includes(anchor)) return false;
    return prunedChunks.some((chunk) => normalize(chunk.summary ?? chunk.label).includes(anchor));
  }).length;
  const requestTokens = estimateTokens(rendered);
  const retentionPercent = Math.round((retainedAnchors / requiredAnchors.length) * 1000) / 10;
  const withinWindow = requestTokens <= CONTEXT_WINDOW;
  return {
    strategy,
    requestTokens,
    activeTokens: Math.max(0, requestTokens - summaryTokens),
    prunedTokens,
    prunedChunks: prunedChunkCount,
    restoreHints: (rendered.match(/restore_chunks/g) ?? []).length,
    retainedAnchors,
    requiredAnchors: requiredAnchors.length,
    retentionPercent,
    badPruneEvents,
    withinWindow,
    successProxy: withinWindow && retentionPercent >= 85 && badPruneEvents === 0,
    latencyProxyMs: Math.round(100 + requestTokens * 0.015),
  };
}

function compactTaskStateSummary(): string {
  return [
    "Task-state anchor summary:",
    ...requiredAnchors.map((anchor) => `- ${anchor}`),
    "- Keep restore hints available for pruned raw outputs.",
  ].join("\n");
}

function printMarkdown(results: StrategyResult[]) {
  console.log("# E2E pruning impact fixture\n");
  console.log(`Context window: ${CONTEXT_WINDOW} tokens`);
  console.log(`Required anchors: ${requiredAnchors.length}`);
  console.log("\n| Strategy | Request tokens | Within window | Anchor retention | Bad-prune events | Restore hints | Success proxy | Latency proxy |\n| --- | ---: | :---: | ---: | ---: | ---: | :---: | ---: |");
  for (const result of results) {
    console.log(
      `| ${result.strategy} | ${result.requestTokens} | ${result.withinWindow ? "yes" : "no"} | ${result.retentionPercent}% | ${result.badPruneEvents} | ${result.restoreHints} | ${result.successProxy ? "yes" : "no"} | ${result.latencyProxyMs}ms |`,
    );
  }
  console.log("\nJSON:");
  console.log("```json");
  console.log(JSON.stringify({ contextWindow: CONTEXT_WINDOW, results }, null, 2));
  console.log("```");
}

function block(lines: string[]): string {
  return `${lines.join("\n")}\n${"bulk filler line that should be safe to prune\n".repeat(180)}`;
}

function textBlock(text: string): ContentBlock[] {
  return [{ type: "text", text }];
}

function normalize(text: string): string {
  return text.toLowerCase();
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

main();
