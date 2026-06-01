import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { describe } from "node:test";
import extension, { preserveContext } from "../index";
import { classifyKind, classifyRisk, collectToolResult } from "../src/collector";
import { mergeConfig } from "../src/config";
import {
  autoPrune,
  pressureSummary,
  pruneSupersededAfterCollect,
  suggestPruneCandidates,
} from "../src/pruner";
import { ChunkRegistry } from "../src/registry";
import { renderChunkList, renderPressure } from "../src/render";
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
      pruneSupersededOnIngest: true,
      pruneZeroMatchSearchesOnIngest: true,
    },
    tombstones: {
      includeSummary: true,
      includeRestoreHint: true,
      maxSummaryChars: 80,
      compactAtPercent: 90,
      coalesceAtPercent: 110,
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
  return registry.addCollected(collected, createdAt);
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
      "no memory content or source path metadata",
    );
    assert.ok(rendered.includes("unavailable: no memory content or source path metadata"));
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
    const disposable = addChunk(
      registry,
      config,
      "search",
      "code_search",
      "src/old.ts:1: result\n".repeat(200),
    );

    const preserve = preserveContext(
      [
        { role: "user", content: textBlock("Please keep src/focus.ts in view") },
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
    assert.equal(registry.get(disposable.id)?.pruned, true);
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
    assert.equal(result.reason, "no memory content or source line range metadata");
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

  test("prune-restore command restores pruned chunks", async () => {
    const pi = createMockPi(testConfig());
    extension(pi as never);

    for (const name of [
      "prune-status",
      "prune-largest",
      "prune-suggest",
      "prune-now",
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
    assert.ok(
      providerMessages.length < originalMessages.length / 4,
      `expected coalescing to reduce ${originalMessages.length} messages, got ${providerMessages.length}`,
    );
    assert.equal(originalMessages.length, 100);
    assert.equal(originalMessages[0].content[0].text, `src/file-0.ts:1: result 0\n`.repeat(80));

    const providerText = providerMessages.map(messageText).join("\n");
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
      commands[name] = definition;
    },
    appendEntry(customType: string, data?: any) {
      entries.push({ type: "custom", customType, data });
    },
  };
}

function messageText(message: { content?: ContentBlock[] }): string {
  return (message.content ?? []).map((block) => block.text ?? "").join("\n");
}
