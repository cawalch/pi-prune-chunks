import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { describe } from "node:test";
import extension, { preserveContext } from "../index";
import { buildModelDecisionCardPrompt, modelDecisionCardFromResponse } from "../src/cards";
import {
  classifyKind,
  classifyRisk,
  collectToolResult,
  isReamerxExploratoryTool,
  isReamerxTerminalTool,
} from "../src/collector";
import { mergeConfig } from "../src/config";
import { CompositeChunkContentCache, DiskChunkContentCache } from "../src/diskCache";
import { applyPartTombstonesToContent } from "../src/parts";
import {
  autoPrune,
  pressureSummary,
  pruneReamerxExploratoryAfterTerminal,
  pruneSupersededAfterCollect,
  suggestPruneCandidates,
} from "../src/pruner";
import { ChunkRegistry, MemoryChunkContentCache } from "../src/registry";
import { renderChunkList, renderPressure } from "../src/render";
import { restoreChunks } from "../src/restorer";
import {
  computeMetrics,
  renderTelemetryReport,
  TelemetryRecorder,
  telemetryTombstoneTokens,
} from "../src/telemetry";
import { applyPrunedTombstones, tombstoneFor } from "../src/tombstones";
import type { ContentBlock, ContextChunk, ContextUsage, PruneChunksConfig } from "../src/types";

function textBlock(text: string): ContentBlock[] {
  return [{ type: "text", text }];
}

