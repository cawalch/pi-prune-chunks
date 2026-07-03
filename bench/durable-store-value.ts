#!/usr/bin/env node
// bench/durable-store-value.ts — measure exact restore coverage gained by durable disk cache.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ChunkRegistry,
  collectToolResult,
  CompositeChunkContentCache,
  DiskChunkContentCache,
  estimateTokens,
  MemoryChunkContentCache,
  mergeConfig,
  restoreChunks,
  type ContentBlock,
  type PruneChunksConfig,
} from "../src/tracker";

const SYNTHETIC_RESULTS: Array<{ id: string; toolName: string; text: string }> = [
  {
    id: "search_large",
    toolName: "web_search",
    text: [
      "Answer: current context-management research summary",
      ...Array.from({ length: 240 }, (_, index) =>
        `source ${index}: result snippet about compaction, tool-result clearing, memory, and evaluation`,
      ),
    ].join("\n"),
  },
  {
    id: "test_log",
    toolName: "bash",
    text: [
      "$ npm test",
      "FAIL test/architecture.test.ts",
      ...Array.from({ length: 320 }, (_, index) =>
        `stderr line ${index}: assertion trace and noisy captured output`,
      ),
    ].join("\n"),
  },
  {
    id: "reamerx_pack",
    toolName: "reamerx_edit_pack",
    text: [
      "ReamerX edit pack: source, impact, tests, readiness",
      ...Array.from({ length: 280 }, (_, index) =>
        `symbol evidence ${index}: compact code context and test reference`,
      ),
    ].join("\n"),
  },
];

function textBlock(text: string): ContentBlock[] {
  return [{ type: "text", text }];
}

function trackAndPrune(config: PruneChunksConfig, registry: ChunkRegistry) {
  for (const result of SYNTHETIC_RESULTS) {
    const collected = collectToolResult({
      toolCallId: result.id,
      toolName: result.toolName,
      content: textBlock(result.text),
      config,
    });
    if (!collected) throw new Error(`failed to collect ${result.id}`);
    const chunk = registry.addCollected(collected);
    registry.prune([chunk.id], "benchmark restart simulation");
  }
}

async function restoreAll(registry: ChunkRegistry, config: PruneChunksConfig) {
  const ids = registry.list({ pruned: true, limit: 100 }).chunks.map((chunk) => chunk.id);
  return restoreChunks(registry, ids, config);
}

async function run() {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "pi-prune-durable-bench-"));
  const baseConfig = mergeConfig({
    track: { minChunkTokens: 1 },
    restore: { memory: true, diskCache: false, sourceRehydrate: true },
  });
  const diskConfig = mergeConfig({
    track: { minChunkTokens: 1 },
    restore: {
      memory: true,
      diskCache: { enabled: true, directory: cacheDir, maxBytes: 50_000_000, maxAgeDays: 1, maxBlobBytes: 10_000_000 },
      sourceRehydrate: true,
    },
  });

  const memoryOnly = new ChunkRegistry();
  trackAndPrune(baseConfig, memoryOnly);
  const memoryOnlyReload = new ChunkRegistry();
  memoryOnlyReload.restorePersistence(memoryOnly.persistenceState());
  const memoryOnlyResults = await restoreAll(memoryOnlyReload, baseConfig);

  const durable = new ChunkRegistry(
    new CompositeChunkContentCache(
      new MemoryChunkContentCache(),
      new DiskChunkContentCache(diskConfig.restore.diskCache),
    ),
  );
  trackAndPrune(diskConfig, durable);
  const durableReload = new ChunkRegistry(
    new CompositeChunkContentCache(
      new MemoryChunkContentCache(),
      new DiskChunkContentCache(diskConfig.restore.diskCache),
    ),
  );
  durableReload.restorePersistence(durable.persistenceState());
  const durableResults = await restoreAll(durableReload, diskConfig);

  const totalTokens = SYNTHETIC_RESULTS.reduce((sum, result) => sum + estimateTokens(result.text), 0);
  const memoryRestored = memoryOnlyResults.filter((result) => result.status === "restored").length;
  const durableRestored = durableResults.filter((result) => result.status === "restored").length;
  const durableTokens = durableResults.reduce((sum, result) => sum + result.tokens, 0);

  console.log("Durable store usefulness benchmark");
  console.log("=================================");
  console.log(`Simulated pruned non-file chunks: ${SYNTHETIC_RESULTS.length}`);
  console.log(`Simulated pruned tokens: ~${totalTokens}`);
  console.log(`After restart without disk cache: ${memoryRestored}/${SYNTHETIC_RESULTS.length} exact restores`);
  console.log(`After restart with disk cache:    ${durableRestored}/${SYNTHETIC_RESULTS.length} exact restores (~${durableTokens}t)`);
  console.log(`Cache directory: ${cacheDir}`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
