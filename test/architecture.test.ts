import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { describe } from "node:test";
import extension, { preserveContext } from "../index";
import { collectToolResult } from "../src/collector";
import { mergeConfig } from "../src/config";
import { compactFailedToolValidationMessages } from "../src/contextGuards";
import { DiskChunkContentCache } from "../src/diskCache";
import {
  pressureRetirementPlan,
  shouldRunPressureSweep,
  shouldRunWorkingSetSweep,
  workingSetRetirementPlan,
} from "../src/pruner";
import { ChunkRegistry } from "../src/registry";
import { restoreChunks } from "../src/restorer";
import { rewriteRetiredExchanges } from "../src/tombstones";
import type { ContentBlock, ContextChunk, ContextUsage, PruneChunksConfig } from "../src/types";

function textBlock(text: string): ContentBlock[] {
  return [{ type: "text", text }];
}

function config(overrides: Parameters<typeof mergeConfig>[0] = {}): PruneChunksConfig {
  return mergeConfig({
    track: { minChunkTokens: 1 },
    restore: { diskCache: false },
    ...overrides,
  });
}

function addChunk(
  registry: ChunkRegistry,
  cfg: PruneChunksConfig,
  toolCallId: string,
  toolName: string,
  text: string,
  params?: Record<string, unknown>,
  createdAt = Date.now() - 10 * 60_000,
): ContextChunk {
  const collected = collectToolResult({
    toolCallId,
    toolName,
    content: textBlock(text),
    params,
    config: cfg,
  });
  assert.ok(collected);
  const chunk = registry.addCollected(collected, createdAt);
  registry.markSeenByToolCallId(toolCallId, createdAt + 1);
  return chunk;
}

function usage(tokens: number, contextWindow: number): ContextUsage {
  return { tokens, contextWindow, percent: (tokens / contextWindow) * 100 };
}

function assistant(
  calls: Array<{ id: string; name?: string; arguments?: Record<string, unknown> }>,
  text?: string,
) {
  return {
    role: "assistant",
    content: [
      ...(text ? [{ type: "text", text }] : []),
      ...calls.map((call) => ({
        type: "toolCall",
        id: call.id,
        name: call.name ?? "rg",
        arguments: call.arguments ?? {},
      })),
    ],
  };
}

function result(id: string, text = "result") {
  return { role: "toolResult", toolCallId: id, toolName: "rg", content: textBlock(text) };
}

describe("v0.4 configuration", () => {
  test("defaults to proactive working-set control plus an emergency pressure rail", () => {
    const cfg = config();
    assert.deepEqual(cfg.workingSet, {
      triggerTokens: 32_768,
      targetTokens: 16_384,
      retryAfterGrowthTokens: 8_192,
    });
    assert.deepEqual(cfg.pressure, {
      triggerPercent: 90,
      targetPercent: 80,
      retryAfterGrowthTokens: 8_192,
    });
    assert.deepEqual(cfg.retention, {
      preserveRecentResults: 6,
      preserveRecentMinutes: 3,
    });
  });

  test("triggers rot control by absolute tool-output size, independent of model window", () => {
    const cfg = config();
    assert.equal(shouldRunWorkingSetSweep(32_767, cfg), false);
    assert.equal(shouldRunWorkingSetSweep(32_768, cfg), true);
    assert.equal(shouldRunWorkingSetSweep(40_959, cfg, { activeTokens: 32_768 }), false);
    assert.equal(shouldRunWorkingSetSweep(40_960, cfg, { activeTokens: 32_768 }), true);
    for (const contextWindow of [64_000, 200_000, 1_000_000]) {
      assert.equal(shouldRunPressureSweep(usage(contextWindow * 0.5, contextWindow), cfg), false);
      assert.equal(shouldRunWorkingSetSweep(32_768, cfg), true);
    }
  });

  test("requires crossing the percentage trigger", () => {
    const cfg = config();
    for (const window of [32_000, 64_000, 200_000, 1_000_000]) {
      assert.equal(shouldRunPressureSweep(usage(window * 0.9 - 1, window), cfg), false);
      assert.equal(shouldRunPressureSweep(usage(window * 0.9, window), cfg), true);
    }
  });

  test("rejects v0.1 and v0.2 policy settings with a migration error", () => {
    for (const key of [
      "profile",
      "autoPrune",
      "decisionCards",
      "tombstones",
      "reamerx",
      "budget",
      "emergency",
      "redundancy",
    ]) {
      assert.throws(
        () => mergeConfig({ [key]: {} }),
        /v0\.4 no longer supports.*configure workingSet.*pressure.*restore/,
      );
    }
  });

  test("validates pressure percentages", () => {
    assert.throws(
      () => mergeConfig({ pressure: { triggerPercent: 80, targetPercent: 80 } }),
      /0 < targetPercent < triggerPercent <= 100/,
    );
  });

  test("validates working-set hysteresis", () => {
    assert.throws(
      () => mergeConfig({ workingSet: { triggerTokens: 16_384, targetTokens: 16_384 } }),
      /0 < targetTokens < triggerTokens/,
    );
  });
});

