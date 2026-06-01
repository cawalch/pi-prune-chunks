import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { describe } from "node:test";
import extension from "../index";
import { classifyKind, classifyRisk, collectToolResult } from "../src/collector";
import { mergeConfig } from "../src/config";
import { autoPrune, pressureSummary, suggestPruneCandidates } from "../src/pruner";
import { ChunkRegistry } from "../src/registry";
import { restoreChunks } from "../src/restorer";
import { applyPrunedTombstones, tombstoneFor } from "../src/tombstones";
import type { ContentBlock, ContextUsage, PruneChunksConfig } from "../src/types";

function textBlock(text: string): ContentBlock[] {
  return [{ type: "text", text }];
}

function testConfig(overrides?: Partial<PruneChunksConfig>): PruneChunksConfig {
  return mergeConfig({
    track: { minChunkTokens: 1 },
    autoPrune: {
      enabled: true,
      startAtPercent: 70,
      targetPercent: 55,
      preserveRecentChunks: 0,
      preserveRecentMinutes: 0,
      minChunkTokens: 1,
      maxChunksPerPass: 10,
    },
    tombstones: { includeSummary: true, includeRestoreHint: true, maxSummaryChars: 80 },
    ...overrides,
  });
}

function addChunk(
  registry: ChunkRegistry,
  config: PruneChunksConfig,
  id: string,
  toolName: string,
  text: string,
  params?: Record<string, unknown>,
  createdAt = Date.now() - 60_000,
) {
  const collected = collectToolResult({
    toolCallId: id,
    toolName,
    content: textBlock(text),
    params,
    config,
  });
  assert.ok(collected);
  return registry.addCollected(collected, createdAt);
}

describe("collector", () => {
  test("classifies generic, Reamer, and failure output", () => {
    assert.equal(classifyKind("code_read_range", "src/a.ts:1-2\ncode", {}), "file_read");
    assert.equal(classifyKind("bash", "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@", {}), "diff");
    assert.equal(
      classifyKind("bash", "npm test\nFAIL test one\nCommand failed", {}),
      "test_output",
    );
    assert.equal(classifyRisk("test_output", "FAIL test one\nTraceback"), "high");
    assert.equal(classifyRisk("search", "src/a.ts:12: found symbol"), "low");
    assert.equal(classifyRisk("file_read", "whole file", { path: "src/scanner.rs" }), "medium");
    assert.equal(
      classifyRisk("file_read", "rules", { path: "RULES.md", startLine: 1, endLine: 80 }),
      "high",
    );
    assert.equal(
      classifyRisk("file_read", "bounded", { path: "src/scanner.rs", startLine: 20, endLine: 60 }),
      "low",
    );
  });

  test("collects metadata with stable source and bounded summary", () => {
    const config = testConfig();
    const chunk = collectToolResult({
      toolCallId: "call_a",
      toolName: "code_read_range",
      content: textBlock("src/file.ts:10-12\nexport const value = 1;\nexport const other = 2;"),
      params: { path: "src/file.ts", startLine: 10, endLine: 12 },
      config,
    });

    assert.ok(chunk);
    assert.equal(chunk.kind, "file_read");
    assert.equal(chunk.risk, "low");
    assert.equal(chunk.source?.path, "src/file.ts");
    assert.equal(chunk.source?.startLine, 10);
    assert.ok(chunk.summary);
    assert.ok(chunk.tokenEstimate > 0);
  });

  test("does not track prune-chunks tools and create self-referential bloat", () => {
    const config = testConfig();
    const chunk = collectToolResult({
      toolCallId: "self_a",
      toolName: "list_context_chunks",
      content: textBlock("Tracked chunks:\n".repeat(200)),
      config,
    });

    assert.equal(chunk, null);
  });
});

