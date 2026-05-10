/**
 * Core ChunkTracker tests — exercise catalogue, prune, restore, list, persistence.
 *
 * Uses Node's built-in node:test — no pi runtime required.
 */

import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  ChunkTracker,
  contentText,
  estimateTokens,
  makeLabel,
  PRUNEABLE_TOOLS,
  tombstoneFor,
} from "../src/tracker";

// ---------------------------------------------------------------------------
// Helper factories
// ---------------------------------------------------------------------------

function fakeContent(text: string): Array<{ type: string; text: string }> {
  return [{ type: "text", text }];
}

let idCounter = 0;
function nextId(): string {
  return `call_${++idCounter}`;
}

function catalogueChunk(tracker: ChunkTracker, toolName: string, text: string, id?: string) {
  return tracker.catalogue(id ?? nextId(), toolName, fakeContent(text));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
  test("estimates ~char/4", () => {
    assert.equal(estimateTokens("hello world"), 3);
    assert.equal(estimateTokens("a".repeat(100)), 25);
  });
});

describe("contentText", () => {
  test("extracts text from content blocks", () => {
    const content = [
      { type: "text", text: "hello" },
      { type: "image", text: "binary" },
      { type: "text", text: "world" },
    ];
    assert.equal(contentText(content as any), "hello\nworld");
  });

  test("skips blocks without text", () => {
    const content = [{ type: "image", data: "..." }];
    assert.equal(contentText(content as any), "");
  });
});

describe("makeLabel", () => {
  test("creates tool: first_line label", () => {
    assert.equal(makeLabel("code_context", "line1\nline2"), "code_context: line1");
  });

  test("truncates long first lines", () => {
    const longLine = "x".repeat(200);
    const label = makeLabel("code_search", longLine);
    assert.ok(label.length <= 80 + "code_search: ".length + 1); // +1 for ellipsis char
    assert.ok(label.endsWith("…"));
  });
});

describe("tombstoneFor", () => {
  test("creates compact tombstone", () => {
    const chunk = {
      id: "call_123",
      toolName: "code_context",
      label: "test",
      estTokens: 500,
    } as any;
    const tomb = tombstoneFor(chunk);
    assert.equal(tomb.length, 1);
    assert.ok(tomb[0].text.includes("[pruned:call_123"));
    assert.ok(tomb[0].text.includes("restore_chunks"));
    assert.ok(tomb[0].text.includes("~500t"));
  });
});

describe("PRUNEABLE_TOOLS", () => {
  test("includes key Reamer/FlowTrace tools", () => {
    assert.ok(PRUNEABLE_TOOLS.has("code_context"));
    assert.ok(PRUNEABLE_TOOLS.has("code_search_symbols"));
    assert.ok(PRUNEABLE_TOOLS.has("flow_trace"));
    assert.ok(PRUNEABLE_TOOLS.has("flow_path"));
    assert.ok(PRUNEABLE_TOOLS.has("flow_impact"));
  });

  test("excludes non-code tools", () => {
    assert.ok(!PRUNEABLE_TOOLS.has("bash"));
    assert.ok(!PRUNEABLE_TOOLS.has("read"));
    assert.ok(!PRUNEABLE_TOOLS.has("edit"));
  });
});

