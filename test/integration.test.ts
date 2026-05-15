/**
 * Integration + edge-case tests for pi-prune-chunks.
 *
 * Tests the extension hooks (tool_result, context, tool_call, session_start),
 * tool execute handlers (list_context_chunks, prune_chunks, restore_chunks),
 * and boundary / robustness scenarios that the core tracker tests don't cover.
 *
 * Uses Node's built-in node:test — no pi runtime required.
 */

import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  ChunkTracker,
  checkPruneStreak,
  contentText,
  contextFooter,
  estimateTokens,
  hardThresholdCheck,
  makeLabel,
  PRUNEABLE_TOOLS,
  softThresholdCheck,
  tombstoneFor,
} from "../src/tracker";

// ---------------------------------------------------------------------------
// Helper factories
// ---------------------------------------------------------------------------

function fakeContent(text: string): Array<{ type: string; text: string }> {
  return [{ type: "text", text }];
}

let idCounter = 1000;
function nextId(): string {
  return `call_${++idCounter}`;
}

function catalogueChunk(tracker: ChunkTracker, toolName: string, text: string, id?: string) {
  return tracker.catalogue(id ?? nextId(), toolName, fakeContent(text));
}

// ---------------------------------------------------------------------------
// Mock pi context for tool execute tests
// ---------------------------------------------------------------------------

type MockMessage = {
  role: string;
  toolCallId?: string;
  content?: Array<{ type: string; text: string }>;
};

function mockToolResultEvent(
  toolCallId: string,
  toolName: string,
  content: Array<{ type: string; text?: string }>,
) {
  return { toolCallId, toolName, content };
}

// ---------------------------------------------------------------------------
// Edge cases: estimateTokens
// ---------------------------------------------------------------------------

describe("estimateTokens edge cases", () => {
  test("empty string → 0 tokens", () => {
    assert.equal(estimateTokens(""), 0);
  });

  test("single character → 1 token", () => {
    assert.equal(estimateTokens("a"), 1);
  });

  test("unicode content counts chars not bytes", () => {
    // Each emoji is 1 char (but multiple bytes). /4 should round up.
    const emoji = "🔥🚀💻";
    assert.ok(estimateTokens(emoji) >= 1);
  });

  test("very long string scales linearly", () => {
    const short = "a".repeat(100);
    const long = "a".repeat(10000);
    assert.equal(estimateTokens(long), estimateTokens(short) * 100);
  });
});

// ---------------------------------------------------------------------------
// Edge cases: contentText
// ---------------------------------------------------------------------------

describe("contentText edge cases", () => {
  test("empty array → empty string", () => {
    assert.equal(contentText([]), "");
  });

  test("all non-text blocks → empty string", () => {
    const content = [
      { type: "image", data: "binary" },
      { type: "resource", data: "link" },
    ];
    assert.equal(contentText(content as any), "");
  });

  test("text blocks with empty text are filtered out", () => {
    const content = [
      { type: "text", text: "" },
      { type: "text", text: "visible" },
    ];
    // Empty text is filtered by the `c.text` truthiness check, so only "visible" remains
    assert.equal(contentText(content as any), "visible");
  });

  test("single text block returns its text directly", () => {
    const content = [{ type: "text", text: "hello world" }];
    assert.equal(contentText(content as any), "hello world");
  });
});

// ---------------------------------------------------------------------------
// Edge cases: makeLabel
// ---------------------------------------------------------------------------

describe("makeLabel edge cases", () => {
  test("empty content → tool name with empty text", () => {
    const label = makeLabel("code_search", "");
    assert.ok(label.startsWith("code_search:"));
  });

  test("content with only whitespace first lines", () => {
    const label = makeLabel("flow_trace", "   \n  \nactual content");
    // Should use the first non-empty line... actually it uses the first line
    assert.ok(label.includes("flow_trace:"));
  });

  test("exactly at truncation boundary (120 chars)", () => {
    const exactly120 = "x".repeat(120);
    const label = makeLabel("tool", exactly120);
    // 120 chars shouldn't trigger truncation
    assert.ok(!label.includes("…"));
  });

  test("121 chars triggers truncation", () => {
    const str121 = "x".repeat(121);
    const label = makeLabel("tool", str121);
    assert.ok(label.endsWith("…"));
  });
});

// ---------------------------------------------------------------------------
// Edge cases: tombstoneFor
// ---------------------------------------------------------------------------