describe("registry and tombstones", () => {
  test("stores PLAN.md chunk metadata, IDs, pin/prune state, and no raw content in persistence", () => {
    const config = testConfig();
    const registry = new ChunkRegistry();
    const chunk = addChunk(
      registry,
      config,
      "tool_1",
      "code_search",
      "src/a.ts:1: result\n".repeat(80),
    );

    assert.match(chunk.id, /^pc_[0-9a-z]{4}_[0-9a-f]{6}$/);
    assert.equal(chunk.kind, "search");
    assert.equal(chunk.restoreMode, "memory");

    assert.equal(registry.pin([chunk.id], "current target")[0].status, "pinned");
    assert.equal(registry.prune([chunk.id], "manual")[0].status, "pruned");

    const list = registry.list({ pruned: true, pinned: true, sortBy: "tokens" });
    assert.equal(list.listed, 1);
    assert.equal(list.chunks[0].id, chunk.id);
    assert.equal(list.chunks[0].restoreAvailable, true);

    const persisted = registry.persistenceState();
    assert.equal(persisted.chunks[0].pinned, true);
    assert.equal(
      JSON.stringify(persisted).includes("src/a.ts:1: result\\nsrc/a.ts:1: result"),
      false,
    );
  });

  test("renders compact tombstones and does not mutate original messages", () => {
    const config = testConfig();
    const registry = new ChunkRegistry();
    const chunk = addChunk(
      registry,
      config,
      "tool_1",
      "code_context",
      "large context\n".repeat(200),
    );
    registry.prune([chunk.id], "done");

    const tombstone = tombstoneFor(chunk, config)[0].text ?? "";
    assert.ok(tombstone.includes(`[pruned:${chunk.id}`));
    assert.ok(tombstone.includes("context_pack/code_context"));
    assert.ok(tombstone.includes("restore_chunks"));
    assert.ok(tombstone.length < "large context\n".repeat(200).length / 4);

    const original = [
      {
        role: "toolResult",
        toolCallId: "tool_1",
        content: textBlock("large context\n".repeat(200)),
      },
      { role: "user", content: textBlock("next") },
    ];
    const applied = applyPrunedTombstones(
      original,
      (toolCallId) => registry.prunedForToolCall(toolCallId),
      config,
    );
    assert.equal(applied.modified, true);
    assert.notEqual(applied.messages[0], original[0]);
    assert.equal(original[0].content[0].text, "large context\n".repeat(200));
    assert.ok(applied.messages[0].content[0].text?.includes("[pruned:"));
  });
});

describe("pruner and restorer", () => {
  test("auto-prune preserves pinned and high-risk chunks while pruning safe old chunks", () => {
    const config = testConfig();
    const registry = new ChunkRegistry();
    const safe = addChunk(
      registry,
      config,
      "safe",
      "code_search",
      "src/a.ts:1: result\n".repeat(160),
    );
    const pinned = addChunk(
      registry,
      config,
      "pinned",
      "code_search",
      "src/b.ts:1: result\n".repeat(160),
    );
    const failure = addChunk(
      registry,
      config,
      "failure",
      "bash",
      "npm test\nFAIL important\n".repeat(160),
    );
    registry.pin([pinned.id], "still relevant");

    const usage: ContextUsage = { tokens: 9_000, contextWindow: 10_000, percent: 90 };
    const result = autoPrune(registry, usage, config);

    assert.equal(result.triggered, true);
    assert.equal(registry.get(safe.id)?.pruned, true);
    assert.equal(registry.get(pinned.id)?.pruned, false);
    assert.equal(registry.get(failure.id)?.pruned, false);
  });

  test("auto-prune relaxes age and token floor when fast sessions cross pressure threshold", () => {
    const config = mergeConfig({
      track: { minChunkTokens: 200 },
      autoPrune: {
        enabled: true,
        startAtPercent: 70,
        targetPercent: 55,
        preserveRecentChunks: 5,
        preserveRecentMinutes: 10,
        minChunkTokens: 500,
        maxChunksPerPass: 10,
      },
    });
    const registry = new ChunkRegistry();
    const now = Date.now();
    for (let i = 0; i < 6; i++) {
      addChunk(
        registry,
        config,
        `fast_${i}`,
        "code_search",
        `src/${i}.ts:1: result\n`.repeat(80),
        undefined,
        now - 60_000,
      );
    }

    const result = autoPrune(
      registry,
      { tokens: 7_500, contextWindow: 10_000, percent: 75 },
      config,
      { now },
    );

    assert.equal(result.triggered, true);
    assert.ok(result.pruned.some((entry) => entry.status === "pruned"));
    assert.equal(registry.summary().prunedChunks, 1);
  });

  test("auto-prune protects anchor files and delays unbounded file reads", () => {
    const config = mergeConfig({
      track: { minChunkTokens: 1 },
      autoPrune: {
        enabled: true,
        startAtPercent: 70,
        targetPercent: 55,
        preserveRecentChunks: 0,
        preserveRecentMinutes: 0,
        minChunkTokens: 1,
        maxChunksPerPass: 10,
      },
    });
    const registry = new ChunkRegistry();
    const now = Date.now() - 5 * 60_000;
    const anchor = addChunk(
      registry,
      config,
      "rules",
      "read",
      "project rules\n".repeat(200),
      { path: "RULES.md", startLine: 1, endLine: 120 },
      now,
    );
    const unbounded = addChunk(
      registry,
      config,
      "scanner",
      "read",
      "scanner source\n".repeat(200),
      { path: "src/scanner.rs" },
      now,
    );
    const search = addChunk(
      registry,
      config,
      "search",
      "code_search",
      "src/a.ts:1: result\n".repeat(200),
      undefined,
      now,
    );

    autoPrune(registry, { tokens: 7_500, contextWindow: 10_000, percent: 75 }, config, { now });
    assert.equal(registry.get(anchor.id)?.pruned, false);
    assert.equal(registry.get(unbounded.id)?.pruned, false);
    assert.equal(registry.get(search.id)?.pruned, true);

    autoPrune(registry, { tokens: 8_700, contextWindow: 10_000, percent: 87 }, config, { now });
    assert.equal(registry.get(anchor.id)?.pruned, false);
    assert.equal(registry.get(unbounded.id)?.pruned, true);
  });

  test("suggestions and pressure report include candidate metadata", () => {
    const config = testConfig();
    const registry = new ChunkRegistry();
    addChunk(registry, config, "safe", "flow_trace", "trace node\n".repeat(200));

    const candidates = suggestPruneCandidates(registry, config, { limit: 5 });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].kind, "flow_trace");
    assert.ok(candidates[0].reasons.length > 0);

    const pressure = pressureSummary(
      registry,
      { tokens: 7_500, contextWindow: 10_000, percent: 75 },
      config,
    );
    assert.equal(pressure.autoPrune.currentPercent, 75);
    assert.equal(pressure.recommendedCandidates.length, 1);
  });

  test("restores from memory first and source range after metadata reload", async () => {
    const config = testConfig();
    const registry = new ChunkRegistry();
    const chunk = addChunk(registry, config, "read_1", "read", "alpha\nbeta\ngamma", {
      path: "file.txt",
      startLine: 2,
      endLine: 3,
    });
    registry.prune([chunk.id], "manual");

    const memoryResult = await restoreChunks(registry, [chunk.id], config);
    assert.equal(memoryResult[0].status, "restored");
    assert.equal(memoryResult[0].restoreMode, "memory");

    registry.prune([chunk.id], "manual again");
    const state = registry.persistenceState();
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-prune-"));
    await writeFile(path.join(cwd, "file.txt"), "alpha\nbeta\ngamma\n", "utf8");

    const resumed = new ChunkRegistry();
    resumed.restorePersistence(state);
    const sourceResult = await restoreChunks(resumed, [chunk.id], config, { cwd });
    assert.equal(sourceResult[0].status, "restored");
    assert.equal(sourceResult[0].restoreMode, "source_rehydrate");
  });
});