describe("ChunkTracker", () => {
  test("catalogues pruneable tool results", () => {
    const tracker = new ChunkTracker();
    const chunk = catalogueChunk(
      tracker,
      "code_context",
      "export function handleRequest() { ... }",
    );
    assert.ok(chunk);
    assert.equal(chunk!.toolName, "code_context");
    assert.ok(chunk!.estTokens > 0);
    assert.equal(chunk!.pruned, false);
  });

  test("skips non-pruneable tools", () => {
    const tracker = new ChunkTracker();
    const chunk = catalogueChunk(tracker, "bash", "some output");
    assert.equal(chunk, null);
  });

  test("skips short content", () => {
    const tracker = new ChunkTracker();
    const chunk = catalogueChunk(tracker, "code_context", "hi");
    assert.equal(chunk, null);
  });

  test("list returns all chunks sorted newest first", () => {
    const tracker = new ChunkTracker();
    const chunk1 = catalogueChunk(tracker, "code_context", "first chunk content here", "id1");
    const chunk2 = catalogueChunk(tracker, "code_search", "second chunk content here", "id2");
    // Ensure different timestamps (same-tick creation may have identical Date.now())
    if (chunk1 && chunk2) chunk2.timestamp = chunk1.timestamp + 1;

    const output = tracker.list();
    assert.equal(output.totalChunks, 2);
    assert.equal(output.chunks[0].id, "id2"); // newest first
    assert.equal(output.chunks[1].id, "id1");
  });

  test("list filters by tool name", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(tracker, "code_context", "first chunk content here", "id1");
    catalogueChunk(tracker, "code_search", "second chunk content here", "id2");

    const output = tracker.list({ toolName: "code_search" });
    assert.equal(output.listed, 1);
    assert.equal(output.chunks[0].toolName, "code_search");
  });

  test("list filters by pruned status", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(tracker, "code_context", "first chunk content here", "id1");
    catalogueChunk(tracker, "code_search", "second chunk content here", "id2");
    tracker.prune(["id1"]);

    const output = tracker.list({ pruned: true });
    assert.equal(output.listed, 1);
    assert.equal(output.chunks[0].id, "id1");
  });

  test("list respects limit", () => {
    const tracker = new ChunkTracker();
    for (let i = 0; i < 10; i++) {
      catalogueChunk(tracker, "code_context", `chunk number ${i} content here`, `id${i}`);
    }

    const output = tracker.list({ limit: 3 });
    assert.equal(output.listed, 3);
    assert.equal(output.totalChunks, 10);
  });
});

describe("ChunkTracker prune", () => {
  test("prunes existing chunks", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(tracker, "code_context", "first chunk content here", "id1");

    const results = tracker.prune(["id1"]);
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "pruned");
    assert.ok(results[0].tokens > 0);

    const chunk = tracker.get("id1");
    assert.equal(chunk!.pruned, true);
    assert.equal(chunk!.pruneReason, undefined);
  });

  test("prune with reason stores reason", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(tracker, "code_context", "chunk content here for testing", "id1");

    tracker.prune(["id1"], "no longer needed");
    assert.equal(tracker.get("id1")!.pruneReason, "no longer needed");
  });

  test("prune returns already_pruned for double prune", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(tracker, "code_context", "chunk content here for testing", "id1");
    tracker.prune(["id1"]);

    const results = tracker.prune(["id1"]);
    assert.equal(results[0].status, "already_pruned");
  });

  test("prune returns not_found for unknown ids", () => {
    const tracker = new ChunkTracker();
    const results = tracker.prune(["nonexistent"]);
    assert.equal(results[0].status, "not_found");
  });

  test("prune handles mixed batch", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(tracker, "code_context", "first chunk content here", "id1");
    catalogueChunk(tracker, "code_search", "second chunk content here", "id2");
    tracker.prune(["id1"]);

    const results = tracker.prune(["id1", "id2", "id3"]);
    assert.equal(results[0].status, "already_pruned");
    assert.equal(results[1].status, "pruned");
    assert.equal(results[2].status, "not_found");
  });

  test("prunedIds returns set of pruned chunk ids", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(tracker, "code_context", "first chunk content here", "id1");
    catalogueChunk(tracker, "code_search", "second chunk content here", "id2");
    tracker.prune(["id1"]);

    const ids = tracker.prunedIds();
    assert.ok(ids.has("id1"));
    assert.ok(!ids.has("id2"));
    assert.equal(ids.size, 1);
  });
});

describe("ChunkTracker restore", () => {
  test("restores pruned chunks", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(tracker, "code_context", "chunk content here for testing", "id1");
    tracker.prune(["id1"]);

    const results = tracker.restore(["id1"]);
    assert.equal(results[0].status, "restored");
    assert.equal(tracker.get("id1")!.pruned, false);
  });

  test("restore returns not_pruned for unpruned chunks", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(tracker, "code_context", "chunk content here for testing", "id1");

    const results = tracker.restore(["id1"]);
    assert.equal(results[0].status, "not_pruned");
  });

  test("restore returns not_found for unknown ids", () => {
    const tracker = new ChunkTracker();
    const results = tracker.restore(["nonexistent"]);
    assert.equal(results[0].status, "not_found");
  });
});