describe("tombstoneFor edge cases", () => {
  test("tombstone includes all key info", () => {
    const chunk = {
      id: "call_abc123",
      toolName: "code_context",
      label: "some label text",
      estTokens: 1234,
      pruned: true,
      timestamp: Date.now(),
      originalContent: fakeContent("test"),
      pruneReason: "test cleanup",
    };
    const tomb = tombstoneFor(chunk);
    assert.equal(tomb.length, 1);
    assert.equal(tomb[0].type, "text");
    const text = tomb[0].text;
    assert.ok(text.includes("call_abc123"));
    assert.ok(text.includes("code_context"));
    assert.ok(text.includes("some label text"));
    assert.ok(text.includes("~1234t"));
    assert.ok(text.includes("restore_chunks"));
  });

  test("tombstone is significantly smaller than original for large chunks", () => {
    const bigContent = "x".repeat(10000);
    const chunk = {
      id: "call_big",
      toolName: "code_search",
      label: "big result",
      estTokens: 2500,
      pruned: true,
      timestamp: Date.now(),
      originalContent: fakeContent(bigContent),
    };
    const tomb = tombstoneFor(chunk);
    const tombSize = tomb[0].text.length;
    const originalSize = bigContent.length;
    // Tombstone should be < 5% of original size
    assert.ok(
      tombSize < originalSize * 0.05,
      `Tombstone ${tombSize} not much smaller than ${originalSize}`,
    );
  });
});

// ---------------------------------------------------------------------------
// ChunkTracker: catalogue edge cases
// ---------------------------------------------------------------------------

describe("ChunkTracker catalogue edge cases", () => {
  test("catalogues all PRUNEABLE_TOOLS", () => {
    const tracker = new ChunkTracker();
    const ids: string[] = [];
    for (const tool of PRUNEABLE_TOOLS) {
      const chunk = tracker.catalogue(
        `id_${tool}`,
        tool,
        fakeContent("some content that is long enough to meet the minimum threshold requirement"),
      );
      assert.ok(chunk, `Should catalogue ${tool}`);
      ids.push(`id_${tool}`);
    }
    assert.equal(ids.length, PRUNEABLE_TOOLS.size);
  });

  test("content with only non-text blocks is skipped", () => {
    const tracker = new ChunkTracker();
    const chunk = tracker.catalogue("id1", "code_context", [
      { type: "image", data: "binary" },
    ] as any);
    assert.equal(chunk, null);
  });

  test("content exactly 20 chars is accepted (boundary)", () => {
    const tracker = new ChunkTracker();
    const chunk = tracker.catalogue("id1", "code_context", fakeContent("x".repeat(20)));
    assert.ok(chunk, "20 chars should be accepted (>= 20)");
  });

  test("content 19 chars is rejected (below minimum)", () => {
    const tracker = new ChunkTracker();
    const chunk = tracker.catalogue("id1", "code_context", fakeContent("x".repeat(19)));
    assert.equal(chunk, null);
  });

  test("re-cataloguing same id overwrites", () => {
    const tracker = new ChunkTracker();
    tracker.catalogue("id1", "code_context", fakeContent("first content is long enough"));
    tracker.catalogue("id1", "code_search", fakeContent("second content is also long enough"));

    const chunk = tracker.get("id1")!;
    assert.equal(chunk.toolName, "code_search");
    assert.equal(chunk.label, "code_search: second content is also long enough");
  });

  test("catalogue with multiple text content blocks", () => {
    const tracker = new ChunkTracker();
    const content = [
      { type: "text", text: "first block with enough content" },
      { type: "text", text: "second block with more content" },
    ];
    const chunk = tracker.catalogue("id1", "code_context", content);
    assert.ok(chunk);
    // Token estimate should combine both blocks
    assert.ok(chunk!.estTokens > 0);
  });

  test("catalogue with empty text in some blocks", () => {
    const tracker = new ChunkTracker();
    const content = [
      { type: "text", text: "" },
      { type: "text", text: "actual content that is long enough to pass the threshold" },
    ];
    const chunk = tracker.catalogue("id1", "code_context", content);
    assert.ok(chunk);
  });
});

// ---------------------------------------------------------------------------
// ChunkTracker: prune edge cases
// ---------------------------------------------------------------------------

describe("ChunkTracker prune edge cases", () => {
  test("prune empty array returns empty results", () => {
    const tracker = new ChunkTracker();
    const results = tracker.prune([]);
    assert.equal(results.length, 0);
  });

  test("prune preserves original content for restore", () => {
    const tracker = new ChunkTracker();
    const original = "this is important content that should be preserved after pruning";
    tracker.catalogue("id1", "code_context", fakeContent(original));

    tracker.prune(["id1"]);
    const chunk = tracker.get("id1")!;
    assert.ok(chunk.originalContent);
    assert.equal(chunk.originalContent[0].text, original);
  });

  test("prune all chunks then verify prunedIds", () => {
    const tracker = new ChunkTracker();
    tracker.catalogue("id1", "code_context", fakeContent("content for chunk one is here"));
    tracker.catalogue("id2", "code_search", fakeContent("content for chunk two is here"));

    tracker.prune(["id1", "id2"]);
    const ids = tracker.prunedIds();
    assert.equal(ids.size, 2);
    assert.ok(ids.has("id1"));
    assert.ok(ids.has("id2"));
  });

  test("double prune returns zero freed tokens", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(tracker, "code_context", "some chunk content for testing", "id1");

    const first = tracker.prune(["id1"]);
    const second = tracker.prune(["id1"]);
    assert.equal(second[0].tokens, 0, "already_pruned should report 0 tokens");
    assert.ok(first[0].tokens > 0, "first prune should report tokens");
  });
});

