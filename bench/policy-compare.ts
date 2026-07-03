import { collectToolResult } from "../src/collector";
import { mergeConfig } from "../src/config";
import { autoPrune } from "../src/pruner";
import { ChunkRegistry } from "../src/registry";
import { TelemetryRecorder } from "../src/telemetry";
import type { ContentBlock, PruneChunksConfig } from "../src/types";

type ReplayStep = {
  id: string;
  toolName: string;
  text: string;
  params?: Record<string, unknown>;
};

const fixture: ReplayStep[] = [
  {
    id: "search_parser",
    toolName: "code_search",
    text: "src/parser.ts:42: parseExpression\n".repeat(220),
  },
  {
    id: "repo_map",
    toolName: "reamerx_repo_map",
    text: "repo map\nsrc/index.ts\nsrc/parser.ts\nsrc/pruner.ts\n".repeat(220),
  },
  {
    id: "large_read",
    toolName: "read",
    text: "large unbounded source line\n".repeat(360),
    params: { path: "src/parser.ts" },
  },
  {
    id: "edit_pack",
    toolName: "reamerx_edit_pack",
    text: "ReamerX edit-pack: ready\ntests: test/architecture.test.ts\n".repeat(180),
  },
  {
    id: "test_pass",
    toolName: "bash",
    text: "npm test\nPASS test/architecture.test.ts\n".repeat(160),
    params: { command: "npm test" },
  },
];

function textBlock(text: string): ContentBlock[] {
  return [{ type: "text", text }];
}

function replay(config: PruneChunksConfig) {
  const registry = new ChunkRegistry();
  const telemetry = new TelemetryRecorder();
  let now = Date.now() - 20 * 60_000;

  for (const step of fixture) {
    const collected = collectToolResult({
      toolCallId: step.id,
      toolName: step.toolName,
      content: textBlock(step.text),
      params: step.params,
      config,
    });
    if (!collected) continue;
    const chunk = registry.addCollected(collected, now);
    registry.markSeenByToolCallId(step.id, now + 1);
    telemetry.recordCollected(chunk, now);
    now += 60_000;
  }

  const result = autoPrune(
    registry,
    { tokens: 28_000, contextWindow: 32_000, percent: 87.5 },
    config,
    { now },
  );
  telemetry.recordActionResults("auto_prune", result.pruned, result.reason, now);
  return {
    policy: config.autoPrune.policy,
    modelProfile: config.autoPrune.modelProfile,
    pruned: result.pruned.filter((entry) => entry.status === "pruned").length,
    savedTokens: result.savedTokens,
    activeTokens: registry.summary().activeTokens,
    prunedTokens: registry.summary().prunedTokens,
    metrics: telemetry.snapshot(registry.summary(), config, null, now).metrics,
  };
}

const base = {
  track: { minChunkTokens: 1 },
  autoPrune: {
    enabled: true,
    startAtPercent: 70,
    targetPercent: 55,
    preserveRecentChunks: 0,
    preserveRecentMinutes: 0,
    minChunkTokens: 1,
    maxChunksPerPass: 10,
    pruneSupersededOnIngest: true,
    pruneZeroMatchSearchesOnIngest: true,
  },
};

const heuristic = replay(
  mergeConfig({
    ...base,
    autoPrune: { ...base.autoPrune, policy: "heuristic-v1", modelProfile: "auto" },
  }),
);
const adaptiveLocal = replay(
  mergeConfig({
    ...base,
    autoPrune: { ...base.autoPrune, policy: "adaptive-v1", modelProfile: "local-32k" },
  }),
);
const adaptiveCloud = replay(
  mergeConfig({
    ...base,
    autoPrune: { ...base.autoPrune, policy: "adaptive-v1", modelProfile: "cloud-1m" },
  }),
);

console.log("Policy replay comparison");
console.table([heuristic, adaptiveLocal, adaptiveCloud]);
