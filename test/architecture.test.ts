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
  activeToolBudget,
  budgetRetirementPlan,
  emergencyRetirementPlan,
  redundantRetirements,
  shouldRunEmergencySweep,
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

describe("v0.2 configuration", () => {
  test("derives a bounded working-set budget across model windows", () => {
    const cfg = config();
    assert.equal(activeToolBudget(32_000, cfg), 8_192);
    assert.equal(activeToolBudget(64_000, cfg), 16_000);
    assert.equal(activeToolBudget(200_000, cfg), 50_000);
    assert.equal(activeToolBudget(1_000_000, cfg), 65_536);
    assert.equal(activeToolBudget(undefined, cfg), 65_536);
  });

  test("uses the requested response-headroom thresholds", () => {
    const cfg = config();
    for (const window of [32_000, 64_000, 200_000, 1_000_000]) {
      const ceiling = window - 8_192;
      assert.equal(shouldRunEmergencySweep(usage(ceiling, window), cfg, 1), false);
      assert.equal(shouldRunEmergencySweep(usage(ceiling + 1, window), cfg, 1), true);
    }
  });

  test("rejects every legacy management-policy setting with a migration error", () => {
    for (const key of ["profile", "autoPrune", "decisionCards", "tombstones", "reamerx"]) {
      assert.throws(
        () => mergeConfig({ [key]: {} }),
        /v0\.2 no longer supports.*Migrate to budget, emergency, redundancy, and restore/,
      );
    }
  });
});

describe("provable redundancy", () => {
  test("retires exact duplicates but not merely matching commands", () => {
    const cfg = config();
    const registry = new ChunkRegistry();
    const first = addChunk(registry, cfg, "first", "exec_command", "src/a.ts:1:first hit", {
      command: "rg value src",
    });
    const duplicate = addChunk(registry, cfg, "duplicate", "exec_command", "src/a.ts:1:first hit", {
      command: "rg value src",
    });
    const duplicatePlan = redundantRetirements(registry, duplicate, cfg);
    assert.deepEqual(
      duplicatePlan.candidates.map((item) => item.id),
      [first.id],
    );

    const unique = addChunk(registry, cfg, "unique", "exec_command", "src/b.ts:9:different hit", {
      command: "rg value src",
    });
    const uniquePlan = redundantRetirements(registry, unique, cfg);
    assert.equal(
      uniquePlan.candidates.some((item) => item.id === duplicate.id),
      false,
    );
  });

  test("retires zero-result searches immediately", () => {
    const cfg = config();
    const registry = new ChunkRegistry();
    const zero = addChunk(registry, cfg, "zero", "rg", "No matches found");
    const plan = redundantRetirements(registry, zero, cfg);
    assert.deepEqual(
      plan.candidates.map((item) => item.id),
      [zero.id],
    );
  });

  test("requires full file-range coverage, not partial overlap", () => {
    const cfg = config();
    const registry = new ChunkRegistry();
    const old = addChunk(registry, cfg, "old", "read", "old bounded read", {
      path: "src/a.ts",
      startLine: 20,
      endLine: 40,
    });
    const partial = addChunk(registry, cfg, "partial", "read", "different partial read", {
      path: "src/a.ts",
      startLine: 30,
      endLine: 50,
    });
    assert.equal(
      redundantRetirements(registry, partial, cfg).candidates.some((item) => item.id === old.id),
      false,
    );
    const covering = addChunk(registry, cfg, "covering", "read", "different covering read", {
      path: "src/a.ts",
      startLine: 1,
      endLine: 100,
    });
    assert.equal(
      redundantRetirements(registry, covering, cfg).candidates.some((item) => item.id === old.id),
      true,
    );
    const failedCovering = addChunk(
      registry,
      cfg,
      "failed-covering",
      "read",
      "Error: source read failed",
      { path: "src/a.ts", startLine: 1, endLine: 200 },
    );
    assert.equal(
      redundantRetirements(registry, failedCovering, cfg).candidates.some(
        (item) => item.id === old.id,
      ),
      false,
    );
  });

  test("terminal Reamer output supersedes exploratory output in the same scope", () => {
    const cfg = config();
    const registry = new ChunkRegistry();
    const exploratory = addChunk(registry, cfg, "trace", "reamerx_trace", "call graph\nA -> B");
    const terminal = addChunk(registry, cfg, "pack", "reamerx_edit_pack", "patch-ready bundle");
    const plan = redundantRetirements(registry, terminal, cfg);
    assert.equal(
      plan.candidates.some((item) => item.id === exploratory.id),
      true,
    );
  });

  test("same-file diffs are never treated as supersession proof", () => {
    const cfg = config();
    const registry = new ChunkRegistry();
    const first = addChunk(
      registry,
      cfg,
      "diff-a",
      "git_diff",
      "diff --git a/src/a.ts b/src/a.ts\n-old\n+one",
    );
    const second = addChunk(
      registry,
      cfg,
      "diff-b",
      "git_diff",
      "diff --git a/src/a.ts b/src/a.ts\n-one\n+two",
    );
    assert.equal(
      redundantRetirements(registry, second, cfg).candidates.some((item) => item.id === first.id),
      false,
    );
  });
});