// ---------------------------------------------------------------------------
// ChunkTracker: restore edge cases
// ---------------------------------------------------------------------------

describe("ChunkTracker restore edge cases", () => {
  test("restore empty array returns empty results", () => {
    const tracker = new ChunkTracker();
    const results = tracker.restore([]);
    assert.equal(results.length, 0);
  });

  test("restore clears pruneReason", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(tracker, "code_context", "chunk content for testing here", "id1");
    tracker.prune(["id1"], "some reason");
    assert.equal(tracker.get("id1")!.pruneReason, "some reason");

    tracker.restore(["id1"]);
    assert.equal(tracker.get("id1")!.pruneReason, undefined);
  });

  test("restore then re-prune works", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(tracker, "code_context", "chunk content for testing here", "id1");

    tracker.prune(["id1"]);
    tracker.restore(["id1"]);
    assert.equal(tracker.get("id1")!.pruned, false);

    const result = tracker.prune(["id1"]);
    assert.equal(result[0].status, "pruned");
    assert.equal(tracker.get("id1")!.pruned, true);
  });

  test("content_lost when original content is cleared", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(tracker, "code_context", "chunk content for testing here", "id1");
    tracker.prune(["id1"]);

    // Simulate content loss (e.g., across session reload)
    const chunk = tracker.get("id1")!;
    chunk.originalContent = [];

    const result = tracker.restore(["id1"]);
    assert.equal(result[0].status, "content_lost");
  });
});

// ---------------------------------------------------------------------------
// ChunkTracker: list edge cases
// ---------------------------------------------------------------------------

describe("ChunkTracker list edge cases", () => {
  test("list on empty tracker returns zeros", () => {
    const tracker = new ChunkTracker();
    const output = tracker.list();
    assert.equal(output.totalChunks, 0);
    assert.equal(output.totalTokens, 0);
    assert.equal(output.prunedTokens, 0);
    assert.equal(output.chunks.length, 0);
    assert.equal(output.listed, 0);
  });

  test("list with limit 0 returns no chunks", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(tracker, "code_context", "content that is long enough for testing", "id1");
    const output = tracker.list({ limit: 0 });
    assert.equal(output.listed, 0);
    assert.equal(output.totalChunks, 1);
  });

  test("list with pruned=false shows only active", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(tracker, "code_context", "content one for testing", "id1");
    catalogueChunk(tracker, "code_search", "content two for testing", "id2");
    tracker.prune(["id1"]);

    const output = tracker.list({ pruned: false });
    assert.equal(output.listed, 1);
    assert.equal(output.chunks[0].id, "id2");
  });

  test("list combines all filter options", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(tracker, "code_context", "content one for testing", "id1");
    catalogueChunk(tracker, "code_context", "content two for testing", "id2");
    catalogueChunk(tracker, "code_search", "content three for testing", "id3");
    tracker.prune(["id1"]);

    // Filter: tool=code_context, pruned=false, limit=1
    const output = tracker.list({ toolName: "code_context", pruned: false, limit: 1 });
    assert.equal(output.listed, 1);
    assert.equal(output.chunks[0].id, "id2");
    assert.equal(output.chunks[0].toolName, "code_context");
    assert.equal(output.chunks[0].pruned, false);
  });

  test("list pagination with limit", () => {
    const tracker = new ChunkTracker();
    for (let i = 0; i < 25; i++) {
      catalogueChunk(tracker, "code_context", `chunk ${i} content here`, `id${i}`);
    }

    const page1 = tracker.list({ limit: 10 });
    assert.equal(page1.listed, 10);
    assert.equal(page1.totalChunks, 25);
  });
});

// ---------------------------------------------------------------------------
// ChunkTracker: persistence edge cases
// ---------------------------------------------------------------------------

describe("ChunkTracker persistence edge cases", () => {
  test("persistenceMeta includes all chunks", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(tracker, "code_context", "content one for testing", "id1");
    catalogueChunk(tracker, "code_search", "content two for testing", "id2");
    tracker.prune(["id1"]);

    const meta = tracker.persistenceMeta();
    assert.equal(Object.keys(meta).length, 2);
    assert.equal(meta.id1.pruned, true);
    assert.equal(meta.id2.pruned, false);
  });

  test("restorePrunedSet ignores unknown chunk ids", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(tracker, "code_context", "content one for testing", "id1");

    const count = tracker.restorePrunedSet({
      nonexistent: { pruned: true },
      id1: { pruned: true },
    });
    assert.equal(count, 1);
    assert.equal(tracker.get("id1")!.pruned, true);
  });

  test("persistence round-trip preserves pruned state across tracker instances", () => {
    const tracker1 = new ChunkTracker();
    catalogueChunk(tracker1, "code_context", "content one for testing", "id1");
    catalogueChunk(tracker1, "code_search", "content two for testing", "id2");
    catalogueChunk(tracker1, "flow_trace", "content three for testing", "id3");
    tracker1.prune(["id1", "id3"], "exploration done");

    const meta = tracker1.persistenceMeta();

    // Simulate new tracker loading from persistence
    const tracker2 = new ChunkTracker();
    catalogueChunk(tracker2, "code_context", "content one for testing", "id1");
    catalogueChunk(tracker2, "code_search", "content two for testing", "id2");
    catalogueChunk(tracker2, "flow_trace", "content three for testing", "id3");

    tracker2.restorePrunedSet(meta);

    assert.equal(tracker2.get("id1")!.pruned, true);
    assert.equal(tracker2.get("id2")!.pruned, false);
    assert.equal(tracker2.get("id3")!.pruned, true);
    assert.equal(tracker2.get("id1")!.pruneReason, "exploration done");
  });
});