describe("working-set and pressure retirement policy", () => {
  test("plans toward an absolute active-tool target before provider pressure", () => {
    const cfg = config({
      workingSet: { triggerTokens: 200, targetTokens: 100, retryAfterGrowthTokens: 50 },
      retention: { preserveRecentResults: 0, preserveRecentMinutes: 0 },
    });
    const registry = new ChunkRegistry();
    addChunk(registry, cfg, "rot-a", "rg", "src/a.ts:1: stale hit\n".repeat(80));
    addChunk(registry, cfg, "rot-b", "rg", "src/b.ts:1: stale hit\n".repeat(80));
    const plan = workingSetRetirementPlan(registry, cfg);
    assert.equal(plan.cause, "working_set");
    assert.ok(plan.targetSavings > 0);
    assert.ok(plan.estimatedSavings >= plan.targetSavings);
  });

  test("ranks proven supersession before generic age within a batched sweep", () => {
    const cfg = config({
      workingSet: { triggerTokens: 2, targetTokens: 1, retryAfterGrowthTokens: 1 },
      retention: { preserveRecentResults: 0, preserveRecentMinutes: 0 },
    });
    const registry = new ChunkRegistry();
    addChunk(
      registry,
      cfg,
      "unique-oldest",
      "rg",
      "src/unique.ts:1: unique historical hit\n".repeat(40),
      undefined,
      Date.now() - 30 * 60_000,
    );
    addChunk(
      registry,
      cfg,
      "duplicate-old",
      "rg",
      "src/shared.ts:1: repeated hit\n".repeat(40),
      undefined,
      Date.now() - 20 * 60_000,
    );
    addChunk(
      registry,
      cfg,
      "duplicate-new",
      "rg",
      "src/shared.ts:1: repeated hit\n".repeat(40),
      undefined,
      Date.now() - 10 * 60_000,
    );

    const plan = workingSetRetirementPlan(registry, cfg);
    assert.equal(plan.candidates[0]?.reason, "exact duplicate superseded by newer output");
  });

  test("unique low-risk output must be shown once before pressure retirement", () => {
    const cfg = config({
      pressure: {
        triggerPercent: 90,
        targetPercent: 80,
        retryAfterGrowthTokens: 100,
        preserveRecentResults: 0,
        preserveRecentMinutes: 0,
      },
    });
    const registry = new ChunkRegistry();
    const text = "src/a.ts:1: result\n".repeat(80);
    const collected = collectToolResult({
      toolCallId: "new",
      toolName: "rg",
      content: textBlock(text),
      config: cfg,
    });
    assert.ok(collected);
    registry.addCollected(collected, Date.now() - 60_000);
    assert.equal(pressureRetirementPlan(registry, usage(900, 1_000), cfg).candidates.length, 0);
    registry.markSeenByToolCallId("new");
    assert.ok(pressureRetirementPlan(registry, usage(900, 1_000), cfg).candidates.length > 0);
  });

  test("preserves newest results, young results, failures, diffs, anchors, and active paths", () => {
    const cfg = config({
      pressure: {
        triggerPercent: 90,
        targetPercent: 80,
        retryAfterGrowthTokens: 100,
        preserveRecentResults: 2,
        preserveRecentMinutes: 3,
      },
    });
    const registry = new ChunkRegistry();
    const oldSafe = addChunk(
      registry,
      cfg,
      "safe",
      "rg",
      "src/safe.ts:1: safe hit",
      undefined,
      Date.now() - 20 * 60_000,
    );
    const pathChunk = addChunk(registry, cfg, "path", "read", "bounded active path", {
      path: "src/active.ts",
      startLine: 1,
      endLine: 20,
    });
    const anchorChunk = addChunk(registry, cfg, "anchor", "rg", "FAIL issue #918 anchor");
    const lateAnchor = addChunk(
      registry,
      cfg,
      "late-anchor",
      "rg",
      `${"src/ordinary.ts:1: ordinary hit\n".repeat(20)}issue #919`,
    );
    const diff = addChunk(
      registry,
      cfg,
      "diff",
      "git_diff",
      "diff --git a/src/a.ts b/src/a.ts\n-a\n+b",
    );
    const failure = addChunk(
      registry,
      cfg,
      "failure",
      "bash",
      "npm test\nFAIL test/a.test.ts\nAssertionError: nope",
    );
    const young = addChunk(
      registry,
      cfg,
      "young",
      "rg",
      "src/young.ts:1: young hit",
      undefined,
      Date.now() - 30_000,
    );
    const newest = addChunk(registry, cfg, "newest", "rg", "src/newest.ts:1: newest hit");
    const plan = pressureRetirementPlan(registry, usage(900, 1_000), cfg, {
      preserve: {
        paths: new Set(["src/active.ts"]),
        anchors: new Set(["#918"]),
      },
    });
    const ids = new Set(plan.candidates.map((item) => item.id));
    assert.equal(ids.has(oldSafe.id), true);
    for (const protectedChunk of [pathChunk, anchorChunk, diff, failure, young, newest]) {
      assert.equal(ids.has(protectedChunk.id), false, protectedChunk.label);
    }
    const lateAnchorPlan = pressureRetirementPlan(registry, usage(900, 1_000), cfg, {
      preserve: { anchors: new Set(["#919"]) },
    });
    assert.equal(
      lateAnchorPlan.candidates.some((candidate) => candidate.id === lateAnchor.id),
      false,
    );
  });

  test("restored output receives the same time-based grace", async () => {
    const cfg = config({
      pressure: {
        triggerPercent: 90,
        targetPercent: 80,
        retryAfterGrowthTokens: 100,
        preserveRecentResults: 0,
        preserveRecentMinutes: 3,
      },
    });
    const registry = new ChunkRegistry();
    const chunk = addChunk(registry, cfg, "restore", "rg", "src/a.ts:1: hit");
    registry.prune([chunk.id]);
    const restored = await restoreChunks(registry, [chunk.id], cfg);
    assert.equal(restored[0].status, "restored");
    assert.equal(pressureRetirementPlan(registry, usage(900, 1_000), cfg).candidates.length, 0);
  });

  test("partially trims an old oversized result with a neutral marker", () => {
    const cfg = config({
      pressure: {
        triggerPercent: 90,
        targetPercent: 80,
        retryAfterGrowthTokens: 100,
        preserveRecentResults: 0,
        preserveRecentMinutes: 0,
      },
    });
    const registry = new ChunkRegistry();
    const largeText = Array.from(
      { length: 1_500 },
      (_, index) => `src/a.ts:${index + 1}: hit ${"x".repeat(12)}`,
    ).join("\n");
    const parent = addChunk(registry, cfg, "large", "rg", largeText);
    const plan = pressureRetirementPlan(registry, usage(900, 1_000), cfg);
    assert.equal(plan.candidates.length, 1);
    assert.equal(plan.candidates[0].id, `${parent.id}#bulk`);
    registry.prune(
      plan.candidates.map((item) => item.id),
      "pressure",
      "auto_pruned",
    );
    const rewritten = rewriteRetiredExchanges(
      [assistant([{ id: "large" }]), result("large", largeText)],
      registry,
    );
    assert.equal(rewritten.messages.length, 2);
    assert.match(textFrom(rewritten.messages[1].content), /older bulk output retired/);
    assert.equal(registry.get(parent.id)?.pruned, false);
  });

  test("retries only after configured context growth, not registry changes", () => {
    const cfg = config({
      pressure: {
        triggerPercent: 90,
        targetPercent: 80,
        retryAfterGrowthTokens: 2_048,
        preserveRecentResults: 0,
        preserveRecentMinutes: 0,
      },
    });
    const registry = new ChunkRegistry();
    addChunk(registry, cfg, "old", "rg", "src/a.ts:1: hit\n".repeat(400));
    const high = usage(92_000, 100_000);
    assert.equal(shouldRunPressureSweep(high, cfg), true);
    assert.ok(pressureRetirementPlan(registry, high, cfg).candidates.length > 0);
    const previous = { usageTokens: high.tokens ?? 0 };
    assert.equal(shouldRunPressureSweep(usage(93_000, 100_000), cfg, previous), false);
    assert.equal(shouldRunPressureSweep(usage(94_048, 100_000), cfg, previous), true);
    addChunk(registry, cfg, "new", "rg", "src/new.ts:1: hit");
    assert.equal(shouldRunPressureSweep(high, cfg, previous), false);
  });
});