describe("ChunkTracker persistence", () => {
  test("persistenceMeta serializes without original content", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(tracker, "code_context", "chunk content here for testing", "id1");
    tracker.prune(["id1"], "test reason");

    const meta = tracker.persistenceMeta();
    assert.ok(meta.id1);
    assert.equal(meta.id1.pruned, true);
    assert.equal(meta.id1.pruneReason, "test reason");
    assert.ok(!("originalContent" in meta.id1));
  });

  test("restorePrunedSet marks chunks as pruned", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(tracker, "code_context", "chunk content here for testing", "id1");
    catalogueChunk(tracker, "code_search", "second chunk content here", "id2");

    const count = tracker.restorePrunedSet({
      id1: { pruned: true, pruneReason: "restored from persistence" },
      id2: { pruned: false },
    });

    assert.equal(count, 1);
    assert.equal(tracker.get("id1")!.pruned, true);
    assert.equal(tracker.get("id2")!.pruned, false);
  });
});

describe("ChunkTracker statusSummary", () => {
  test("summarizes chunk statistics", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(tracker, "code_context", "first chunk content here", "id1");
    catalogueChunk(tracker, "code_context", "second chunk content here", "id2");
    catalogueChunk(tracker, "code_search", "third chunk content here", "id3");
    tracker.prune(["id1"]);

    const summary = tracker.statusSummary();
    assert.equal(summary.total, 3);
    assert.equal(summary.pruned, 1);
    assert.ok(summary.totalTokens > 0);
    assert.ok(summary.prunedTokens > 0);

    // Active by tool
    assert.equal(summary.activeByTool.code_context.count, 1);
    assert.equal(summary.activeByTool.code_search.count, 1);
    assert.ok(!summary.activeByTool.flow_trace);
  });
});

describe("ChunkTracker renderList", () => {
  test("renders formatted table", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(tracker, "code_context", "first chunk content here", "id1");

    const output = tracker.list();
    const text = tracker.renderList(output);
    assert.ok(text.includes("Tracked chunks:"));
    assert.ok(text.includes("id1"));
    assert.ok(text.includes("code_context"));
  });
});

describe("end-to-end prune and restore flow", () => {
  test("catalogue → list → prune → tombstone → restore cycle", () => {
    const tracker = new ChunkTracker();

    // Catalogue several chunks
    const chunk1 = catalogueChunk(
      tracker,
      "code_context",
      "export function authenticate(token: string) { ... }",
      "call_001",
    );
    const chunk2 = catalogueChunk(
      tracker,
      "flow_trace",
      "handleRequest [function] server.ts:10",
      "call_002",
    );
    const chunk3 = catalogueChunk(
      tracker,
      "code_search_symbols",
      "found: verifyToken at auth.ts:15",
      "call_003",
    );

    assert.ok(chunk1);
    assert.ok(chunk2);
    assert.ok(chunk3);

    // List shows all 3
    let output = tracker.list();
    assert.equal(output.totalChunks, 3);

    // Prune the first two
    const results = tracker.prune(["call_001", "call_002"], "exploration complete");
    assert.equal(results.filter((r) => r.status === "pruned").length, 2);

    // Verify pruned state
    assert.equal(tracker.get("call_001")!.pruned, true);
    assert.equal(tracker.get("call_002")!.pruned, true);
    assert.equal(tracker.get("call_003")!.pruned, false);

    // Tombstones are correct
    const tomb1 = tombstoneFor(tracker.get("call_001")!);
    assert.ok(tomb1[0].text.includes("[pruned:call_001"));
    assert.ok(tomb1[0].text.includes("code_context"));

    // List with filter
    output = tracker.list({ pruned: true });
    assert.equal(output.chunks.length, 2);

    // Restore one
    const restoreResults = tracker.restore(["call_002"]);
    assert.equal(restoreResults[0].status, "restored");
    assert.equal(tracker.get("call_002")!.pruned, false);

    // Persistence round-trip
    const meta = tracker.persistenceMeta();
    const tracker2 = new ChunkTracker();
    catalogueChunk(tracker2, "code_context", "dummy content for restoration testing", "call_001");
    tracker2.restorePrunedSet(meta);
    assert.equal(tracker2.get("call_001")!.pruned, true);
  });
});