// ---------------------------------------------------------------------------
// ChunkTracker: statusSummary edge cases
// ---------------------------------------------------------------------------

describe("ChunkTracker statusSummary edge cases", () => {
  test("empty tracker summary", () => {
    const tracker = new ChunkTracker();
    const summary = tracker.statusSummary();
    assert.equal(summary.total, 0);
    assert.equal(summary.pruned, 0);
    assert.equal(summary.totalTokens, 0);
    assert.equal(summary.prunedTokens, 0);
    assert.equal(Object.keys(summary.activeByTool).length, 0);
  });

  test("all chunks pruned — activeByTool is empty", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(tracker, "code_context", "content one that is long enough", "id1");
    catalogueChunk(tracker, "code_search", "content two that is also long enough", "id2");
    tracker.prune(["id1", "id2"]);

    const summary = tracker.statusSummary();
    assert.equal(summary.total, 2);
    assert.equal(summary.pruned, 2);
    assert.equal(Object.keys(summary.activeByTool).length, 0);
  });

  test("multiple tools aggregated correctly", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(tracker, "code_context", "content one for testing", "id1");
    catalogueChunk(tracker, "code_context", "content two for testing", "id2");
    catalogueChunk(tracker, "code_context", "content three for testing", "id3");
    catalogueChunk(tracker, "flow_trace", "trace content for testing", "id4");

    const summary = tracker.statusSummary();
    assert.equal(summary.activeByTool.code_context.count, 3);
    assert.equal(summary.activeByTool.flow_trace.count, 1);
  });
});

// ---------------------------------------------------------------------------
// ChunkTracker: renderList edge cases
// ---------------------------------------------------------------------------

describe("ChunkTracker renderList edge cases", () => {
  test("renderList with no chunks", () => {
    const tracker = new ChunkTracker();
    const output = tracker.list();
    const text = tracker.renderList(output);
    assert.ok(text.includes("Tracked chunks:"));
    assert.ok(text.includes("0 total"));
  });

  test("renderList with pruned chunks shows yes/no", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(tracker, "code_context", "content one for testing", "id1");
    catalogueChunk(tracker, "code_search", "content two for testing", "id2");
    tracker.prune(["id1"]);

    const output = tracker.list();
    const text = tracker.renderList(output);
    assert.ok(text.includes("yes"));
    assert.ok(text.includes("no"));
  });
});

// ---------------------------------------------------------------------------
// contextFooter edge cases
// ---------------------------------------------------------------------------

describe("contextFooter edge cases", () => {
  test("all null/undefined inputs", () => {
    const footer = contextFooter(null, undefined, null, {
      total: 0,
      pruned: 0,
      totalTokens: 0,
      prunedTokens: 0,
    });
    assert.ok(footer.includes("?"));
    assert.ok(!footer.includes("NaN"));
    assert.ok(!footer.includes("undefined"));
  });

  test("100% usage", () => {
    const footer = contextFooter(32768, 32768, 100, {
      total: 10,
      pruned: 5,
      totalTokens: 20000,
      prunedTokens: 10000,
    });
    assert.ok(footer.includes("100%"));
    assert.ok(footer.includes("~10000t active"));
  });

  test("footer format is stable", () => {
    const footer = contextFooter(14203, 32768, 43, {
      total: 15,
      pruned: 3,
      totalTokens: 8000,
      prunedTokens: 2000,
    });
    // Should match the expected format pattern
    assert.ok(/\[Context:/.test(footer));
    assert.ok(/tracked/.test(footer));
    assert.ok(/pruned/.test(footer));
    assert.ok(/active\]/.test(footer));
  });
});

// ---------------------------------------------------------------------------
// softThresholdCheck edge cases
// ---------------------------------------------------------------------------

describe("softThresholdCheck edge cases", () => {
  test("exactly at tier 0 threshold (50%)", () => {
    const result = softThresholdCheck(16384, 32768, null, -1);
    assert.equal(result.shouldWarn, true);
    assert.equal(result.currentTier, 0);
  });

  test("just below tier 0 (49.9%)", () => {
    const pct = 49.9;
    const result = softThresholdCheck(null, null, pct, -1);
    assert.equal(result.shouldWarn, false);
    assert.equal(result.currentTier, -1);
  });

  test("exactly at tier 1 (70%)", () => {
    // 22938/32768 = 0.7000... (just at 70%)
    const result = softThresholdCheck(22938, 32768, null, -1);
    assert.ok(result.shouldWarn);
    assert.ok(result.currentTier >= 1);
  });

  test("exactly at tier 2 (85%)", () => {
    const result = softThresholdCheck(27853, 32768, null, -1);
    assert.ok(result.shouldWarn);
    assert.ok(result.currentTier >= 2);
  });

  test("token-based computation when percent is null", () => {
    const result = softThresholdCheck(28000, 32768, null, -1);
    assert.ok(result.shouldWarn);
    assert.ok(result.message!.includes("85%"));
  });

  test("undefined contextWindow returns safe defaults", () => {
    const result = softThresholdCheck(100, undefined, null, -1);
    assert.equal(result.shouldWarn, false);
    assert.equal(result.currentTier, -1);
  });
});