describe("budget and emergency policy", () => {
  test("unique low-risk output must be shown once before budget retirement", () => {
    const cfg = config({
      budget: {
        minTokens: 100,
        maxTokens: 100,
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
    assert.ok(registry.summary().activeTokens > 100);
    assert.equal(budgetRetirementPlan(registry, usage(700, 1_000), cfg).candidates.length, 0);
    registry.markSeenByToolCallId("new");
    assert.ok(budgetRetirementPlan(registry, usage(700, 1_000), cfg).candidates.length > 0);
  });

  test("preserves newest results, young results, failures, diffs, anchors, and active paths", () => {
    const cfg = config({
      budget: {
        minTokens: 1,
        maxTokens: 1,
        preserveRecentResults: 2,
        preserveRecentMinutes: 3,
      },
    });
    const registry = new ChunkRegistry();
    const oldSafe = addChunk(registry, cfg, "safe", "rg", "src/safe.ts:1: safe hit");
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
    const plan = budgetRetirementPlan(registry, usage(900, 1_000), cfg, {
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
    const lateAnchorPlan = budgetRetirementPlan(registry, usage(900, 1_000), cfg, {
      preserve: { anchors: new Set(["#919"]) },
    });
    assert.equal(
      lateAnchorPlan.candidates.some((candidate) => candidate.id === lateAnchor.id),
      false,
    );
  });

  test("restored output receives the same time-based grace", async () => {
    const cfg = config({
      budget: {
        minTokens: 1,
        maxTokens: 1,
        preserveRecentResults: 0,
        preserveRecentMinutes: 3,
      },
    });
    const registry = new ChunkRegistry();
    const chunk = addChunk(registry, cfg, "restore", "rg", "src/a.ts:1: hit");
    registry.prune([chunk.id]);
    const restored = await restoreChunks(registry, [chunk.id], cfg);
    assert.equal(restored[0].status, "restored");
    assert.equal(budgetRetirementPlan(registry, usage(900, 1_000), cfg).candidates.length, 0);
  });

  test("partially trims an old oversized result with a neutral marker", () => {
    const cfg = config({
      budget: {
        minTokens: 100,
        maxTokens: 100,
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
    const plan = budgetRetirementPlan(registry, usage(900, 1_000), cfg);
    assert.equal(plan.candidates.length, 1);
    assert.equal(plan.candidates[0].id, `${parent.id}#bulk`);
    registry.prune(
      plan.candidates.map((item) => item.id),
      "budget",
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

  test("runs the emergency sweep once until content changes or usage grows by 2,048", () => {
    const cfg = config({
      budget: {
        minTokens: 1,
        maxTokens: 1,
        preserveRecentResults: 0,
        preserveRecentMinutes: 0,
      },
    });
    const registry = new ChunkRegistry();
    addChunk(registry, cfg, "old", "rg", "src/a.ts:1: hit\n".repeat(400));
    const high = usage(92_000, 100_000);
    assert.equal(shouldRunEmergencySweep(high, cfg, registry.revision()), true);
    assert.ok(emergencyRetirementPlan(registry, high, cfg).candidates.length > 0);
    const previous = { registryRevision: registry.revision(), usageTokens: high.tokens ?? 0 };
    assert.equal(
      shouldRunEmergencySweep(usage(93_000, 100_000), cfg, registry.revision(), previous),
      false,
    );
    assert.equal(
      shouldRunEmergencySweep(usage(94_048, 100_000), cfg, registry.revision(), previous),
      true,
    );
    assert.equal(shouldRunEmergencySweep(high, cfg, registry.revision() + 1, previous), true);
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

  test("1,000 unchanged hooks at 70% produce no pruning, entries, notifications, or compact calls", async () => {
    const app = createHarness();
    await app.handlers.tool_result?.(
      {
        toolCallId: "stable",
        toolName: "rg",
        content: textBlock("src/a.ts:1: stable hit\n".repeat(50)),
      },
      {},
    );
    const messages = [
      assistant([{ id: "stable" }]),
      result("stable", "src/a.ts:1: stable hit\n".repeat(50)),
    ];
    const ctx = app.context(22_400, 32_000);
    for (let index = 0; index < 1_000; index++) {
      const transformed = await app.handlers.context?.({ messages }, ctx);
      assert.equal(transformed, undefined);
    }
    assert.equal(app.entries.length, 0);
    assert.equal(app.notifications.length, 0);
    assert.equal(app.compactCalls, 0);
  });

  test("budget cleanup waits one provider pass, then removes the full pair", async () => {
    const app = createHarness({
      budget: {
        minTokens: 100,
        maxTokens: 100,
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
    const ctx = app.context(700, 1_000);
    assert.equal(await app.handlers.context?.({ messages }, ctx), undefined);
    const transformed = await app.handlers.context?.({ messages }, ctx);
    assert.deepEqual(transformed?.messages, []);
    assert.equal(app.entries.length, 1);
    assert.equal(app.notifications.length, 0);
  });

  test("a zero-result search is retired on ingestion without an agent turn", async () => {
    const app = createHarness();
    await app.handlers.tool_result?.(
      { toolCallId: "zero", toolName: "rg", content: textBlock("No matches found") },
      {},
    );
    const transformed = await app.handlers.context?.(
      { messages: [assistant([{ id: "zero" }]), result("zero", "No matches found")] },
      app.context(1_000, 32_000),
    );
    assert.deepEqual(transformed?.messages, []);
    assert.equal(app.tools.length, 0);
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

  test("observes Pi compaction but never invokes it", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-prune-v2-report-"));
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

  test("extracts active paths, anchors, and stable v0.2 chunk ids", () => {
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