describe("provider-copy rewriting", () => {
  function retiredRegistry(id = "a") {
    const cfg = config();
    const registry = new ChunkRegistry();
    const chunk = addChunk(registry, cfg, id, "rg", `src/${id}.ts:1: hit`);
    registry.prune([chunk.id]);
    return registry;
  }

  test("removes sequential call/result pairs and avoids empty messages", () => {
    const registry = retiredRegistry();
    const activeRegistryChunk = addChunk(registry, config(), "b", "rg", "src/b.ts:1: hit");
    assert.ok(activeRegistryChunk);
    const input = [assistant([{ id: "a" }]), result("a"), assistant([{ id: "b" }]), result("b")];
    const rewritten = rewriteRetiredExchanges(input, registry);
    assert.deepEqual(rewritten.messages, [assistant([{ id: "b" }]), result("b")]);
    assert.equal(rewritten.removedExchanges, 1);
  });

  test("preserves sibling calls and assistant text for parallel calls", () => {
    const registry = retiredRegistry();
    addChunk(registry, config(), "b", "rg", "src/b.ts:1: hit");
    const input = [
      assistant([{ id: "a" }, { id: "b" }], "I will inspect both."),
      result("a"),
      result("b"),
    ];
    const rewritten = rewriteRetiredExchanges(input, registry);
    assert.equal(rewritten.messages.length, 2);
    assert.deepEqual(
      rewritten.messages[0].content?.map((block) => block.type),
      ["text", "toolCall"],
    );
    assert.equal((rewritten.messages[1] as ReturnType<typeof result>).toolCallId, "b");
    assert.equal(textFrom(input[0].content).trim(), "I will inspect both.");
  });

  test("drops an unpaired retired half instead of creating an orphan", () => {
    const registry = retiredRegistry();
    assert.deepEqual(rewriteRetiredExchanges([result("a")], registry).messages, []);
    assert.deepEqual(rewriteRetiredExchanges([assistant([{ id: "a" }])], registry).messages, []);
  });

  test("collapses malformed duplicates to one valid neutral pair", () => {
    const registry = retiredRegistry();
    const rewritten = rewriteRetiredExchanges(
      [assistant([{ id: "a" }, { id: "a" }]), result("a"), result("a")],
      registry,
    );
    assert.equal(rewritten.messages.length, 2);
    assert.equal(rewritten.messages[0].content?.length, 1);
    assert.match(textFrom(rewritten.messages[1].content), /historical tool output retired/);
    assert.equal(rewritten.fallbackMarkers, 1);
  });

  test("never mutates the authoritative message objects", () => {
    const registry = retiredRegistry();
    const input = [assistant([{ id: "a" }], "kept text"), result("a", "exact saved output")];
    const snapshot = structuredClone(input);
    rewriteRetiredExchanges(input, registry);
    assert.deepEqual(input, snapshot);
  });
});