describe("extension integration", () => {
  test("registers PLAN.md tools and auto-prunes in the context hook", async () => {
    const pi = createMockPi(testConfig());
    extension(pi as never);

    for (const name of [
      "list_context_chunks",
      "prune_chunks",
      "restore_chunks",
      "pin_chunks",
      "unpin_chunks",
      "context_pressure",
    ]) {
      assert.ok(pi.tools[name], `${name} was not registered`);
    }

    await pi.handlers.tool_result?.({
      toolCallId: "tool_a",
      toolName: "code_search",
      content: textBlock("src/a.ts:1: result\n".repeat(250)),
    });
    await pi.handlers.tool_result?.({
      toolCallId: "tool_b",
      toolName: "code_search",
      content: textBlock("src/b.ts:1: result\n".repeat(250)),
    });

    const list = await pi.tools.list_context_chunks.execute("list", { sortBy: "tokens" });
    assert.ok(list.content[0].text.includes("pc_"));

    const messages = [
      {
        role: "toolResult",
        toolCallId: "tool_a",
        content: textBlock("src/a.ts:1: result\n".repeat(250)),
      },
      {
        role: "toolResult",
        toolCallId: "tool_b",
        content: textBlock("src/b.ts:1: result\n".repeat(250)),
      },
    ];
    const contextResult = await pi.handlers.context?.(
      { messages },
      {
        hasUI: true,
        ui: pi.ui,
        getContextUsage: () => ({ tokens: 9_000, contextWindow: 10_000, percent: 90 }),
      },
    );

    assert.ok(
      contextResult?.messages.some((message: { content: ContentBlock[] }) =>
        message.content[0].text?.includes("[pruned:"),
      ),
    );
    assert.equal(messages[0].content[0].text, "src/a.ts:1: result\n".repeat(250));
    assert.ok(pi.entries.length > 0, "auto-prune should persist metadata");
  });
});

function createMockPi(config: PruneChunksConfig) {
  const handlers: Record<string, (event: any, ctx?: any) => Promise<any>> = {};
  const tools: Record<string, any> = {};
  const commands: Record<string, any> = {};
  const entries: any[] = [];
  const ui = {
    notices: [] as string[],
    statuses: {} as Record<string, string>,
    notify(message: string) {
      this.notices.push(message);
    },
    setStatus(name: string, value: string) {
      this.statuses[name] = value;
    },
  };
  return {
    config: { pruneChunks: config },
    handlers,
    tools,
    commands,
    entries,
    ui,
    on(name: string, handler: (event: any, ctx?: any) => Promise<any>) {
      handlers[name] = handler;
    },
    registerTool(definition: any) {
      tools[definition.name] = definition;
    },
    registerCommand(name: string, definition: any) {
      commands[name] = definition;
    },
    appendEntry(customType: string, data?: any) {
      entries.push({ type: "custom", customType, data });
    },
  };
}