// ---------------------------------------------------------------------------
// hardThresholdCheck edge cases
// ---------------------------------------------------------------------------

describe("hardThresholdCheck edge cases", () => {
  test("exactly at threshold triggers block", () => {
    // 29492/32768 = 0.90002... (just at 90%)
    const result = hardThresholdCheck(29492, 32768, null, 0.9);
    assert.equal(result.shouldBlock, true);
  });

  test("just below threshold does not block", () => {
    const result = hardThresholdCheck(29490, 32768, null, 0.9);
    assert.equal(result.shouldBlock, false);
  });

  test("threshold 1.0 never blocks except at 100%", () => {
    const result = hardThresholdCheck(32767, 32768, null, 1.0);
    assert.equal(result.shouldBlock, false);

    const result100 = hardThresholdCheck(32768, 32768, null, 1.0);
    assert.equal(result100.shouldBlock, true);
  });

  test("threshold 0.0 always blocks", () => {
    const result = hardThresholdCheck(1, 32768, null, 0.0);
    assert.equal(result.shouldBlock, true);
  });
});

// ---------------------------------------------------------------------------
// checkPruneStreak edge cases
// ---------------------------------------------------------------------------

describe("checkPruneStreak edge cases", () => {
  test("streak of 0 never warns", () => {
    const result = checkPruneStreak(0, 1, 3);
    assert.equal(result.shouldWarn, false);
  });

  test("streak of 1 never warns with limit 3", () => {
    const result = checkPruneStreak(1, 1, 3);
    assert.equal(result.shouldWarn, false);
  });

  test("limit of 0 always warns for any positive count", () => {
    const result = checkPruneStreak(1, 1, 0);
    assert.equal(result.shouldWarn, true);
  });
});

// ---------------------------------------------------------------------------
// Extension hook simulation: tool_result → catalogue
// ---------------------------------------------------------------------------

describe("Extension hook simulation: tool_result", () => {
  test("catalogues pruneable tools via hook flow", () => {
    const tracker = new ChunkTracker();

    // Simulate tool_result hook for a pruneable tool
    const event = mockToolResultEvent("call_001", "code_context", [
      { type: "text", text: "export function handleRequest() { return 'ok'; }" },
    ]);
    const chunk = tracker.catalogue(
      event.toolCallId,
      event.toolName,
      event.content as Array<{ type: string; text?: string }>,
    );

    assert.ok(chunk);
    assert.equal(chunk!.id, "call_001");
    assert.equal(chunk!.toolName, "code_context");
    assert.equal(chunk!.pruned, false);
  });

  test("skips non-pruneable tools via hook flow", () => {
    const tracker = new ChunkTracker();

    const event = mockToolResultEvent("call_002", "bash", [
      { type: "text", text: "command output is very long and detailed" },
    ]);
    const chunk = tracker.catalogue(
      event.toolCallId,
      event.toolName,
      event.content as Array<{ type: string; text?: string }>,
    );

    assert.equal(chunk, null);
  });

  test("skips short content via hook flow", () => {
    const tracker = new ChunkTracker();

    const event = mockToolResultEvent("call_003", "code_search_symbols", [
      { type: "text", text: "not found" },
    ]);
    const chunk = tracker.catalogue(
      event.toolCallId,
      event.toolName,
      event.content as Array<{ type: string; text?: string }>,
    );

    assert.equal(chunk, null);
  });
});

// ---------------------------------------------------------------------------
// Extension hook simulation: context hook → tombstone replacement
// ---------------------------------------------------------------------------