describe("archive and state behavior", () => {
  test("disk storage is archive-only and cleanup is scheduled, not per write", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-prune-v2-cache-"));
    try {
      const cache = new DiskChunkContentCache({
        enabled: true,
        directory,
        maxBytes: 100 * 1024 * 1024,
        maxAgeDays: 14,
        maxBlobBytes: 1024 * 1024,
      });
      const initial = cache.instrumentation();
      cache.set("active", textBlock("must stay in memory only"));
      assert.equal(cache.has("active", "disk_cache"), false);
      for (let index = 0; index < 100; index++) {
        await cache.archive(`retired-${index}`, textBlock(`exact-${index}-${"x".repeat(256)}`));
      }
      const metrics = cache.instrumentation();
      assert.equal(metrics.archives, 100);
      assert.equal(metrics.cleanups, initial.cleanups + 1);
      assert.equal(metrics.directoryScans, initial.directoryScans + 1);
      assert.equal(textFrom(cache.get("retired-42", "disk_cache")), `exact-42-${"x".repeat(256)}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("post-compaction reconciliation identifies only absent main-context results", () => {
    const cfg = config();
    const registry = new ChunkRegistry();
    addChunk(registry, cfg, "survivor", "rg", "src/a.ts:1: hit");
    const absent = addChunk(registry, cfg, "absent", "rg", "src/b.ts:1: hit");
    assert.deepEqual(registry.absentFromContext(new Set(["survivor"])), [absent.id]);
    assert.deepEqual(registry.absentFromContext(new Set()), []);
    assert.deepEqual(
      new Set(registry.absentFromContext(new Set(), true)),
      new Set(registry.active().map((chunk) => chunk.id)),
    );
  });
});

describe("extension integration", () => {
  test("registers human commands but zero model-facing management tools", () => {
    const app = createHarness();
    assert.deepEqual(app.tools, []);
    assert.deepEqual([...app.commands.keys()].sort(), [
      "prune-largest",
      "prune-now",
      "prune-report",
      "prune-restore",
      "prune-status",
      "prune-suggest",
    ]);
    assert.equal(app.commands.has("prune-profile"), false);
    assert.equal(app.handlers.session_before_compact, undefined);
  });

  test("enabled=false makes the provider hook completely inert", async () => {
    const app = createHarness({ enabled: false });
    const transformed = await app.handlers.context?.(
      { messages: [assistant([{ id: "off" }]), result("off", "x".repeat(2_000))] },
      app.context(31_000, 32_000),
    );
    assert.equal(transformed, undefined);
    assert.equal(app.statuses.length, 0);
    assert.equal(app.entries.length, 0);
  });

  test("1,000 unchanged hooks at 89% leave an old-budget-sized result byte-identical", async () => {
    const app = createHarness();
    const output = "src/a.ts:1: stable unique hit\n".repeat(1_600);
    await app.handlers.tool_result?.(
      {
        toolCallId: "stable",
        toolName: "rg",
        content: textBlock(output),
      },
      {},
    );
    const messages = [assistant([{ id: "stable" }]), result("stable", output)];
    const snapshot = structuredClone(messages);
    const ctx = app.context(28_480, 32_000);
    for (let index = 0; index < 1_000; index++) {
      const transformed = await app.handlers.context?.({ messages }, ctx);
      assert.equal(transformed, undefined);
    }
    assert.deepEqual(messages, snapshot);
    assert.equal(app.entries.length, 0);
    assert.equal(app.notifications.length, 0);
    assert.equal(app.compactCalls, 0);
  });

  test("working-set cleanup activates well below provider pressure after one visible pass", async () => {
    const app = createHarness({
      workingSet: {
        triggerTokens: 200,
        targetTokens: 100,
        retryAfterGrowthTokens: 100,
      },
      retention: { preserveRecentResults: 0, preserveRecentMinutes: 0 },
    });
    const output = "src/stale.ts:1: old search hit\n".repeat(120);
    await app.handlers.tool_result?.(
      { toolCallId: "stale-working-set", toolName: "rg", content: textBlock(output) },
      {},
    );
    const messages = [
      assistant([{ id: "stale-working-set" }]),
      result("stale-working-set", output),
    ];
    const ctx = app.context(2_000, 100_000);
    assert.equal(await app.handlers.context?.({ messages }, ctx), undefined);
    const transformed = await app.handlers.context?.({ messages }, ctx);
    assert.deepEqual(transformed?.messages, []);
    assert.equal(app.entries.length, 1);
    assert.equal(app.entries[0].data.actions[0].reason, "long-horizon working-set sweep");
    assert.equal(app.compactCalls, 0);
  });

  test("pressure cleanup waits one provider pass, then removes the full pair", async () => {
    const app = createHarness({
      pressure: {
        triggerPercent: 90,
        targetPercent: 80,
        retryAfterGrowthTokens: 100,
        preserveRecentResults: 0,
        preserveRecentMinutes: 0,
      },
    });
    const output = "src/a.ts:1: hit\n".repeat(100);
    await app.handlers.tool_result?.(
      { toolCallId: "large", toolName: "rg", content: textBlock(output) },
      {},
    );
    const messages = [assistant([{ id: "large" }]), result("large", output)];
    const ctx = app.context(900, 1_000);
    assert.equal(await app.handlers.context?.({ messages }, ctx), undefined);
    const transformed = await app.handlers.context?.({ messages }, ctx);
    assert.deepEqual(transformed?.messages, []);
    assert.equal(app.entries.length, 1);
    assert.equal(app.notifications.length, 0);
  });

  test("zero-result and duplicate searches remain visible below pressure", async () => {
    const app = createHarness();
    for (const id of ["zero", "duplicate"]) {
      await app.handlers.tool_result?.(
        { toolCallId: id, toolName: "rg", content: textBlock("No matches found") },
        {},
      );
    }
    const messages = [
      assistant([{ id: "zero" }]),
      result("zero", "No matches found"),
      assistant([{ id: "duplicate" }]),
      result("duplicate", "No matches found"),
    ];
    const transformed = await app.handlers.context?.({ messages }, app.context(1_000, 32_000));
    assert.equal(transformed, undefined);
    assert.deepEqual(messages[1], result("zero", "No matches found"));
    assert.equal(app.tools.length, 0);
    assert.equal(app.entries.length, 0);
  });

  test("uses provider-message size as a conservative pressure floor", async () => {
    const app = createHarness({
      pressure: {
        triggerPercent: 90,
        targetPercent: 80,
        retryAfterGrowthTokens: 100,
        preserveRecentResults: 0,
        preserveRecentMinutes: 0,
      },
    });
    const output = "src/estimated.ts:1: hit\n".repeat(500);
    await app.handlers.tool_result?.(
      { toolCallId: "estimated", toolName: "rg", content: textBlock(output) },
      {},
    );
    const messages = [assistant([{ id: "estimated" }]), result("estimated", output)];
    const staleUsage = app.context(100, 1_000);
    assert.equal(await app.handlers.context?.({ messages }, staleUsage), undefined);
    const transformed = await app.handlers.context?.({ messages }, staleUsage);
    assert.ok(transformed);
    assert.match(textFrom(transformed.messages[1].content), /older bulk output retired/);
    assert.equal(app.entries.length, 1);
  });

  test("rebuilds metadata from transcript and replays compact deltas on resume", async () => {
    const first = createHarness();
    await first.handlers.tool_result?.(
      { toolCallId: "resume", toolName: "rg", content: textBlock("src/a.ts:1: hit") },
      {},
    );
    await first.handlers.context?.(
      { messages: [assistant([{ id: "resume" }]), result("resume", "src/a.ts:1: hit")] },
      first.context(1_000, 32_000),
    );
    await first.commands
      .get("prune-now")
      ?.handler("pc_deadbeefdead --dry-run", first.context(1_000, 32_000));

    const listingCtx = first.context(1_000, 32_000);
    await first.commands.get("prune-largest")?.handler("", listingCtx);
    const id = /pc_[0-9a-f]{12}/.exec(first.notifications.at(-1) ?? "")?.[0];
    assert.ok(id);
    await first.commands.get("prune-now")?.handler(id, first.context(1_000, 32_000));
    assert.equal(first.entries.length, 1);

    const transcript = [
      {
        type: "message",
        timestamp: new Date(Date.now() - 1_000).toISOString(),
        message: assistant([{ id: "resume", name: "rg" }]),
      },
      {
        type: "message",
        timestamp: new Date().toISOString(),
        message: result("resume", "src/a.ts:1: hit"),
      },
      ...first.entries,
    ];
    const resumed = createHarness();
    await resumed.handlers.session_start?.(
      {},
      { sessionManager: { getEntries: () => transcript } },
    );
    const transformed = await resumed.handlers.context?.(
      { messages: [assistant([{ id: "resume" }]), result("resume", "src/a.ts:1: hit")] },
      resumed.context(1_000, 32_000),
    );
    assert.deepEqual(transformed?.messages, []);
  });

  test("replays Pi compaction boundaries before later state deltas on resume", async () => {
    const transcript = [
      {
        type: "message",
        id: "call-entry",
        timestamp: new Date(Date.now() - 2_000).toISOString(),
        message: assistant([{ id: "precompact", name: "rg" }]),
      },
      {
        type: "message",
        id: "result-entry",
        timestamp: new Date(Date.now() - 1_000).toISOString(),
        message: result("precompact", "src/old.ts:1: old hit"),
      },
      {
        type: "message",
        id: "kept-entry",
        timestamp: new Date().toISOString(),
        message: { role: "user", content: textBlock("continue") },
      },
      {
        type: "compaction",
        id: "compaction-entry",
        firstKeptEntryId: "kept-entry",
      },
    ];
    const resumed = createHarness();
    await resumed.handlers.session_start?.(
      {},
      { sessionManager: { getEntries: () => transcript } },
    );
    await resumed.commands.get("prune-largest")?.handler("", resumed.context(1_000, 32_000));
    assert.equal(resumed.notifications.at(-1), "No tracked chunks found.");
    assert.equal(resumed.entries.length, 0);
  });

  test("ignores v0.2 retirement deltas so an upgrade restores the raw transcript", async () => {
    const messagesOnly = [
      {
        type: "message",
        timestamp: new Date(Date.now() - 1_000).toISOString(),
        message: assistant([{ id: "old-state", name: "rg" }]),
      },
      {
        type: "message",
        timestamp: new Date().toISOString(),
        message: result("old-state", "src/a.ts:1: visible again"),
      },
    ];
    const probe = createHarness();
    await probe.handlers.session_start?.(
      {},
      { sessionManager: { getEntries: () => messagesOnly } },
    );
    await probe.commands.get("prune-largest")?.handler("", probe.context(1_000, 32_000));
    const actualId = /pc_[0-9a-f]{12}/.exec(probe.notifications.at(-1) ?? "")?.[0];
    assert.ok(actualId);
    const transcript = [
      ...messagesOnly,
      {
        type: "custom",
        customType: "prune-chunks-state-v2",
        data: {
          version: 2,
          actions: [{ id: actualId, state: "pruned", timestamp: Date.now() }],
        },
      },
    ];
    const resumed = createHarness();
    await resumed.handlers.session_start?.(
      {},
      { sessionManager: { getEntries: () => transcript } },
    );
    const messages = [
      assistant([{ id: "old-state" }]),
      result("old-state", "src/a.ts:1: visible again"),
    ];
    assert.equal(
      await resumed.handlers.context?.({ messages }, resumed.context(1_000, 32_000)),
      undefined,
    );
  });

  test("observes Pi compaction but never invokes it", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-prune-v3-report-"));
    try {
      const app = createHarness();
      await app.handlers.session_compact?.({}, app.context(1_000, 32_000));
      await app.commands
        .get("prune-report")
        ?.handler("--output hygiene.md", { ...app.context(1_000, 32_000), cwd: directory });
      const report = await readFile(path.join(directory, "hygiene.md"), "utf8");
      assert.match(report, /Pi compactions observed: 1/);
      assert.equal(app.compactCalls, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reports actual provider tokens, cache usage, cost, and rewritten responses", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-prune-v3-provider-report-"));
    try {
      const app = createHarness();
      await app.handlers.context?.({ messages: [] }, app.context(1_000, 32_000));
      await app.handlers.message_end?.(
        {
          message: {
            role: "assistant",
            usage: {
              input: 120,
              output: 30,
              cacheRead: 880,
              cacheWrite: 10,
              cost: { total: 0.012345 },
            },
          },
        },
        {},
      );
      const validation = `Validation failed for tool "edit"\n- required: path\nReceived arguments:\n${"x".repeat(2_000)}`;
      await app.handlers.context?.(
        { messages: [{ role: "toolResult", content: textBlock(validation) }] },
        app.context(2_000, 32_000),
      );
      await app.handlers.message_end?.(
        {
          message: {
            role: "assistant",
            usage: {
              input: 900,
              output: 50,
              cacheRead: 100,
              cacheWrite: 0,
              cost: { total: 0.02 },
            },
          },
        },
        {},
      );
      await app.commands
        .get("prune-report")
        ?.handler("--output provider.md", { ...app.context(2_000, 32_000), cwd: directory });
      const report = await readFile(path.join(directory, "provider.md"), "utf8");
      assert.match(report, /Responses observed: 2/);
      assert.match(report, /Provider input\/output: 1020\/80 tokens/);
      assert.match(report, /Cache read\/write: 980\/10 tokens/);
      assert.match(report, /Cache-read share: 49\.00%/);
      assert.match(report, /Reported cost: \$0\.032345/);
      assert.match(report, /Rewritten responses: 1; input 900; cache read 100 \(10\.00%\)/);
      assert.match(report, /provider-reported observations, not a counterfactual/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reconciles all unreachable results after a Pi compaction", async () => {
    const app = createHarness();
    for (const id of ["gone-a", "gone-b"]) {
      const output = `src/${id}.ts:1: hit\n`.repeat(20);
      await app.handlers.tool_result?.(
        { toolCallId: id, toolName: "rg", content: textBlock(output) },
        {},
      );
    }
    const liveMessages = [
      assistant([{ id: "gone-a" }]),
      result("gone-a", "src/gone-a.ts:1: hit\n".repeat(20)),
      assistant([{ id: "gone-b" }]),
      result("gone-b", "src/gone-b.ts:1: hit\n".repeat(20)),
    ];
    await app.handlers.context?.({ messages: liveMessages }, app.context(10_000, 32_000));
    await app.handlers.session_compact?.({}, app.context(2_000, 32_000));
    await app.handlers.context?.({ messages: [] }, app.context(2_000, 32_000));
    assert.equal(app.entries.length, 1);
    assert.equal(app.entries[0].data.actions.length, 2);
    assert.equal(app.compactCalls, 0);
  });
});

describe("context guards and preservation", () => {
  test("retains compact validation hygiene without management instructions", () => {
    const cfg = config();
    const text = `Validation failed for tool "edit"\n- required: path\nReceived arguments:\n${"x".repeat(2_000)}`;
    const guarded = compactFailedToolValidationMessages(
      [{ role: "toolResult", content: textBlock(text) }],
      cfg,
    );
    assert.equal(guarded.modified, true);
    const output = textFrom(guarded.messages[0].content);
    assert.match(output, /compacted-tool-validation-error/);
    assert.doesNotMatch(output, /restore_chunks|prune_chunks/);
  });

  test("extracts active paths, anchors, and stable chunk ids", () => {
    const preserve = preserveContext(
      [
        { role: "user", content: textBlock("Fix src/a.ts for issue #918") },
        { role: "assistant", content: textBlock("Keep pc_123456789abc#bulk") },
      ],
      { modifiedFiles: ["src/b.ts"] },
    );
    assert.deepEqual([...(preserve.ids ?? [])], ["pc_123456789abc#bulk"]);
    assert.equal(preserve.paths?.has("src/a.ts"), true);
    assert.equal(preserve.paths?.has("src/b.ts"), true);
    assert.equal(preserve.anchors?.has("#918"), true);
  });
});

function textFrom(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .map((block) => (block && typeof block === "object" ? String(block.text ?? "") : ""))
    .join("\n");
}

function createHarness(overrides: Parameters<typeof mergeConfig>[0] = {}) {
  const handlers: Record<string, (event: any, ctx: any) => Promise<any>> = {};
  const commands = new Map<string, any>();
  const tools: any[] = [];
  const entries: any[] = [];
  const notifications: string[] = [];
  const statuses: string[] = [];
  let compactCalls = 0;
  const raw = {
    track: { minChunkTokens: 1 },
    restore: { diskCache: false },
    ...overrides,
  };
  const pi = {
    settings: { pruneChunks: raw },
    on(name: string, handler: (event: any, ctx: any) => Promise<any>) {
      handlers[name] = handler;
    },
    registerTool(tool: any) {
      tools.push(tool);
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
  };
  extension(pi as any);
  return {
    handlers,
    commands,
    tools,
    entries,
    notifications,
    statuses,
    get compactCalls() {
      return compactCalls;
    },
    context(tokens: number, contextWindow: number) {
      return {
        hasUI: true,
        getContextUsage: () => usage(tokens, contextWindow),
        compact() {
          compactCalls += 1;
        },
        ui: {
          notify(message: string) {
            notifications.push(message);
          },
          setStatus(_key: string, value: string) {
            statuses.push(value);
          },
        },
      };
    },
  };
}