function testConfig(overrides?: Parameters<typeof mergeConfig>[0]): PruneChunksConfig {
  return mergeConfig({
    track: { minChunkTokens: 1 },
    autoPrune: {
      enabled: true,
      policy: "heuristic-v1",
      modelProfile: "auto",
      startAtPercent: 70,
      targetPercent: 55,
      preserveRecentChunks: 0,
      preserveRecentMinutes: 0,
      minChunkTokens: 1,
      maxChunksPerPass: 10,
      pruneSupersededOnIngest: true,
      pruneZeroMatchSearchesOnIngest: true,
    },
    tombstones: {
      includeSummary: true,
      includeRestoreHint: true,
      maxSummaryChars: 80,
      compactAtPercent: 90,
      coalesceAtPercent: 110,
      coalesceMinChunks: 16,
      maxCoalescedEntries: 120,
    },
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
  const chunk = registry.addCollected(collected, createdAt);
  registry.markSeenByToolCallId(id, createdAt + 1);
  return chunk;
}

describe("collector", () => {
  test("classifies generic, Reamer, and failure output", () => {
    assert.equal(classifyKind("code_read_range", "src/a.ts:1-2\ncode", {}), "file_read");
    assert.equal(classifyKind("code_overview", "directory tree\nsrc/index.ts", {}), "outline");
    assert.equal(classifyKind("repo_map", "repository map\nsrc/index.ts", {}), "outline");
    assert.equal(classifyKind("bash", "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@", {}), "diff");
    assert.equal(
      classifyKind("bash", "npm test\nFAIL test one\nCommand failed", {}),
      "test_output",
    );
    assert.equal(classifyRisk("test_output", "FAIL test one\nTraceback"), "high");
    assert.equal(classifyRisk("search", "src/a.ts:12: found symbol"), "low");
    assert.equal(
      classifyRisk("file_read", "large whole file\n".repeat(400), { path: "src/scanner.rs" }),
      "medium",
    );
    assert.equal(
      classifyRisk("file_read", "rules", { path: "RULES.md", startLine: 1, endLine: 80 }),
      "high",
    );
    assert.equal(
      classifyRisk("file_read", "bounded", { path: "src/scanner.rs", startLine: 20, endLine: 60 }),
      "low",
    );
    assert.equal(classifyRisk("file_read", "short read\n".repeat(80), { path: "src/a.ts" }), "low");
    assert.equal(
      classifyRisk("shell", "short status\n".repeat(80), {
        command: "git status --short",
      }),
      "low",
    );
    assert.equal(classifyKind("ffgrep", "parser/expression_parser.go\n  309: hit", {}), "search");
  });

  test("classifies ReamerX Pi/MCP exploratory and terminal tools", () => {
    assert.equal(classifyKind("reamerx_repo_map", "ReamerX repo-map", {}), "outline");
    assert.equal(classifyKind("mcp__reamerx__trace", "call graph", {}), "flow_trace");
    assert.equal(classifyKind("reamerx.impact", "callers and tests", {}), "flow_trace");
    assert.equal(classifyKind("reamerx_context", "source context", {}), "context_pack");
    assert.equal(classifyKind("edit_pack", "patch-ready bundle", {}), "context_pack");
    assert.equal(classifyKind("reamerx_changes", "diff --git a/a.ts b/a.ts", {}), "diff");
    assert.equal(isReamerxExploratoryTool("reamerx_trace"), true);
    assert.equal(isReamerxExploratoryTool("mcp__reamerx__impact"), true);
    assert.equal(isReamerxTerminalTool("reamerx_edit_pack"), true);
    assert.equal(isReamerxTerminalTool("reamerx.repo_map"), false);
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
    assert.equal(chunk.decisionCard?.generatedBy, "heuristic");
    assert.match(chunk.decisionCard?.gist ?? "", /read src\/file.ts:10-12/);
    assert.ok(chunk.decisionCard?.restoreWhen.includes("editing this source"));
    assert.ok(chunk.tokenEstimate > 0);
  });

  test("builds deterministic decision cards for common chunk kinds", () => {
    const config = testConfig();
    const zeroSearch = collectToolResult({
      toolCallId: "search_zero",
      toolName: "ffgrep",
      content: textBlock("No matches found"),
      params: { command: "rg MissingSymbol src" },
      config,
    });
    assert.ok(zeroSearch);
    assert.match(zeroSearch.decisionCard?.gist ?? "", /no matches/);
    assert.ok(
      zeroSearch.decisionCard?.safeToIgnoreWhen?.includes("absence of matches is sufficient"),
    );

    const failedTest = collectToolResult({
      toolCallId: "test_fail",
      toolName: "bash",
      content: textBlock(
        "$ npm test\nFAIL test/thing.test.ts\nAssertionError: expected true".repeat(20),
      ),
      params: { command: "npm test" },
      config,
    });
    assert.ok(failedTest);
    assert.equal(failedTest.kind, "test_output");
    assert.ok(failedTest.decisionCard?.hazards?.includes("contains failure output"));
    assert.ok(failedTest.decisionCard?.evidence.some((line) => line.includes("FAIL")));

    const diff = collectToolResult({
      toolCallId: "diff_1",
      toolName: "bash",
      content: textBlock("diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new".repeat(20)),
      config,
    });
    assert.ok(diff);
    assert.equal(diff.kind, "diff");
    assert.match(diff.decisionCard?.gist ?? "", /diff touching 1 file/);
    assert.deepEqual(diff.decisionCard?.evidence, ["src/a.ts"]);

    const pack = collectToolResult({
      toolCallId: "pack_1",
      toolName: "reamerx_edit_pack",
      content: textBlock(
        "ReamerX edit-pack: ready\nreadiness: ready\ntests: test/architecture.test.ts".repeat(20),
      ),
      config,
    });
    assert.ok(pack);
    assert.equal(pack.kind, "context_pack");
    assert.ok(pack.decisionCard?.evidence.some((line) => /readiness/.test(line)));
  });

  test("model-assisted decision cards are config-gated and bounded", () => {
    const heuristicConfig = testConfig();
    const modelConfig = testConfig({
      decisionCards: { mode: "model-assisted", maxModelInputTokens: 12, maxModelOutputChars: 32 },
    });
    const response = {
      gist: "model gist that is intentionally longer than the configured output budget",
      evidence: ["model evidence that is also too long for the output budget"],
      restoreWhen: ["need semantic model card"],
      sourceAnchors: ["src/cards.ts"],
    };

    const fallback = collectToolResult({
      toolCallId: "model_fallback",
      toolName: "read",
      content: textBlock("src/cards.ts:1 model ignored\n".repeat(80)),
      params: { path: "src/cards.ts", startLine: 1, endLine: 40 },
      modelCardResponse: response,
      config: heuristicConfig,
    });
    assert.ok(fallback);
    assert.equal(fallback.decisionCard?.generatedBy, "heuristic");

    const modeled = collectToolResult({
      toolCallId: "model_enabled",
      toolName: "read",
      content: textBlock("src/cards.ts:1 model used\n".repeat(80)),
      params: { path: "src/cards.ts", startLine: 1, endLine: 40 },
      modelCardResponse: JSON.stringify(response),
      config: modelConfig,
    });
    assert.ok(modeled);
    assert.equal(modeled.decisionCard?.generatedBy, "model");
    assert.ok((modeled.decisionCard?.gist.length ?? 0) <= 34);
    assert.ok(modeled.decisionCard?.sourceAnchors?.includes("src/cards.ts"));

    const invalid = modelDecisionCardFromResponse(
      "not json",
      fallback.decisionCard,
      modelConfig.decisionCards,
    );
    assert.equal(invalid.generatedBy, "heuristic");

    const prompt = buildModelDecisionCardPrompt({
      kind: "file_read",
      toolName: "read",
      text: "important line\n".repeat(100),
      source: { path: "src/cards.ts", startLine: 1, endLine: 20 },
      decisionCards: modelConfig.decisionCards,
    });
    assert.ok(prompt);
    assert.ok(prompt.includes("Input truncated to model-card budget"));
    assert.ok(prompt.length < 900);
  });

  test("research-heavy enables model-assisted card mode with heuristic fallback", () => {
    const config = testConfig({ profile: "research-heavy" });
    assert.equal(config.decisionCards.mode, "model-assisted");
    const chunk = collectToolResult({
      toolCallId: "research_card",
      toolName: "read",
      content: textBlock("src/research.ts:1 fallback card\n".repeat(80)),
      params: { path: "src/research.ts", startLine: 1, endLine: 20 },
      config,
    });
    assert.ok(chunk);
    assert.equal(chunk.decisionCard?.generatedBy, "heuristic");
  });

  test("infers source and low risk from read-only shell commands", () => {
    const config = testConfig();
    const sedChunk = collectToolResult({
      toolCallId: "shell_sed",
      toolName: "bash",
      content: textBlock("func execute() {}\n".repeat(120)),
      params: { command: "sed -n '120,180p' compiler/interpreter.go" },
      config,
    });
    assert.ok(sedChunk);
    assert.equal(sedChunk.kind, "file_read");
    assert.equal(sedChunk.risk, "low");
    assert.equal(sedChunk.source?.path, "compiler/interpreter.go");
    assert.equal(sedChunk.source?.startLine, 120);
    assert.equal(sedChunk.source?.endLine, 180);
    assert.equal(sedChunk.label, "compiler/interpreter.go:120-180");

    const numberedSedChunk = collectToolResult({
      toolCallId: "shell_nl_sed",
      toolName: "bash",
      content: textBlock("   10\tfunc execute() {}\n".repeat(120)),
      params: { command: "nl -ba compiler/interpreter.go | sed -n '10,30p'" },
      config,
    });
    assert.ok(numberedSedChunk);
    assert.equal(numberedSedChunk.kind, "file_read");
    assert.equal(numberedSedChunk.source?.path, "compiler/interpreter.go");
    assert.equal(numberedSedChunk.source?.startLine, 10);
    assert.equal(numberedSedChunk.source?.endLine, 30);

    const grepChunk = collectToolResult({
      toolCallId: "shell_grep",
      toolName: "bash",
      content: textBlock("$ grep -n Variable ast/nodes.go\nast/nodes.go:10: Variable\n".repeat(80)),
      config,
    });
    assert.ok(grepChunk);
    assert.equal(grepChunk.kind, "search");
    assert.equal(grepChunk.risk, "low");
    assert.equal(grepChunk.source?.command, "grep -n Variable ast/nodes.go");
    assert.equal(grepChunk.source?.path, "ast/nodes.go");
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

  test("applies named policy profiles before explicit overrides", () => {
    const local = mergeConfig({ profile: "local-32k" });
    assert.equal(local.profile, "local-32k");
    assert.equal(local.autoPrune.modelProfile, "local-32k");
    assert.equal(local.autoPrune.startAtPercent, 55);
    assert.equal(local.tombstones.compactAtPercent, 80);
    assert.equal(local.tombstones.coalesceMinChunks, 8);
    assert.equal(local.restore.diskCache.enabled, true);

    const cloud = mergeConfig({ profile: "cloud-1m" });
    assert.equal(cloud.autoPrune.modelProfile, "cloud-1m");
    assert.equal(cloud.autoPrune.preserveRecentChunks, 12);
    assert.equal(cloud.tombstones.maxSummaryChars, 280);

    const privacy = mergeConfig({ profile: "privacy-max" });
    assert.equal(privacy.tombstones.includeSummary, false);
    assert.equal(privacy.restore.diskCache.enabled, false);

    const override = mergeConfig({
      profile: "local-32k",
      autoPrune: { targetPercent: 55, preserveRecentChunks: 9 },
      tombstones: { maxSummaryChars: 200 },
    });
    assert.equal(override.autoPrune.startAtPercent, 55);
    assert.equal(override.autoPrune.targetPercent, 55);
    assert.equal(override.autoPrune.preserveRecentChunks, 9);
    assert.equal(override.tombstones.maxSummaryChars, 200);
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
    assert.equal(list.chunks[0].restoreMode, "memory");

    const persisted = registry.persistenceState();
    assert.equal(persisted.chunks[0].pinned, true);
    assert.equal(
      JSON.stringify(persisted).includes("src/a.ts:1: result\\nsrc/a.ts:1: result"),
      false,
    );
  });

  test("metadata restore explains why exact restore is unavailable", () => {
    const config = testConfig();
    const registry = new ChunkRegistry();
    const chunk = addChunk(
      registry,
      config,
      "search_1",
      "code_search",
      "symbol result without source location\n".repeat(80),
    );
    registry.prune([chunk.id], "manual");

    const resumed = new ChunkRegistry();
    resumed.restorePersistence(registry.persistenceState());
    const listed = resumed.list({ pruned: true });
    const rendered = renderChunkList(listed);

    assert.equal(listed.chunks[0].restoreAvailable, false);
    assert.equal(listed.chunks[0].restoreMode, "unavailable");
    assert.equal(
      listed.chunks[0].restoreUnavailableReason,
      "no memory content, disk cache, or source path metadata",
    );
    assert.ok(
      rendered.includes("unavailable: no memory content, disk cache, or source path metadata"),
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
    assert.ok(tombstone.includes("card="));
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

  test("renders compact tombstones for high-pressure context", () => {
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

    const normal = tombstoneFor(chunk, config)[0].text ?? "";
    const compact = tombstoneFor(chunk, config, { compact: true })[0].text ?? "";
    assert.ok(compact.includes(`[pruned:${chunk.id}`));
    assert.ok(compact.includes("restore_chunks"));
    assert.equal(compact.includes("summary="), false);
    assert.ok(compact.length < normal.length / 2);
  });

  test("coalesces many tombstones before extreme pressure", () => {
    const config = testConfig({ tombstones: { coalesceMinChunks: 3 } });
    const registry = new ChunkRegistry();
    const messages: Array<{ role: string; toolCallId: string; content: ContentBlock[] }> = [];
    for (let index = 0; index < 3; index++) {
      const toolCallId = `tool_${index}`;
      const chunk = addChunk(
        registry,
        config,
        toolCallId,
        "code_search",
        `src/file-${index}.ts:1: result\n`.repeat(120),
      );
      registry.prune([chunk.id], "done");
      messages.push({ role: "toolResult", toolCallId, content: textBlock("original") });
    }

    const applied = applyPrunedTombstones(
      messages,
      (toolCallId) => registry.prunedForToolCall(toolCallId),
      config,
    );

    assert.equal(applied.coalesced, true);
    assert.equal(applied.coalescedCount, 2);
    // Every toolResult is preserved (none dropped) so tool_use stays paired.
    assert.equal(applied.messages.length, 3);
    assert.deepEqual(
      applied.messages.map((message) => message.toolCallId),
      ["tool_0", "tool_1", "tool_2"],
    );
    assert.match(applied.messages[0].content[0].text ?? "", /^\[pruned-manifest:/);
    assert.match(applied.messages[1].content[0].text ?? "", /in pruned-manifest\]$/);
    assert.match(applied.messages[2].content[0].text ?? "", /^\[pruned:.* restore_chunks\]$/);
  });

  test("supports partial pruning and selective child restore", async () => {
    const config = testConfig();
    const registry = new ChunkRegistry();
    const text = [
      "$ npm test",
      "FAIL test/example.test.ts",
      "AssertionError: expected true",
      ...Array.from({ length: 900 }, (_, index) => `bulk stdout line ${index}`),
    ].join("\n");
    const parent = addChunk(registry, config, "test_tool", "bash", text, { command: "npm test" });
    const parts = registry.all().filter((chunk) => chunk.parentId === parent.id);
    assert.equal(parts.length, 1);
    const bulk = parts[0];
    assert.equal(bulk.id, `${parent.id}#bulk`);
    assert.equal(bulk.part?.role, "bulk");
    assert.ok(bulk.tokenEstimate > parent.tokenEstimate);

    registry.prune([bulk.id], "partial prune bulk output");
    const applied = applyPrunedTombstones(
      [{ role: "toolResult", toolCallId: "test_tool", content: textBlock(text) }],
      (toolCallId) => registry.prunedForToolCall(toolCallId),
      config,
      {},
      (toolCallId) => registry.prunedPartsForToolCall(toolCallId),
    );
    const rendered = applied.messages[0].content?.[0].text ?? "";
    assert.equal(applied.modified, true);
    assert.ok(rendered.includes("FAIL test/example.test.ts"));
    assert.ok(rendered.includes(`[pruned:${bulk.id}`));
    assert.equal(rendered.includes("bulk stdout line 200"), false);

    const [restoreResult] = await restoreChunks(registry, [bulk.id], config);
    assert.equal(restoreResult.status, "restored");
    assert.equal(registry.prunedPartsForToolCall("test_tool").length, 0);

    registry.prune([parent.id], "full prune after partial restore");
    const [parentRestore] = await restoreChunks(registry, [parent.id], config);
    assert.equal(parentRestore.status, "restored");
  });

  test("pruning a parent cascades to its parts and moves all tokens to pruned", () => {
    const config = testConfig();
    const registry = new ChunkRegistry();
    const text = [
      "header kept line",
      ...Array.from(
        { length: 500 },
        (_, index) => `bulk line ${index} padded to force a partial chunk`,
      ),
    ].join("\n");
    const parent = addChunk(registry, config, "read_tool", "read", text, { path: "src/big.ts" });
    const bulk = registry.all().find((chunk) => chunk.parentId === parent.id);
    assert.ok(bulk);
    assert.ok(bulk.tokenEstimate > parent.tokenEstimate);
    const before = registry.summary();

    const results = registry.prune([parent.id], "full prune parent");

    assert.deepEqual(new Set(results.map((result) => result.id)), new Set([parent.id, bulk.id]));
    assert.equal(registry.get(parent.id)?.pruned, true);
    assert.equal(registry.get(bulk.id)?.pruned, true);
    const after = registry.summary();
    assert.equal(
      after.activeTokens,
      before.activeTokens - parent.tokenEstimate - bulk.tokenEstimate,
    );
    assert.equal(
      after.prunedTokens,
      before.prunedTokens + parent.tokenEstimate + bulk.tokenEstimate,
    );
  });

  test("pruning a single part does not cascade to its parent", () => {
    const config = testConfig();
    const registry = new ChunkRegistry();
    const text = [
      "header kept line",
      ...Array.from(
        { length: 500 },
        (_, index) => `bulk line ${index} padded to force a partial chunk`,
      ),
    ].join("\n");
    const parent = addChunk(registry, config, "read_tool", "read", text, { path: "src/big.ts" });
    const bulk = registry.all().find((chunk) => chunk.parentId === parent.id);
    assert.ok(bulk);

    const results = registry.prune([bulk.id], "partial prune");

    assert.deepEqual(
      results.map((result) => result.id),
      [bulk.id],
    );
    assert.equal(registry.get(bulk.id)?.pruned, true);
    assert.equal(registry.get(parent.id)?.pruned, false);
  });

  test("restoring a parent cascades to its parts", async () => {
    const config = testConfig();
    const registry = new ChunkRegistry();
    const text = [
      "header kept line",
      ...Array.from(
        { length: 500 },
        (_, index) => `bulk line ${index} padded to force a partial chunk`,
      ),
    ].join("\n");
    const parent = addChunk(registry, config, "read_tool", "read", text, { path: "src/big.ts" });
    const bulk = registry.all().find((chunk) => chunk.parentId === parent.id);
    assert.ok(bulk);
    registry.prune([parent.id], "full prune");

    const results = await restoreChunks(registry, [parent.id], config);
    const restored = results
      .filter((result) => result.status === "restored")
      .map((result) => result.id);

    assert.deepEqual(new Set(restored), new Set([parent.id, bulk.id]));
    assert.equal(registry.get(parent.id)?.pruned, false);
    assert.equal(registry.get(bulk.id)?.pruned, false);
  });

  test("supersede-pruning escalates superseded parents only at compact pressure", () => {
    const config = testConfig();
    const registry = new ChunkRegistry();
    const bigText = Array.from(
      { length: 600 },
      (_, index) => `line ${index} padded so the read splits into a bulk part`,
    ).join("\n");
    const parent = addChunk(registry, config, "read_a", "read", bigText, {
      path: "src/same.ts",
      startLine: 1,
      endLine: 600,
    });
    const bulk = registry.all().find((chunk) => chunk.parentId === parent.id);
    assert.ok(bulk);
    // Newer read overlaps the parent (1-600) but not its bulk part (33-600).
    const newer = addChunk(registry, config, "read_b", "read", "header re-read", {
      path: "src/same.ts",
      startLine: 1,
      endLine: 32,
    });

    // Below compact pressure the parent-with-children is protected.
    const low = pruneSupersededAfterCollect(registry, newer, config, 50);
    assert.equal(low.pruned.length, 0);
    assert.equal(registry.get(parent.id)?.pruned, false);

    // At compact pressure the overlapping read supersedes the parent, which
    // cascades to its bulk part.
    const high = pruneSupersededAfterCollect(registry, newer, config, 92);
    assert.ok(high.pruned.some((result) => result.id === parent.id));
    assert.equal(registry.get(parent.id)?.pruned, true);
    assert.equal(registry.get(bulk.id)?.pruned, true);
  });

  test("evictAbsentFromContext prunes seen main-scope chunks no longer in the transcript", () => {
    const config = testConfig();
    const registry = new ChunkRegistry();
    const kept = addChunk(registry, config, "kept", "code_search", "src/kept:1\n".repeat(120));
    const gone = addChunk(registry, config, "gone", "code_search", "src/gone:1\n".repeat(120));
    registry.markSeenByToolCallId("kept");
    registry.markSeenByToolCallId("gone");

    const evicted = registry.evictAbsentFromContext(new Set(["kept"]));

    assert.deepEqual(
      evicted.map((result) => result.id),
      [gone.id],
    );
    assert.equal(registry.get(gone.id)?.pruned, true);
    assert.equal(registry.get(kept.id)?.pruned, false);
  });

  test("evictAbsentFromContext skips eviction when no main-scope chunk is present", () => {
    const config = testConfig();
    const registry = new ChunkRegistry();
    const chunk = addChunk(registry, config, "main_1", "code_search", "src/main:1\n".repeat(120));
    registry.markSeenByToolCallId("main_1");

    // No tracked main-scope chunk is present (e.g. a subagent context event):
    // must not evict main chunks that are merely absent from this context.
    const evicted = registry.evictAbsentFromContext(new Set(["subagent_only"]));

    assert.deepEqual(evicted, []);
    assert.equal(registry.get(chunk.id)?.pruned, false);
  });

  test("coalesces full tombstones even when other messages have pruned parts", () => {
    const config = testConfig({ tombstones: { coalesceMinChunks: 3 } });
    const registry = new ChunkRegistry();
    const partialText = [
      "important header",
      ...Array.from(
        { length: 500 },
        (_, index) =>
          `bulk line ${index} with enough repeated implementation detail to create a partial chunk`,
      ),
    ].join("\n");
    const partialParent = addChunk(registry, config, "partial_tool", "read", partialText, {
      path: "src/partial.ts",
    });
    const partialBulk = registry.all().find((chunk) => chunk.parentId === partialParent.id);
    assert.ok(partialBulk);
    registry.prune([partialBulk.id], "partial prune bulk");

    const messages: Array<{ role: string; toolCallId: string; content: ContentBlock[] }> = [
      { role: "toolResult", toolCallId: "partial_tool", content: textBlock(partialText) },
    ];
    for (let index = 0; index < 3; index++) {
      const toolCallId = `full_${index}`;
      const chunk = addChunk(
        registry,
        config,
        toolCallId,
        "code_search",
        `src/file-${index}.ts:1: result\n`.repeat(120),
      );
      registry.prune([chunk.id], "full prune");
      messages.push({ role: "toolResult", toolCallId, content: textBlock("full output") });
    }

    const applied = applyPrunedTombstones(
      messages,
      (toolCallId) => registry.prunedForToolCall(toolCallId),
      config,
      {},
      (toolCallId) => registry.prunedPartsForToolCall(toolCallId),
    );

    assert.equal(applied.coalesced, true);
    assert.equal(applied.coalescedCount, 2);
    assert.equal(applied.messages.length, 4);
    assert.equal(applied.messages[0].toolCallId, "partial_tool");
    assert.equal(applied.messages[1].toolCallId, "full_0");
    assert.equal(applied.messages[2].toolCallId, "full_1");
    assert.equal(applied.messages[3].toolCallId, "full_2");
    assert.match(applied.messages[0].content[0].text ?? "", /important header/);
    assert.match(applied.messages[0].content[0].text ?? "", /\[pruned:.*#bulk/);
    assert.match(applied.messages[1].content[0].text ?? "", /^\[pruned-manifest:/);
    assert.match(applied.messages[2].content[0].text ?? "", /in pruned-manifest\]$/);
    assert.match(applied.messages[3].content[0].text ?? "", /^\[pruned:.* restore_chunks\]$/);
  });

  test("coalescing never drops toolResult messages so tool_use stays paired", () => {
    const config = testConfig({ tombstones: { coalesceMinChunks: 3 } });
    const registry = new ChunkRegistry();
    const messages: Array<{ role: string; toolCallId: string; content: ContentBlock[] }> = [];
    for (let index = 0; index < 4; index++) {
      const toolCallId = `pair_${index}`;
      const chunk = addChunk(
        registry,
        config,
        toolCallId,
        "code_search",
        `src/file-${index}.ts:1: result\n`.repeat(120),
      );
      registry.prune([chunk.id], "done");
      messages.push({ role: "toolResult", toolCallId, content: textBlock("original") });
    }

    const applied = applyPrunedTombstones(
      messages,
      (toolCallId) => registry.prunedForToolCall(toolCallId),
      config,
      { coalesce: true },
    );

    assert.equal(applied.coalesced, true);
    // Same number of messages out as in: nothing dropped, so every tool_use
    // still has a paired toolResult.
    assert.equal(applied.messages.length, messages.length);
    assert.deepEqual(
      applied.messages.map((message) => message.toolCallId),
      ["pair_0", "pair_1", "pair_2", "pair_3"],
    );
    assert.match(applied.messages[0].content[0].text ?? "", /^\[pruned-manifest:/);
    assert.match(applied.messages[1].content[0].text ?? "", /in pruned-manifest\]$/);
    assert.match(applied.messages[2].content[0].text ?? "", /in pruned-manifest\]$/);
    assert.match(applied.messages[3].content[0].text ?? "", /^\[pruned:.* restore_chunks\]$/);
  });

  test("applyPartTombstonesToContent replaces only the part's inclusive line range", () => {
    const lines = Array.from({ length: 10 }, (_, index) => `L${index + 1}`);
    const part = {
      id: "pc_0001_abc#mid",
      part: { index: 0, label: "mid", lineStart: 3, lineEnd: 5, role: "bulk" },
    } as unknown as ContextChunk;
    const result = applyPartTombstonesToContent(
      textBlock(lines.join("\n")),
      [part],
      () => "<<TOMB>>",
    );
    // Lines 3-5 replaced by the tombstone; lines 1-2 and 6-10 untouched
    // (previously line 6 was also eaten by an off-by-one in the splice count).
    assert.equal(
      (result[0] as { text?: string }).text ?? "",
      "L1\nL2\n<<TOMB>>\nL6\nL7\nL8\nL9\nL10",
    );
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

  test("auto-prune can fully prune parent chunks with children at compact pressure", () => {
    const config = testConfig();
    const registry = new ChunkRegistry();
    const text = Array.from(
      { length: 500 },
      (_, index) =>
        `export const value${index} = ${index}; // enough repeated implementation detail to create a partial chunk`,
    ).join("\n");
    const parent = addChunk(registry, config, "large_read", "read", text, { path: "src/large.ts" });
    const bulk = registry.all().find((chunk) => chunk.parentId === parent.id);
    assert.ok(bulk);
    registry.prune([bulk.id], "partial prune bulk first");

    const usage: ContextUsage = { tokens: 9_200, contextWindow: 10_000, percent: 92 };
    const result = autoPrune(registry, usage, config);

    assert.equal(result.triggered, true);
    assert.equal(registry.get(parent.id)?.pruned, true);
  });

  test("auto-prune waits until a chunk has been seen in model context", () => {
    const config = testConfig();
    const registry = new ChunkRegistry();
    const collected = collectToolResult({
      toolCallId: "fresh_search",
      toolName: "ffgrep",
      content: textBlock("parser/expression_parser.go\n  309: rangeExpr\n".repeat(160)),
      config,
    });
    assert.ok(collected);
    const chunk = registry.addCollected(collected, Date.now() - 60_000);

    const usage: ContextUsage = { tokens: 9_000, contextWindow: 10_000, percent: 90 };
    const firstPass = autoPrune(registry, usage, config);

    assert.equal(firstPass.triggered, true);
    assert.equal(firstPass.pruned.length, 0);
    assert.equal(registry.get(chunk.id)?.pruned, false);

    registry.markSeenByToolCallId("fresh_search");
    const secondPass = autoPrune(registry, usage, config);

    assert.equal(secondPass.pruned.length, 1);
    assert.equal(registry.get(chunk.id)?.pruned, true);
  });

  test("auto-prune relaxes age, token floor, and recent guards under pressure", () => {
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
        pruneSupersededOnIngest: true,
        pruneZeroMatchSearchesOnIngest: true,
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
    assert.equal(registry.summary().prunedChunks, 4);
    assert.equal(registry.active().length, 2);
  });

  test("auto-prune keeps pruning toward target within max chunk pass", () => {
    const config = testConfig({
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
    });
    const registry = new ChunkRegistry();
    const now = Date.now() - 60_000;
    for (let i = 0; i < 8; i++) {
      addChunk(
        registry,
        config,
        `target_${i}`,
        "code_search",
        `src/${i}.ts:1: result target gap\n`.repeat(120),
        undefined,
        now - i,
      );
    }

    const targetSavings = 9_000 - Math.floor(10_000 * 0.55);
    const result = autoPrune(
      registry,
      { tokens: 9_000, contextWindow: 10_000, percent: 90 },
      config,
      { now },
    );

    assert.equal(result.triggered, true);
    assert.ok(result.savedTokens >= targetSavings || registry.active().length === 0);
    assert.ok(result.pruned.length > 1);
  });

  test("auto-prune stops preserving recent chunks at high pressure", () => {
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
        pruneSupersededOnIngest: true,
        pruneZeroMatchSearchesOnIngest: true,
      },
    });
    const registry = new ChunkRegistry();
    const now = Date.now();
    for (let i = 0; i < 4; i++) {
      addChunk(
        registry,
        config,
        `recent_${i}`,
        "code_search",
        `src/recent-${i}.ts:1: result\n`.repeat(120),
        undefined,
        now - i,
      );
    }

    const candidates = suggestPruneCandidates(registry, config, {
      now,
      pressurePercent: 81,
    });

    assert.equal(candidates.length, 4);
    assert.ok(candidates.every((candidate) => candidate.reasons.includes("low risk")));
  });

  test("duplicate content is prioritized as a prune candidate", () => {
    const config = testConfig();
    const registry = new ChunkRegistry();
    const duplicateText = "src/shared.ts:1: repeated symbol\n".repeat(120);
    const unique = addChunk(
      registry,
      config,
      "unique",
      "code_search",
      "src/unique.ts:1: unique symbol\n".repeat(120),
    );
    const firstDuplicate = addChunk(registry, config, "dup_1", "code_search", duplicateText);
    const secondDuplicate = addChunk(registry, config, "dup_2", "code_search", duplicateText);

    const candidates = suggestPruneCandidates(registry, config, { limit: 3 });

    assert.deepEqual(
      candidates
        .slice(0, 2)
        .map((candidate) => candidate.id)
        .sort(),
      [firstDuplicate.id, secondDuplicate.id].sort(),
    );
    assert.ok(candidates[0].reasons.includes("duplicate content"));
    assert.equal(
      candidates.some((candidate) => candidate.id === unique.id),
      true,
    );
  });

  test("terminal ReamerX evidence prunes prior exploratory chunks and preserves terminal evidence", () => {
    const config = testConfig();
    const registry = new ChunkRegistry();
    const repoMap = addChunk(
      registry,
      config,
      "repo_map",
      "reamerx_repo_map",
      "large repo map\n".repeat(160),
    );
    const trace = addChunk(
      registry,
      config,
      "trace",
      "mcp__reamerx__trace",
      "large trace\n".repeat(160),
    );
    const terminal = addChunk(
      registry,
      config,
      "edit_pack",
      "reamerx_edit_pack",
      "patch-ready bundle\n".repeat(160),
    );

    const result = pruneReamerxExploratoryAfterTerminal(registry, terminal, config);

    assert.equal(result.triggered, true);
    assert.equal(result.pruned.length, 2);
    assert.equal(registry.get(repoMap.id)?.pruned, true);
    assert.equal(registry.get(trace.id)?.pruned, true);
    assert.equal(registry.get(terminal.id)?.pruned, false);

    const applied = applyPrunedTombstones(
      [
        {
          role: "toolResult",
          toolCallId: "repo_map",
          content: textBlock("large repo map\n".repeat(160)),
        },
        {
          role: "toolResult",
          toolCallId: "trace",
          content: textBlock("large trace\n".repeat(160)),
        },
        {
          role: "toolResult",
          toolCallId: "edit_pack",
          content: textBlock("patch-ready bundle\n".repeat(160)),
        },
      ],
      (toolCallId) => registry.prunedForToolCall(toolCallId),
      config,
    );
    assert.equal(applied.modified, true);
    assert.ok(applied.messages[0].content[0].text?.includes("[pruned:"));
    assert.ok(applied.messages[1].content[0].text?.includes("[pruned:"));
    assert.equal(applied.messages[2].content[0].text, "patch-ready bundle\n".repeat(160));
  });

  test("terminal ReamerX pruning is configurable and skips pinned/high-risk chunks", () => {
    const config = testConfig({ reamerx: { pruneExploratoryAfterTerminal: false } });
    const registry = new ChunkRegistry();
    const exploratory = addChunk(
      registry,
      config,
      "repo_map",
      "reamerx_repo_map",
      "large repo map\n".repeat(160),
    );
    const terminal = addChunk(
      registry,
      config,
      "edit_pack",
      "reamerx_edit_pack",
      "patch-ready bundle\n".repeat(160),
    );

    const disabled = pruneReamerxExploratoryAfterTerminal(registry, terminal, config);
    assert.equal(disabled.triggered, false);
    assert.equal(registry.get(exploratory.id)?.pruned, false);

    const enabledConfig = testConfig();
    const pinnedRegistry = new ChunkRegistry();
    const pinned = addChunk(
      pinnedRegistry,
      enabledConfig,
      "trace",
      "reamerx_trace",
      "large trace\n".repeat(160),
    );
    pinnedRegistry.pin([pinned.id], "still relevant");
    const enabledTerminal = addChunk(
      pinnedRegistry,
      enabledConfig,
      "edit_pack",
      "reamerx_edit_pack",
      "patch-ready bundle\n".repeat(160),
    );

    const enabled = pruneReamerxExploratoryAfterTerminal(
      pinnedRegistry,
      enabledTerminal,
      enabledConfig,
    );
    assert.equal(enabled.triggered, true);
    assert.equal(enabled.pruned.length, 0);
    assert.equal(pinnedRegistry.get(pinned.id)?.pruned, false);
  });

  test("ingest pruning removes superseded reads, duplicate commands, zero-match searches, and old diffs", () => {
    const config = testConfig();
    const registry = new ChunkRegistry();
    const oldRead = addChunk(
      registry,
      config,
      "read_old",
      "read",
      "compiler/interpreter.go:100: old context\n".repeat(120),
      { path: "compiler/interpreter.go", startLine: 100, endLine: 180 },
    );
    const newRead = addChunk(
      registry,
      config,
      "read_new",
      "read",
      "compiler/interpreter.go:120: newer context\n".repeat(120),
      { path: "compiler/interpreter.go", startLine: 120, endLine: 220 },
    );
    const readPrune = pruneSupersededAfterCollect(registry, newRead, config);

    assert.equal(registry.get(oldRead.id)?.pruned, true);
    assert.equal(registry.get(newRead.id)?.pruned, false);
    assert.ok(readPrune.pruned.some((result) => result.id === oldRead.id));

    const firstCommand = addChunk(
      registry,
      config,
      "cmd_1",
      "bash",
      "$ grep -n Variable ast/nodes.go\nast/nodes.go:10: Variable\n".repeat(80),
      { command: 'grep -n "Variable" ast/nodes.go' },
    );
    const secondCommand = addChunk(
      registry,
      config,
      "cmd_2",
      "bash",
      "$ grep -n Variable ast/nodes.go\nast/nodes.go:10: Variable\n".repeat(80),
      { command: 'grep -n "Variable" ast/nodes.go' },
    );
    pruneSupersededAfterCollect(registry, secondCommand, config);

    assert.equal(registry.get(firstCommand.id)?.pruned, true);
    assert.equal(registry.get(secondCommand.id)?.pruned, false);

    const zeroMatch = addChunk(
      registry,
      config,
      "zero",
      "code_search",
      "0 exact matches. Maybe you meant this?\n".repeat(80),
    );
    pruneSupersededAfterCollect(registry, zeroMatch, config);
    assert.equal(registry.get(zeroMatch.id)?.pruned, true);

    const oldDiff = addChunk(
      registry,
      config,
      "diff_old",
      "git_diff",
      "diff --git a/parser/quantifier_parser.go b/parser/quantifier_parser.go\n@@ -1 +1 @@\n-old\n+new\n".repeat(
        40,
      ),
    );
    const newDiff = addChunk(
      registry,
      config,
      "diff_new",
      "git_diff",
      "diff --git a/parser/quantifier_parser.go b/parser/quantifier_parser.go\n@@ -1 +1 @@\n-new\n+newer\n".repeat(
        40,
      ),
    );
    pruneSupersededAfterCollect(registry, newDiff, config);
    assert.equal(registry.get(oldDiff.id)?.pruned, true);
    assert.equal(registry.get(newDiff.id)?.pruned, false);

    const pinnedRead = addChunk(
      registry,
      config,
      "read_pinned",
      "read",
      "compiler/pinned.go:10: pinned context\n".repeat(120),
      { path: "compiler/pinned.go", startLine: 10, endLine: 90 },
    );
    registry.pin([pinnedRead.id], "still relevant");
    const overlappingPinnedRead = addChunk(
      registry,
      config,
      "read_pinned_new",
      "read",
      "compiler/pinned.go:20: newer pinned context\n".repeat(120),
      { path: "compiler/pinned.go", startLine: 20, endLine: 100 },
    );
    pruneSupersededAfterCollect(registry, overlappingPinnedRead, config);
    assert.equal(registry.get(pinnedRead.id)?.pruned, false);
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
        pruneSupersededOnIngest: true,
        pruneZeroMatchSearchesOnIngest: true,
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

  test("auto-prune does not treat pathless orientation output as unbounded source", () => {
    const config = testConfig();
    const registry = new ChunkRegistry();
    const overview = addChunk(
      registry,
      config,
      "overview",
      "read",
      "directory tree\nsrc/index.ts\nsrc/pruner.ts\n".repeat(120),
    );

    const result = autoPrune(
      registry,
      { tokens: 7_500, contextWindow: 10_000, percent: 75 },
      config,
    );

    assert.equal(result.triggered, true);
    assert.equal(registry.get(overview.id)?.pruned, true);
  });

  test("auto-prune protects chunks for modified and recently mentioned paths", () => {
    const config = testConfig();
    const registry = new ChunkRegistry();
    const modified = addChunk(
      registry,
      config,
      "modified",
      "code_read_range",
      "src/work.ts:1-40\n".repeat(200),
      { path: "src/work.ts", startLine: 1, endLine: 40 },
    );
    const mentioned = addChunk(
      registry,
      config,
      "mentioned",
      "code_read_range",
      "src/focus.ts:1-40\n".repeat(200),
      { path: "src/focus.ts", startLine: 1, endLine: 40 },
    );
    const anchored = addChunk(
      registry,
      config,
      "anchored",
      "code_search",
      "Tracking issue #123\nAssertionError: keep this diagnostic\n".repeat(80),
    );
    const disposable = addChunk(
      registry,
      config,
      "search",
      "code_search",
      "src/old.ts:1: result\n".repeat(200),
    );

    const preserve = preserveContext(
      [
        { role: "user", content: textBlock("Please keep src/focus.ts and issue #123 in view") },
        { role: "assistant", content: textBlock("I am editing src/other.ts") },
      ],
      { modifiedFiles: ["src/work.ts"] },
    );
    const result = autoPrune(
      registry,
      { tokens: 9_000, contextWindow: 10_000, percent: 90 },
      config,
      { preserve },
    );

    assert.equal(result.triggered, true);
    assert.equal(registry.get(modified.id)?.pruned, false);
    assert.equal(registry.get(mentioned.id)?.pruned, false);
    assert.equal(registry.get(anchored.id)?.pruned, false);
    assert.equal(registry.get(disposable.id)?.pruned, true);

    const pressure = pressureSummary(
      registry,
      { tokens: 9_000, contextWindow: 10_000, percent: 90 },
      config,
      preserve,
    );
    assert.ok(
      pressure.blockedCandidates.some((candidate) =>
        candidate.reason.includes("contains active reasoning anchor: #123"),
      ),
    );
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
    assert.equal(pressure.autoPrune.profile, "coding-heavy");
    assert.equal(pressure.recommendedCandidates.length, 1);
  });

  test("adaptive policy changes outcomes by model profile and explains scores", () => {
    const baseConfig = {
      track: { minChunkTokens: 1 },
      autoPrune: {
        enabled: true,
        policy: "adaptive-v1" as const,
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
    const localConfig = mergeConfig({
      ...baseConfig,
      autoPrune: { ...baseConfig.autoPrune, modelProfile: "local-32k" as const },
    });
    const cloudConfig = mergeConfig({
      ...baseConfig,
      autoPrune: { ...baseConfig.autoPrune, modelProfile: "cloud-1m" as const },
    });
    const now = Date.now() - 60_000;

    const localRegistry = new ChunkRegistry();
    const localRead = addChunk(
      localRegistry,
      localConfig,
      "local_read",
      "read",
      "large source file\n".repeat(220),
      { path: "src/large.ts" },
      now,
    );
    addChunk(
      localRegistry,
      localConfig,
      "local_search",
      "code_search",
      "src/a.ts:1: hit\n".repeat(220),
      undefined,
      now,
    );

    const cloudRegistry = new ChunkRegistry();
    const cloudRead = addChunk(
      cloudRegistry,
      cloudConfig,
      "cloud_read",
      "read",
      "large source file\n".repeat(220),
      { path: "src/large.ts" },
      now,
    );
    addChunk(
      cloudRegistry,
      cloudConfig,
      "cloud_search",
      "code_search",
      "src/a.ts:1: hit\n".repeat(220),
      undefined,
      now,
    );

    const localCandidates = suggestPruneCandidates(localRegistry, localConfig, {
      pressurePercent: 80,
    });
    const cloudCandidates = suggestPruneCandidates(cloudRegistry, cloudConfig, {
      pressurePercent: 80,
    });

    assert.equal(
      localCandidates.some((candidate) => candidate.id === localRead.id),
      true,
    );
    assert.equal(
      cloudCandidates.some((candidate) => candidate.id === cloudRead.id),
      false,
    );
    assert.equal(localCandidates[0].policy, "adaptive-v1");
    assert.ok(localCandidates[0].confidence);

    const pressure = pressureSummary(
      localRegistry,
      { tokens: 8_000, contextWindow: 10_000, percent: 80 },
      localConfig,
    );
    assert.equal(pressure.autoPrune.policy, "adaptive-v1");
    assert.equal(pressure.autoPrune.modelProfile, "local-32k");
    assert.equal(pressure.autoPrune.pressureBand, "high");
    assert.ok(
      renderPressure(
        localRegistry,
        { tokens: 8_000, contextWindow: 10_000, percent: 80 },
        localConfig,
      ).includes("profile=coding-heavy policy=adaptive-v1"),
    );
  });

  test("subagent scope grouping prioritizes child exploration after a manifest", async () => {
    const config = testConfig();
    config.autoPrune.policy = "adaptive-v1";
    const registry = new ChunkRegistry();
    const childScope = {
      scope: "subagent" as const,
      runId: "child-1",
      parentRunId: "parent-1",
      agentName: "researcher",
    };
    const childSearch = collectToolResult({
      toolCallId: "child_search",
      toolName: "code_search",
      content: textBlock("src/a.ts:1: child hit\n".repeat(160)),
      scope: childScope,
      config,
    });
    const childManifest = collectToolResult({
      toolCallId: "child_manifest",
      toolName: "reamerx_edit_pack",
      content: textBlock("child evidence manifest\nreadiness: ready\n".repeat(120)),
      scope: childScope,
      config,
    });
    assert.ok(childSearch);
    assert.ok(childManifest);
    const searchChunk = registry.addCollected(childSearch, Date.now() - 20 * 60_000);
    registry.markSeenByToolCallId("child_search");
    registry.addCollected(childManifest, Date.now() - 10 * 60_000);
    registry.markSeenByToolCallId("child_manifest");

    const subagentList = registry.list({ scope: "subagent", limit: 10 });
    assert.equal(subagentList.chunks.length, 2);
    assert.equal(subagentList.chunks[0].scope?.agentName, "researcher");

    const candidates = suggestPruneCandidates(registry, config, { limit: 10 });
    const childCandidate = candidates.find((candidate) => candidate.id === searchChunk.id);
    assert.ok(childCandidate);
    assert.ok(childCandidate.reasons.includes("subagent context isolated after child manifest"));

    registry.prune([searchChunk.id], "child manifest consolidated");
    const [restored] = await restoreChunks(registry, [searchChunk.id], config);
    assert.equal(restored.status, "restored");
  });

  test("adaptive policy protects restored chunks and includes restore history in scores", async () => {
    const config = mergeConfig({
      track: { minChunkTokens: 1 },
      autoPrune: {
        enabled: true,
        policy: "adaptive-v1",
        modelProfile: "local-32k",
        startAtPercent: 70,
        targetPercent: 55,
        preserveRecentChunks: 0,
        preserveRecentMinutes: 10,
        minChunkTokens: 1,
        maxChunksPerPass: 10,
        pruneSupersededOnIngest: true,
        pruneZeroMatchSearchesOnIngest: true,
      },
    });
    const registry = new ChunkRegistry();
    const now = Date.now();
    const restored = addChunk(
      registry,
      config,
      "restored_chunk",
      "code_search",
      "src/restored.ts:1: hit\n".repeat(220),
      undefined,
      now - 20 * 60_000,
    );
    registry.prune([restored.id], "manual");
    const [result] = await restoreChunks(registry, [restored.id], config);
    assert.equal(result.status, "restored");

    const blocked = pressureSummary(
      registry,
      { tokens: 8_000, contextWindow: 10_000, percent: 80 },
      config,
    ).blockedCandidates;
    assert.equal(blocked[0].id, restored.id);
    assert.equal(blocked[0].reason, "restored recently");

    const later = suggestPruneCandidates(registry, config, {
      now: now + 30 * 60_000,
      pressurePercent: 80,
    });
    assert.equal(later[0].id, restored.id);
    assert.ok(later[0].reasons.includes("restored 1x before"));
  });

  test("pressure report explains protected chunks", () => {
    const config = testConfig();
    const registry = new ChunkRegistry();
    const chunk = addChunk(
      registry,
      config,
      "work",
      "code_read_range",
      "src/work.ts:1-40\n".repeat(120),
      { path: "src/work.ts", startLine: 1, endLine: 40 },
    );

    const pressure = pressureSummary(
      registry,
      { tokens: 8_000, contextWindow: 10_000, percent: 80 },
      config,
      { paths: new Set(["src/work.ts"]) },
    );

    assert.equal(pressure.recommendedCandidates.length, 0);
    assert.equal(pressure.blockedCandidates[0].id, chunk.id);
    assert.equal(pressure.blockedCandidates[0].reason, "referenced by active working context");
  });

  test("telemetry records collect, prune, restore, tombstone, and coalesce metrics", async () => {
    const config = testConfig();
    const registry = new ChunkRegistry();
    const telemetry = new TelemetryRecorder();
    const chunk = addChunk(
      registry,
      config,
      "telemetry_chunk",
      "code_search",
      "src/a.ts:1: hit\n".repeat(220),
    );
    telemetry.recordCollected(chunk);
    const pruneResults = registry.prune([chunk.id], "auto test", "auto_pruned");
    telemetry.recordActionResults("auto_prune", pruneResults, "auto test");
    const restoreResults = await restoreChunks(registry, [chunk.id], config);
    telemetry.recordRestoreResults(restoreResults);

    const messages = [
      { role: "toolResult", toolCallId: "old_a", content: textBlock("older A") },
      { role: "toolResult", toolCallId: "old_b", content: textBlock("older B") },
    ];
    const oldA = addChunk(registry, config, "old_a", "code_search", "old A\n".repeat(120));
    const oldB = addChunk(registry, config, "old_b", "code_search", "old B\n".repeat(120));
    registry.prune([oldA.id, oldB.id], "manual");
    const tombstones = applyPrunedTombstones(
      messages,
      (toolCallId) => registry.prunedForToolCall(toolCallId),
      config,
      { coalesce: true },
    );
    telemetry.recordTombstones({
      tombstoneTokens: telemetryTombstoneTokens(tombstones.messages),
      coalesced: tombstones.coalesced,
      coalescedCount: tombstones.coalescedCount,
    });

    const metrics = computeMetrics(telemetry.persistenceState());
    assert.equal(metrics.collectedChunks, 1);
    assert.equal(metrics.autoPrunes, 1);
    assert.equal(metrics.restores, 1);
    assert.equal(metrics.falsePositiveAutoPrunes, 1);
    assert.equal(metrics.coalescingEvents, 1);
    assert.equal(metrics.coalescedChunks, 1);
    assert.ok(metrics.tombstoneTokens > 0);

    const report = renderTelemetryReport(telemetry.snapshot(registry.summary(), config, null));
    assert.ok(report.includes("# Prune Chunks Telemetry Report"));
    assert.ok(report.includes("## Restore availability"));
    assert.ok(report.includes("## Pruned tokens by kind"));
    assert.ok(report.includes("Raw tool output is not included"));
  });

  test("telemetry pressure deltas compare successive pressure samples", () => {
    const config = testConfig();
    const registry = new ChunkRegistry();
    const telemetry = new TelemetryRecorder();
    addChunk(registry, config, "delta_a", "code_search", "src/a.ts:1: hit\n".repeat(120));

    assert.match(telemetry.pressureDelta(registry.summary()), /first pressure sample/);
    const chunk = addChunk(
      registry,
      config,
      "delta_b",
      "code_search",
      "src/b.ts:1: hit\n".repeat(120),
    );
    registry.prune([chunk.id], "manual");
    assert.match(telemetry.pressureDelta(registry.summary()), /active .*t, pruned \+\d+t/);
  });

  test("pressure report explains when target is unreachable from chunks alone", () => {
    const config = testConfig();
    const registry = new ChunkRegistry();
    addChunk(registry, config, "safe", "code_search", "src/a.ts:1: result\n".repeat(100));

    const usage = { tokens: 8_000, contextWindow: 10_000, percent: 80 };
    const pressure = pressureSummary(registry, usage, config);
    const rendered = renderPressure(registry, usage, config);

    assert.equal(pressure.autoPrune.targetReachableByChunks, false);
    assert.ok(rendered.includes("Non-chunk tokens:"));
    assert.ok(rendered.includes("cannot be reached"));
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

  test("restores non-source chunks from durable disk cache after metadata reload", async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), "pi-prune-cache-"));
    const config = testConfig({
      restore: {
        memory: true,
        diskCache: {
          enabled: true,
          directory: cacheDir,
          maxBytes: 10_000_000,
          maxAgeDays: 1,
          maxBlobBytes: 1_000_000,
        },
        sourceRehydrate: true,
      },
    });
    const cache = new CompositeChunkContentCache(
      new MemoryChunkContentCache(),
      new DiskChunkContentCache(config.restore.diskCache),
    );
    const registry = new ChunkRegistry(cache);
    const chunk = addChunk(
      registry,
      config,
      "search_1",
      "web_search",
      "Answer: useful fact\n".repeat(120),
    );
    registry.prune([chunk.id], "manual");
    const state = registry.persistenceState();
    registry.reset();

    const resumed = new ChunkRegistry(
      new CompositeChunkContentCache(
        new MemoryChunkContentCache(),
        new DiskChunkContentCache(config.restore.diskCache),
      ),
    );
    resumed.restorePersistence(state);

    const listed = resumed.list({ pruned: true });
    assert.equal(listed.chunks[0].restoreMode, "disk_cache");
    assert.equal(listed.chunks[0].restoreAvailable, true);

    const [result] = await restoreChunks(resumed, [chunk.id], config);
    assert.equal(result.status, "restored");
    assert.equal(result.restoreMode, "disk_cache");
  });

  test("legacy diskCache boolean enables default durable-cache settings", () => {
    const config = mergeConfig({ restore: { diskCache: true } });
    assert.equal(config.restore.diskCache.enabled, true);
    assert.equal(config.restore.diskCache.maxBytes > 0, true);
  });

  test("restore reports specific unavailable reasons", async () => {
    const config = testConfig();
    const registry = new ChunkRegistry();
    const pathOnly = addChunk(registry, config, "path_only", "read", "source file\n".repeat(80), {
      path: "src/a.ts",
    });
    registry.prune([pathOnly.id], "manual");

    const resumed = new ChunkRegistry();
    resumed.restorePersistence(registry.persistenceState());
    const [result] = await restoreChunks(resumed, [pathOnly.id], config);

    assert.equal(result.status, "unavailable");
    assert.equal(result.reason, "no memory content, disk cache, or source line range metadata");
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
      "context_report",
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
    const firstContextResult = await pi.handlers.context?.(
      { messages },
      {
        hasUI: true,
        ui: pi.ui,
        getContextUsage: () => ({ tokens: 9_000, contextWindow: 10_000, percent: 90 }),
      },
    );
    assert.equal(firstContextResult, undefined);

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

  test("extension tags chunks with subagent scope metadata and filters lists", async () => {
    const pi = createMockPi(testConfig());
    extension(pi as never);

    await pi.handlers.tool_result?.({
      toolCallId: "child_tool",
      toolName: "code_search",
      content: textBlock("src/child.ts:1: hit\n".repeat(160)),
      metadata: {
        scope: "subagent",
        runId: "child-run",
        parentRunId: "parent-run",
        agentName: "researcher",
      },
    });

    const subagent = await pi.tools.list_context_chunks.execute("list", { scope: "subagent" });
    assert.equal(subagent.details.chunks.length, 1);
    assert.equal(subagent.details.chunks[0].scope.agentName, "researcher");
    assert.ok(subagent.content[0].text.includes("scope:subagent:researcher/child-run"));

    const main = await pi.tools.list_context_chunks.execute("list", { scope: "main" });
    assert.equal(main.details.chunks.length, 0);
  });

  test("context report tool and prune-report command expose telemetry without raw output", async () => {
    const pi = createMockPi(testConfig());
    extension(pi as never);

    await pi.handlers.tool_result?.({
      toolCallId: "report_tool",
      toolName: "code_search",
      content: textBlock("src/report.ts:1: hit\n".repeat(160)),
    });

    const reportTool = await pi.tools.context_report.execute("report", {}, undefined, undefined, {
      getContextUsage: () => ({ tokens: 1_000, contextWindow: 10_000, percent: 10 }),
    });
    assert.ok(reportTool.content[0].text.includes("# Prune Chunks Telemetry Report"));
    assert.ok(!reportTool.content[0].text.includes("src/report.ts:1: hit"));

    const cwd = await mkdtemp(path.join(tmpdir(), "pi-prune-report-"));
    await pi.commands["prune-report"].run("--output report.md", { cwd, ui: pi.ui });
    const report = await readFile(path.join(cwd, "report.md"), "utf8");
    assert.ok(report.includes("Collected chunks: 1"));
    assert.ok(!report.includes("src/report.ts:1: hit"));
  });

  test("high pressure prepares a continuation manifest and pins carry-forward chunks", async () => {
    const pi = createMockPi(testConfig());
    extension(pi as never);

    await pi.handlers.tool_result?.({
      toolCallId: "fail_tool",
      toolName: "bash",
      content: textBlock(
        "npm test\nFAIL test/thing.test.ts\nAssertionError: expected true\n".repeat(160),
      ),
      params: { command: "npm test" },
    });
    await pi.handlers.tool_result?.({
      toolCallId: "diff_tool",
      toolName: "bash",
      content: textBlock(
        "diff --git a/src/work.ts b/src/work.ts\n@@ -1 +1 @@\n-old\n+new\n".repeat(80),
      ),
    });
    await pi.handlers.tool_result?.({
      toolCallId: "old_fail_tool",
      toolName: "bash",
      content: textBlock(
        "npm test old\nFAIL test/old.test.ts\nAssertionError: old failure\n".repeat(160),
      ),
      params: { command: "npm test old" },
    });
    const list = await pi.tools.list_context_chunks.execute("list", { sortBy: "tokens" });
    const oldFailureId = list.details.chunks.find((chunk: { label: string }) =>
      chunk.label.includes("npm test old"),
    )?.id;
    assert.ok(oldFailureId);
    await pi.tools.prune_chunks.execute("prune", {
      ids: [oldFailureId],
      reason: "old evidence",
    });

    const pressure = await pi.tools.context_pressure.execute("pressure", {}, undefined, undefined, {
      modifiedFiles: ["src/work.ts"],
      getContextUsage: () => ({ tokens: 9_200, contextWindow: 10_000, percent: 92 }),
    });

    assert.ok(pressure.content[0].text.includes("Continuation manifest:"));
    assert.ok(pressure.content[0].text.includes("pinned for carry-forward:"));
    assert.ok(pressure.content[0].text.includes("task state:"));
    assert.ok(pressure.content[0].text.includes("active paths: src/work.ts"));
    assert.ok(pressure.content[0].text.includes("open failures:"));
    assert.ok(pressure.content[0].text.includes("restore hints:"));
    assert.ok(pressure.content[0].text.includes("unresolved failures/tests:"));
    assert.ok(pressure.content[0].text.includes("restorable pruned evidence:"));
    const manifest = pi.entries.at(-1)?.data.state.continuationManifest;
    assert.ok(manifest);
    assert.ok(manifest.taskState.openFailures.some((line: string) => line.includes("npm test")));
    assert.ok(
      manifest.taskState.restoreHints.some((line: string) => line.includes("restore_chunks")),
    );

    const pinned = await pi.tools.list_context_chunks.execute("list", { pinned: true, limit: 10 });
    assert.ok(
      pinned.details.chunks.some((chunk: { label: string }) => chunk.label.includes("npm test")),
    );
    assert.ok(pinned.details.chunks.some((chunk: { kind: string }) => chunk.kind === "diff"));
  });

  test("prune-status reports when no continuation manifest is prepared", async () => {
    const pi = createMockPi(testConfig());
    extension(pi as never);

    await pi.commands["prune-status"].run("", {
      ui: pi.ui,
      getContextUsage: () => ({ tokens: 1_000, contextWindow: 10_000, percent: 10 }),
    });

    assert.ok(pi.ui.notices.at(-1)?.includes("Continuation manifest: none prepared."));
  });

  test("prune-profile command switches live profile and persists state", async () => {
    const pi = createMockPi(testConfig());
    extension(pi as never);

    await pi.commands["prune-profile"].run("", { ui: pi.ui });
    assert.ok(pi.ui.notices.at(-1)?.includes("Active prune profile: coding-heavy"));

    await pi.commands["prune-profile"].run("local-32k", { ui: pi.ui });
    assert.ok(pi.ui.notices.at(-1)?.includes("switched to local-32k"));
    const pressure = await pi.tools.context_pressure.execute("pressure", {}, undefined, undefined, {
      getContextUsage: () => ({ tokens: 5_000, contextWindow: 10_000, percent: 50 }),
    });
    assert.ok(pressure.content[0].text.includes("profile=local-32k"));
    assert.equal(pi.entries.at(-1)?.data.state.activeProfile, "local-32k");

    await pi.commands["prune-profile"].run("unknown-profile", { ui: pi.ui });
    assert.ok(pi.ui.notices.at(-1)?.includes("Unknown prune profile"));

    await pi.commands["prune-profile"].run("reset", { ui: pi.ui });
    assert.ok(pi.ui.notices.at(-1)?.includes("reset to settings/default: coding-heavy"));
  });

  test("session_start restores a persisted live prune profile", async () => {
    const first = createMockPi(testConfig());
    extension(first as never);
    await first.commands["prune-profile"].run("cloud-200k", { ui: first.ui });

    const second = createMockPi(testConfig());
    extension(second as never);
    await second.handlers.session_start?.(
      {},
      { sessionManager: { getEntries: () => first.entries } },
    );
    const pressure = await second.tools.context_pressure.execute(
      "pressure",
      {},
      undefined,
      undefined,
      { getContextUsage: () => ({ tokens: 5_000, contextWindow: 10_000, percent: 50 }) },
    );
    assert.ok(pressure.content[0].text.includes("profile=cloud-200k"));
  });

  test("prune-restore command restores pruned chunks", async () => {
    const pi = createMockPi(testConfig());
    extension(pi as never);

    for (const name of [
      "prune-status",
      "prune-largest",
      "prune-suggest",
      "prune-profile",
      "prune-now",
      "prune-report",
      "prune-restore",
    ]) {
      assert.ok(pi.commands[name], `${name} was not registered`);
    }

    await pi.handlers.tool_result?.({
      toolCallId: "tool_restore",
      toolName: "code_search",
      content: textBlock("src/restore.ts:1: result\n".repeat(250)),
    });

    const list = await pi.tools.list_context_chunks.execute("list", { sortBy: "tokens" });
    const id = /pc_[0-9a-z]+_[0-9a-f]{6}/.exec(list.content[0].text)?.[0];
    assert.ok(id);

    await pi.tools.prune_chunks.execute("prune", { ids: [id], reason: "test command" });
    await pi.commands["prune-restore"].run(id, { ui: pi.ui });

    assert.ok(pi.ui.notices.at(-1)?.includes(`  ${id}: restored via memory`));
    assert.ok(pi.entries.length > 0, "restore command should persist metadata");
  });

  test("context hook uses compact tombstones when provider context is over pressure", async () => {
    const pi = createMockPi(testConfig());
    extension(pi as never);

    await pi.handlers.tool_result?.({
      toolCallId: "tool_a",
      toolName: "code_search",
      content: textBlock("src/a.ts:1: result\n".repeat(250)),
    });
    const list = await pi.tools.list_context_chunks.execute("list", { sortBy: "tokens" });
    const id = /pc_[0-9a-z]+_[0-9a-f]{6}/.exec(list.content[0].text)?.[0];
    assert.ok(id);
    await pi.tools.prune_chunks.execute("prune", { ids: [id], reason: "test compact" });

    const contextResult = await pi.handlers.context?.(
      {
        messages: [
          {
            role: "toolResult",
            toolCallId: "tool_a",
            content: textBlock("src/a.ts:1: result\n".repeat(250)),
          },
        ],
      },
      {
        getContextUsage: () => ({ tokens: 65_560, contextWindow: 49_152, percent: 133 }),
      },
    );

    const tombstone = contextResult?.messages[0].content[0].text ?? "";
    assert.match(tombstone, new RegExp(`^\\[pruned:${id} search ~\\d+t; restore_chunks\\]$`));
  });

  test("session_compact clears the stale continuation manifest", async () => {
    const pi = createMockPi(testConfig());
    extension(pi as never);
    await pi.handlers.tool_result?.({
      toolCallId: "manifest_tool",
      toolName: "code_search",
      content: textBlock("src/a.ts:1: hit\n".repeat(120)),
    });
    // High pressure prepares a continuation manifest and persists it.
    await pi.handlers.context?.(
      { messages: [{ role: "toolResult", toolCallId: "manifest_tool", content: textBlock("x") }] },
      { getContextUsage: () => ({ tokens: 9_500, contextWindow: 10_000, percent: 95 }) },
    );
    const before = pi.entries.at(-1)?.data?.state?.continuationManifest;
    assert.ok(before, "context event at imminent pressure should prepare a manifest");

    await pi.handlers.session_compact?.({});

    const after = pi.entries.at(-1)?.data?.state?.continuationManifest;
    assert.equal(after, undefined, "session_compact should clear the stale manifest");
  });

  test("context handler evicts main-scope chunks summarized out of the transcript", async () => {
    const pi = createMockPi(testConfig());
    extension(pi as never);
    await pi.handlers.tool_result?.({
      toolCallId: "survivor",
      toolName: "code_search",
      content: textBlock("src/survivor:1\n".repeat(120)),
    });
    await pi.handlers.tool_result?.({
      toolCallId: "summarized",
      toolName: "code_search",
      content: textBlock("src/summarized:1\n".repeat(120)),
    });
    const lowUsage = () => ({
      getContextUsage: () => ({ tokens: 1_000, contextWindow: 10_000, percent: 10 }),
    });

    // Both present -> both seen, nothing evicted (low pressure, no auto-prune).
    await pi.handlers.context?.(
      {
        messages: [
          { role: "toolResult", toolCallId: "survivor", content: textBlock("x") },
          { role: "toolResult", toolCallId: "summarized", content: textBlock("x") },
        ],
      },
      lowUsage(),
    );

    // Compaction drops "summarized" from the transcript; "survivor" remains.
    await pi.handlers.context?.(
      {
        messages: [{ role: "toolResult", toolCallId: "survivor", content: textBlock("x") }],
      },
      lowUsage(),
    );

    const list = await pi.tools.list_context_chunks.execute("list", {
      sortBy: "age",
      limit: 10,
    });
    const byCall = new Map(
      (
        list.details.chunks as Array<{
          source?: { toolCallId?: string };
          pruned: boolean;
        }>
      ).map((chunk) => [chunk.source?.toolCallId, chunk.pruned]),
    );
    assert.equal(byCall.get("summarized"), true);
    assert.equal(byCall.get("survivor"), false);
  });

  test("context hook coalesces extreme pruned tombstone overhead without mutating transcript messages", async () => {
    const pi = createMockPi(
      testConfig({
        autoPrune: {
          enabled: false,
          startAtPercent: 70,
          targetPercent: 55,
          preserveRecentChunks: 0,
          preserveRecentMinutes: 0,
          minChunkTokens: 1,
          maxChunksPerPass: 10,
          pruneSupersededOnIngest: true,
          pruneZeroMatchSearchesOnIngest: true,
        },
        tombstones: {
          includeSummary: true,
          includeRestoreHint: true,
          maxSummaryChars: 80,
          compactAtPercent: 90,
          coalesceAtPercent: 110,
          coalesceMinChunks: 16,
          maxCoalescedEntries: 120,
        },
      }),
    );
    extension(pi as never);

    const originalMessages: Array<{
      role: string;
      toolCallId: string;
      content: ContentBlock[];
    }> = [];
    for (let i = 0; i < 100; i++) {
      const toolCallId = `tool_${i}`;
      const text = `src/file-${i}.ts:1: result ${i}\n`.repeat(80);
      await pi.handlers.tool_result?.({
        toolCallId,
        toolName: "code_search",
        content: textBlock(text),
      });
      originalMessages.push({
        role: "toolResult",
        toolCallId,
        content: textBlock(text),
      });
    }

    const list = await pi.tools.list_context_chunks.execute("list", {
      sortBy: "age",
      limit: 100,
    });
    const chunks = list.details.chunks as Array<{ id: string; source?: { toolCallId?: string } }>;
    const idsToPrune = chunks.slice(0, 95).map((chunk) => chunk.id);
    assert.equal(idsToPrune.length, 95);
    await pi.tools.prune_chunks.execute("prune", {
      ids: idsToPrune,
      reason: "extreme tombstone-overhead regression",
    });

    const contextResult = await pi.handlers.context?.(
      { messages: originalMessages },
      {
        getContextUsage: () => ({ tokens: 65_560, contextWindow: 49_152, percent: 133 }),
      },
    );
    assert.ok(contextResult);

    const providerMessages = contextResult.messages as typeof originalMessages;
    // Coalescing collapses tombstone *content*, not message count: dropping a
    // toolResult orphans its preceding tool_use and the provider rejects the
    // turn. All 100 toolResults are preserved; only the overhead shrinks.
    assert.equal(
      providerMessages.length,
      originalMessages.length,
      `coalescing must preserve all ${originalMessages.length} toolResult messages`,
    );
    assert.equal(originalMessages.length, 100);
    assert.equal(originalMessages[0].content[0].text, `src/file-0.ts:1: result 0\n`.repeat(80));

    const providerText = providerMessages.map(messageText).join("\n");
    const originalText = originalMessages.map(messageText).join("\n");
    assert.ok(
      providerText.length < originalText.length / 4,
      `expected coalescing to cut overhead, provider ${providerText.length} vs original ${originalText.length}`,
    );
    assert.match(providerText, /coalesc|manifest|pruned/i);
    assert.ok(providerText.includes("restore_chunks"));
    assert.ok(providerText.includes(idsToPrune[0]));
    assert.ok(providerText.includes(idsToPrune[94]));

    for (const activeToolCallId of ["tool_95", "tool_99"]) {
      assert.ok(
        providerMessages.some(
          (message) =>
            message.toolCallId === activeToolCallId &&
            message.content[0].text?.includes(`src/file-${activeToolCallId.slice(5)}.ts`),
        ),
        `${activeToolCallId} should remain as an active tool result`,
      );
    }
  });

  test("context hook compacts oversized failed tool validation payloads", async () => {
    const pi = createMockPi(testConfig());
    extension(pi as never);

    const hugeOldText = "func noisy() {\n\treturn\n}\n".repeat(900);
    const validationText =
      'Validation failed for tool "edit":\n' +
      "  - edits.0.newText: must have required properties newText\n\n" +
      "Received arguments:\n" +
      JSON.stringify({
        path: "/Users/cawalch/go-yara/compiler/interpreter_strings.go",
        edits: [{ oldText: hugeOldText }],
      }) +
      "\n\nError: 400 request (66019 tokens) exceeds the available context size (65536 tokens)";
    const originalMessages = [
      {
        role: "toolResult",
        toolCallId: "bad_edit",
        content: textBlock(validationText),
      },
      {
        role: "user",
        toolCallId: "none",
        content: textBlock("continue fixing the edit"),
      },
    ];

    const contextResult = await pi.handlers.context?.(
      { messages: originalMessages },
      {
        getContextUsage: () => ({ tokens: 66_019, contextWindow: 65_536, percent: 101 }),
      },
    );
    assert.ok(contextResult);

    const providerMessages = contextResult.messages as typeof originalMessages;
    const compacted = providerMessages[0].content[0].text ?? "";
    assert.match(compacted, /^\[compacted-tool-validation-error:/);
    assert.ok(compacted.includes('tool="edit"'));
    assert.ok(compacted.includes("edits.0.newText"));
    assert.ok(compacted.includes("Received arguments omitted"));
    assert.ok(compacted.includes("66019 tokens"));
    assert.ok(!compacted.includes("func noisy"));
    assert.ok(compacted.length < 500);
    assert.equal(originalMessages[0].content[0].text, validationText);
    assert.equal(providerMessages[1].content[0].text, "continue fixing the edit");
  });

  test("context hook compacts oversized tool input echoes", async () => {
    const pi = createMockPi(testConfig());
    extension(pi as never);

    const hugePayload = "const noisy = true;\n".repeat(900);
    const toolInputText =
      'Tool call arguments for "write":\n' +
      JSON.stringify({ path: "src/generated.ts", content: hugePayload });
    const originalMessages = [
      {
        role: "assistant",
        content: textBlock(toolInputText),
      },
    ];

    const contextResult = await pi.handlers.context?.(
      { messages: originalMessages },
      {
        getContextUsage: () => ({ tokens: 66_019, contextWindow: 65_536, percent: 101 }),
      },
    );
    assert.ok(contextResult);

    const providerMessages = contextResult.messages as typeof originalMessages;
    const compacted = providerMessages[0].content[0].text ?? "";
    assert.match(compacted, /^\[compacted-tool-input:/);
    assert.ok(compacted.includes('tool="write"'));
    assert.ok(compacted.includes("src/generated.ts"));
    assert.ok(compacted.includes("arguments omitted"));
    assert.ok(compacted.includes("restore from saved transcript"));
    assert.ok(!compacted.includes("const noisy"));
    assert.ok(compacted.length < 300);
    assert.equal(originalMessages[0].content[0].text, toolInputText);
  });

  test("tool_result hook persists immediate pruning of superseded chunks", async () => {
    const pi = createMockPi(testConfig());
    extension(pi as never);

    await pi.handlers.tool_result?.({
      toolCallId: "first_read",
      toolName: "read",
      params: { path: "compiler/interpreter.go", startLine: 10, endLine: 90 },
      content: textBlock("compiler/interpreter.go:10: first read\n".repeat(140)),
    });
    await pi.handlers.tool_result?.({
      toolCallId: "second_read",
      toolName: "read",
      params: { path: "compiler/interpreter.go", startLine: 50, endLine: 130 },
      content: textBlock("compiler/interpreter.go:50: overlapping read\n".repeat(140)),
    });

    const active = await pi.tools.list_context_chunks.execute("active", {
      pruned: false,
      sortBy: "age",
      limit: 10,
    });
    const pruned = await pi.tools.list_context_chunks.execute("pruned", {
      pruned: true,
      sortBy: "age",
      limit: 10,
    });

    assert.equal(active.details.chunks.length, 1);
    assert.equal(active.details.chunks[0].source.toolCallId, "second_read");
    assert.equal(pruned.details.chunks.length, 1);
    assert.equal(pruned.details.chunks[0].source.toolCallId, "first_read");
    assert.match(pruned.details.chunks[0].pruneReason, /overlapping file read/);
    assert.ok(pi.entries.length > 0, "immediate stale pruning should persist metadata");
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
      commands[name] = {
        ...definition,
        run: definition.run ?? definition.handler,
      };
    },
    appendEntry(customType: string, data?: any) {
      entries.push({ type: "custom", customType, data });
    },
  };
}

function messageText(message: { content?: ContentBlock[] }): string {
  return (message.content ?? []).map((block) => block.text ?? "").join("\n");
}