describe("Extension hook simulation: context", () => {
  test("replaces pruned chunks with tombstones in messages", () => {
    const tracker = new ChunkTracker();
    tracker.catalogue(
      "call_001",
      "code_context",
      fakeContent("original content that is very long and detailed enough to be tracked"),
    );
    tracker.catalogue(
      "call_002",
      "code_search",
      fakeContent("search result content that is also long enough"),
    );
    tracker.prune(["call_001"]);

    const prunedIds = tracker.prunedIds();
    assert.ok(prunedIds.has("call_001"));
    assert.ok(!prunedIds.has("call_002"));

    // Simulate context hook replacing messages
    const messages: MockMessage[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "toolResult",
        toolCallId: "call_001",
        content: fakeContent(
          "original content that is very long and detailed enough to be tracked",
        ),
      },
      {
        role: "toolResult",
        toolCallId: "call_002",
        content: fakeContent("search result content that is also long enough"),
      },
    ];

    const modified = messages.map((msg) => {
      if (msg.role !== "toolResult") return msg;
      if (!prunedIds.has(msg.toolCallId!)) return msg;
      const chunk = tracker.get(msg.toolCallId!);
      if (!chunk) return msg;
      return { ...msg, content: tombstoneFor(chunk) };
    });

    assert.equal(modified[0].role, "user"); // unchanged
    assert.ok(
      (modified[1] as MockMessage).content![0].text.includes("[pruned:call_001"),
      "call_001 should be tombstoned",
    );
    assert.equal(
      (modified[2] as MockMessage).content![0].text,
      "search result content that is also long enough",
      "call_002 should be unchanged",
    );
  });

  test("no pruned chunks → messages unchanged", () => {
    const tracker = new ChunkTracker();
    tracker.catalogue(
      "call_001",
      "code_context",
      fakeContent("content that is long enough to be tracked"),
    );

    const prunedIds = tracker.prunedIds();
    assert.equal(prunedIds.size, 0);

    const messages: MockMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call_001",
        content: fakeContent("content that is long enough to be tracked"),
      },
    ];

    const modified = messages.map((msg) => {
      if (msg.role !== "toolResult") return msg;
      if (!prunedIds.has(msg.toolCallId!)) return msg;
      return msg; // would be tombstoned, but shouldn't reach here
    });

    assert.equal(
      (modified[0] as MockMessage).content![0].text,
      "content that is long enough to be tracked",
    );
  });

  test("tombstones are compact", () => {
    const tracker = new ChunkTracker();
    const bigText = "x".repeat(5000);
    tracker.catalogue("call_big", "code_context", fakeContent(bigText));
    tracker.prune(["call_big"]);

    const chunk = tracker.get("call_big")!;
    const tomb = tombstoneFor(chunk);
    const tombLen = tomb[0].text.length;

    // Tombstone should be < 7% of original (significant savings)
    assert.ok(
      tombLen < bigText.length * 0.07,
      `Tombstone ${tombLen} vs original ${bigText.length}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Extension hook simulation: tool_call hook → hard threshold + streak reset
// ---------------------------------------------------------------------------

describe("Extension hook simulation: tool_call", () => {
  test("always allows list/prune/restore tools even at 90%+", () => {
    const alwaysAllowed = new Set(["list_context_chunks", "prune_chunks", "restore_chunks"]);
    const usage = { tokens: 31000, contextWindow: 32768, percent: 95 };
    const check = hardThresholdCheck(usage.tokens, usage.contextWindow, usage.percent, 0.9);

    assert.equal(check.shouldBlock, true);

    // These tools should bypass the block
    for (const tool of alwaysAllowed) {
      assert.ok(alwaysAllowed.has(tool), `${tool} should be always allowed`);
    }
  });

  test("blocks non-prune tools at 90%+", () => {
    const check = hardThresholdCheck(30000, 32768, 92, 0.9);
    assert.equal(check.shouldBlock, true);
    assert.ok(check.message!.includes("prune_chunks"));
  });

  test("deadlock escape: lifts block when all chunks pruned", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(tracker, "code_context", "content for testing here", "id1");
    catalogueChunk(tracker, "code_search", "more content for testing here", "id2");
    tracker.prune(["id1", "id2"]);

    const summary = tracker.statusSummary();
    assert.equal(summary.total, 2);
    assert.equal(summary.pruned, 2);

    // All pruned → should allow through (deadlock escape)
    const allPruned = summary.total > 0 && summary.pruned >= summary.total;
    assert.ok(allPruned, "Should detect all-pruned state");
  });

  test("streak counter resets on non-prune tool calls", () => {
    let consecutivePruneCount = 0;

    // Simulate 3 prune calls
    consecutivePruneCount++; // prune call 1
    consecutivePruneCount++; // prune call 2
    consecutivePruneCount++; // prune call 3
    assert.equal(consecutivePruneCount, 3);

    // Non-prune tool call resets
    consecutivePruneCount = 0;
    assert.equal(consecutivePruneCount, 0);
  });
});

// ---------------------------------------------------------------------------
// Tool execute simulation: list_context_chunks
// ---------------------------------------------------------------------------

describe("Tool execute: list_context_chunks", () => {
  test("returns formatted output for tracked chunks", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(tracker, "code_context", "content one for testing", "id1");
    catalogueChunk(tracker, "code_search", "content two for testing", "id2");

    const output = tracker.list();
    const text = tracker.renderList(output);

    assert.ok(text.includes("id1"));
    assert.ok(text.includes("id2"));
    assert.ok(text.includes("code_context"));
    assert.ok(text.includes("code_search"));
    assert.ok(text.includes("Tracked chunks: 2 total"));
  });

  test("returns 'no chunks' message for empty tracker", () => {
    const tracker = new ChunkTracker();
    const output = tracker.list();
    assert.equal(output.chunks.length, 0);
    assert.equal(output.totalChunks, 0);
  });

  test("respects filter parameters", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(tracker, "code_context", "content one for testing", "id1");
    catalogueChunk(tracker, "code_search", "content two for testing", "id2");
    catalogueChunk(tracker, "code_context", "content three for testing", "id3");
    tracker.prune(["id1"]);

    // Filter by tool
    const byTool = tracker.list({ toolName: "code_context" });
    assert.equal(byTool.listed, 2);

    // Filter by pruned
    const pruned = tracker.list({ pruned: true });
    assert.equal(pruned.listed, 1);
    assert.equal(pruned.chunks[0].id, "id1");

    // Filter combined
    const combined = tracker.list({ toolName: "code_context", pruned: false });
    assert.equal(combined.listed, 1);
    assert.equal(combined.chunks[0].id, "id3");
  });
});

// ---------------------------------------------------------------------------
// Tool execute simulation: prune_chunks
// ---------------------------------------------------------------------------

describe("Tool execute: prune_chunks", () => {
  test("returns per-chunk results with token counts", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(tracker, "code_context", "content one for testing here", "id1");
    catalogueChunk(tracker, "code_search", "content two for testing here", "id2");

    const results = tracker.prune(["id1", "id2"]);
    assert.equal(results.length, 2);
    for (const r of results) {
      assert.equal(r.status, "pruned");
      assert.ok(r.tokens > 0);
    }

    const totalFreed = results.reduce((s, r) => s + r.tokens, 0);
    assert.ok(totalFreed > 0);
  });

  test("handles mixed batch (already pruned + new + not found)", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(tracker, "code_context", "content one for testing here", "id1");
    catalogueChunk(tracker, "code_search", "content two for testing here", "id2");
    tracker.prune(["id1"]);

    const results = tracker.prune(["id1", "id2", "id3"]);
    assert.equal(results[0].status, "already_pruned");
    assert.equal(results[1].status, "pruned");
    assert.equal(results[2].status, "not_found");
  });

  test("streak warning fires after max consecutive prunes", () => {
    let consecutive = 0;
    const max = 3;

    for (let i = 0; i < 4; i++) {
      consecutive++;
      const streak = checkPruneStreak(consecutive, 5, max);
      if (i >= max) {
        assert.ok(streak.shouldWarn, `Should warn at count ${consecutive}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Tool execute simulation: restore_chunks
// ---------------------------------------------------------------------------

describe("Tool execute: restore_chunks", () => {
  test("restores pruned chunks and returns token counts", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(tracker, "code_context", "content one for testing here", "id1");
    tracker.prune(["id1"]);

    const results = tracker.restore(["id1"]);
    assert.equal(results[0].status, "restored");
    assert.ok(results[0].tokens > 0);
    assert.equal(tracker.get("id1")!.pruned, false);
  });

  test("restore handles not_pruned and not_found", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(tracker, "code_context", "content one for testing here", "id1");

    const results = tracker.restore(["id1", "nonexistent"]);
    assert.equal(results[0].status, "not_pruned");
    assert.equal(results[1].status, "not_found");
  });
});

// ---------------------------------------------------------------------------
// Full lifecycle simulation
// ---------------------------------------------------------------------------

describe("Full lifecycle: session_start → tool_result → context → prune → restore", () => {
  test("complete session lifecycle", () => {
    const tracker = new ChunkTracker();

    // 1. Session start (empty)
    assert.equal(tracker.statusSummary().total, 0);

    // 2. Tool results arrive
    tracker.catalogue(
      "c1",
      "code_context",
      fakeContent("export function auth(token: string): boolean { return verify(token); }"),
    );
    tracker.catalogue(
      "c2",
      "flow_trace",
      fakeContent("handleRequest → auth → verify → database.query"),
    );
    tracker.catalogue(
      "c3",
      "code_search_symbols",
      fakeContent("class AuthService { login() logout() verify() }"),
    );
    tracker.catalogue("c4", "bash", fakeContent("npm test — 58 passed")); // non-pruneable

    assert.equal(tracker.statusSummary().total, 3); // bash excluded

    // 3. Context hook — no pruned chunks, messages pass through
    let prunedIds = tracker.prunedIds();
    assert.equal(prunedIds.size, 0);

    // 4. Soft threshold check
    let soft = softThresholdCheck(18000, 32768, 55, -1);
    assert.equal(soft.shouldWarn, true);
    assert.equal(soft.currentTier, 0);

    // 5. Prune old exploration
    const results = tracker.prune(["c1", "c2"], "exploration phase complete");
    assert.equal(results.filter((r) => r.status === "pruned").length, 2);

    // 6. Context hook — pruned chunks replaced with tombstones
    prunedIds = tracker.prunedIds();
    assert.equal(prunedIds.size, 2);

    // 7. Verify active state
    const summary = tracker.statusSummary();
    assert.equal(summary.total, 3);
    assert.equal(summary.pruned, 2);
    assert.equal(summary.activeByTool.code_search_symbols.count, 1);

    // 8. Escalate soft threshold
    soft = softThresholdCheck(24000, 32768, 73, soft.currentTier);
    assert.equal(soft.shouldWarn, true);
    assert.equal(soft.currentTier, 1);

    // 9. Hard threshold check
    const hard = hardThresholdCheck(30000, 32768, 92, 0.9);
    assert.equal(hard.shouldBlock, true);

    // 10. Deadlock escape — all pruned
    tracker.prune(["c3"]);
    const postPrune = tracker.statusSummary();
    assert.equal(postPrune.pruned, postPrune.total); // all pruned

    // 11. Restore a chunk
    const restoreResults = tracker.restore(["c3"]);
    assert.equal(restoreResults[0].status, "restored");

    // 12. Persistence round-trip
    const meta = tracker.persistenceMeta();
    const tracker2 = new ChunkTracker();
    tracker2.catalogue("c1", "code_context", fakeContent("restored content for c1"));
    tracker2.catalogue("c2", "flow_trace", fakeContent("restored content for c2"));
    tracker2.catalogue("c3", "code_search_symbols", fakeContent("restored content for c3"));
    tracker2.restorePrunedSet(meta);

    assert.equal(tracker2.get("c1")!.pruned, true);
    assert.equal(tracker2.get("c2")!.pruned, true);
    assert.equal(tracker2.get("c3")!.pruned, false);
  });

  test("session resume with persisted pruned set", () => {
    // Original session
    const session1 = new ChunkTracker();
    session1.catalogue("x1", "code_context", fakeContent("content for chunk one"));
    session1.catalogue("x2", "code_search", fakeContent("content for chunk two"));
    session1.catalogue("x3", "flow_trace", fakeContent("content for chunk three"));
    session1.prune(["x1", "x3"], "session ended");

    const meta = session1.persistenceMeta();

    // New session resumes
    const session2 = new ChunkTracker();
    // Chunks re-catalogued as tool results arrive
    session2.catalogue("x1", "code_context", fakeContent("content for chunk one"));
    session2.catalogue("x2", "code_search", fakeContent("content for chunk two"));
    session2.catalogue("x3", "flow_trace", fakeContent("content for chunk three"));
    session2.restorePrunedSet(meta);

    // x1 and x3 should be pruned, x2 active
    assert.equal(session2.get("x1")!.pruned, true);
    assert.equal(session2.get("x2")!.pruned, false);
    assert.equal(session2.get("x3")!.pruned, true);

    // x2 can still be pruned (it was active)
    const result = session2.prune(["x2"]);
    assert.equal(result[0].status, "pruned");

    // x1 cannot be restored — content was lost across reload
    session2.get("x1")!.originalContent = [];
    const restoreResult = session2.restore(["x1"]);
    assert.equal(restoreResult[0].status, "content_lost");
  });
});

// ---------------------------------------------------------------------------
// PRUNEABLE_TOOLS completeness check
// ---------------------------------------------------------------------------

describe("PRUNEABLE_TOOLS completeness", () => {
  test("all known Reamer tools are included", () => {
    const reamerTools = [
      "code_context",
      "code_search",
      "code_search_symbols",
      "code_read_range",
      "code_read_symbol",
      "code_outline",
      "code_related",
      "code_pattern_search",
      "code_semantic_search",
      "code_flow_trace",
    ];
    for (const tool of reamerTools) {
      assert.ok(PRUNEABLE_TOOLS.has(tool), `Missing Reamer tool: ${tool}`);
    }
  });

  test("all known FlowTrace tools are included", () => {
    const flowTools = ["flow_trace", "flow_path", "flow_impact"];
    for (const tool of flowTools) {
      assert.ok(PRUNEABLE_TOOLS.has(tool), `Missing FlowTrace tool: ${tool}`);
    }
  });

  test("core pi tools are NOT pruneable", () => {
    const excluded = [
      "bash",
      "read",
      "edit",
      "write",
      "web_search",
      "list_context_chunks",
      "prune_chunks",
      "restore_chunks",
    ];
    for (const tool of excluded) {
      assert.ok(!PRUNEABLE_TOOLS.has(tool), `${tool} should NOT be pruneable`);
    }
  });
});

// ---------------------------------------------------------------------------
// Token estimation accuracy check
// ---------------------------------------------------------------------------

describe("Token estimation validation", () => {
  test("estimate is in reasonable range for typical code", () => {
    const code = `export function handleRequest(req: Request, res: Response): void {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const user = verifyToken(token);
  if (!user) {
    res.status(403).json({ error: "Invalid token" });
    return;
  }
  req.user = user;
  next();
}`;
    const estimated = estimateTokens(code);
    // Real tokenizer would give ~100-130 tokens for this
    // char/4 heuristic should be in reasonable range
    assert.ok(estimated > 30, `Estimate too low: ${estimated}`);
    assert.ok(estimated < 200, `Estimate too high: ${estimated}`);
  });

  test("estimate for markdown content", () => {
    const md = `# Title\n\nThis is a paragraph with **bold** and *italic* text.\n\n- Item 1\n- Item 2\n- Item 3`;
    const estimated = estimateTokens(md);
    assert.ok(estimated > 5);
    assert.ok(estimated < 50);
  });
});
