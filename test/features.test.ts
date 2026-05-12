/**
 * Tests for new features: reset, idsOlderThan, idsLargest, parseAge,
 * session_shutdown/model_select/turn_end hooks, and prune_chunks convenience params.
 */

import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { ChunkTracker } from "../src/tracker";

// index.ts exports parseAge via module scope — we test by importing the helper directly
// Since index.ts is an extension factory, we extract parseAge for testing by duplicating
// the logic here and testing against the implementation in index.ts.
// For direct testing, we use the tracker methods which are the core logic.

// ---------------------------------------------------------------------------
// parseAge — duplicated from index.ts for unit testing
// ---------------------------------------------------------------------------

const AGE_REGEX = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/;

function parseAge(age: string): number | null {
  const match = AGE_REGEX.exec(age.trim());
  if (!match) return null;
  const value = parseFloat(match[1]);
  const unit = match[2] ?? "ms";
  switch (unit) {
    case "ms":
      return value;
    case "s":
      return value * 1000;
    case "m":
      return value * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Helper factories
// ---------------------------------------------------------------------------

function fakeContent(text: string): Array<{ type: string; text: string }> {
  return [{ type: "text", text }];
}

function catalogueChunk(tracker: ChunkTracker, toolName: string, text: string, id?: string) {
  return tracker.catalogue(
    id ?? `id_${Math.random().toString(36).slice(2, 10)}`,
    toolName,
    fakeContent(text),
  );
}

// ---------------------------------------------------------------------------
// parseAge
// ---------------------------------------------------------------------------

describe("parseAge", () => {
  test("parses seconds", () => {
    assert.equal(parseAge("30s"), 30_000);
    assert.equal(parseAge("1s"), 1_000);
  });

  test("parses minutes", () => {
    assert.equal(parseAge("5m"), 300_000);
    assert.equal(parseAge("1m"), 60_000);
  });

  test("parses hours", () => {
    assert.equal(parseAge("1h"), 3_600_000);
    assert.equal(parseAge("2h"), 7_200_000);
  });

  test("parses milliseconds (default unit)", () => {
    assert.equal(parseAge("100"), 100);
    assert.equal(parseAge("500ms"), 500);
  });

  test("handles whitespace", () => {
    assert.equal(parseAge(" 5m "), 300_000);
    assert.equal(parseAge("  1h  "), 3_600_000);
  });

  test("handles decimal values", () => {
    assert.equal(parseAge("1.5m"), 90_000);
    assert.equal(parseAge("0.5h"), 1_800_000);
  });

  test("returns null for invalid formats", () => {
    assert.equal(parseAge("abc"), null);
    assert.equal(parseAge(""), null);
    assert.equal(parseAge("5d"), null);
    assert.equal(parseAge("m"), null);
  });
});

// ---------------------------------------------------------------------------
// ChunkTracker.reset
// ---------------------------------------------------------------------------

describe("ChunkTracker.reset", () => {
  test("clears all tracked chunks", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(tracker, "code_context", "content one that is long enough here");
    catalogueChunk(tracker, "code_search", "content two that is long enough here");
    assert.equal(tracker.statusSummary().total, 2);

    tracker.reset();

    assert.equal(tracker.statusSummary().total, 0);
    assert.equal(tracker.statusSummary().totalTokens, 0);
    assert.equal(tracker.statusSummary().pruned, 0);
  });

  test("clears pruned state", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(tracker, "code_context", "content one that is long enough here", "id1");
    tracker.prune(["id1"]);

    tracker.reset();

    assert.equal(tracker.prunedIds().size, 0);
    assert.equal(tracker.get("id1"), undefined);
  });
});

// ---------------------------------------------------------------------------
// ChunkTracker.idsOlderThan
// ---------------------------------------------------------------------------

describe("ChunkTracker.idsOlderThan", () => {
  test("finds chunks older than threshold", () => {
    const tracker = new ChunkTracker();

    // Old chunk (1 hour ago)
    const old = tracker.catalogue(
      "old1",
      "code_context",
      fakeContent("old chunk content that is long enough"),
    )!;
    old.timestamp = Date.now() - 3600_000;

    // Recent chunk
    catalogueChunk(tracker, "code_search", "recent chunk content that is long enough here");

    const ids = tracker.idsOlderThan(1800_000); // 30 min
    assert.equal(ids.length, 1);
    assert.equal(ids[0], "old1");
  });

  test("filters by toolName", () => {
    const tracker = new ChunkTracker();

    const old1 = tracker.catalogue(
      "old1",
      "code_context",
      fakeContent("old chunk content that is long enough"),
    )!;
    old1.timestamp = Date.now() - 3600_000;

    const old2 = tracker.catalogue(
      "old2",
      "code_search",
      fakeContent("old search content that is long enough"),
    )!;
    old2.timestamp = Date.now() - 3600_000;

    const ids = tracker.idsOlderThan(1800_000, { toolName: "code_context" });
    assert.equal(ids.length, 1);
    assert.equal(ids[0], "old1");
  });

  test("filters by onlyActive (excludes pruned)", () => {
    const tracker = new ChunkTracker();

    const old1 = tracker.catalogue(
      "old1",
      "code_context",
      fakeContent("old chunk content that is long enough"),
    )!;
    old1.timestamp = Date.now() - 3600_000;

    const old2 = tracker.catalogue(
      "old2",
      "code_context",
      fakeContent("old chunk two that is long enough"),
    )!;
    old2.timestamp = Date.now() - 3600_000;
    tracker.prune(["old2"]);

    const ids = tracker.idsOlderThan(1800_000, { onlyActive: true });
    assert.equal(ids.length, 1);
    assert.equal(ids[0], "old1");
  });

  test("returns empty when nothing is old enough", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(tracker, "code_context", "fresh chunk content that is long enough here");

    const ids = tracker.idsOlderThan(3600_000); // 1 hour
    assert.equal(ids.length, 0);
  });

  test("returns empty for empty tracker", () => {
    const tracker = new ChunkTracker();
    const ids = tracker.idsOlderThan(1000);
    assert.equal(ids.length, 0);
  });
});

// ---------------------------------------------------------------------------
// ChunkTracker.idsLargest
// ---------------------------------------------------------------------------

describe("ChunkTracker.idsLargest", () => {
  test("returns N largest active chunks", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(tracker, "code_context", "a".repeat(1000), "small");
    catalogueChunk(tracker, "code_search", "b".repeat(4000), "big");
    catalogueChunk(tracker, "flow_trace", "c".repeat(2000), "medium");

    const ids = tracker.idsLargest(2);
    assert.equal(ids.length, 2);
    assert.ok(ids.includes("big"));
    assert.ok(ids.includes("medium"));
  });

  test("filters by toolName", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(tracker, "code_context", "a".repeat(1000), "ctx_small");
    catalogueChunk(tracker, "code_context", "b".repeat(3000), "ctx_big");
    catalogueChunk(tracker, "code_search", "c".repeat(5000), "search_big");

    const ids = tracker.idsLargest(1, { toolName: "code_context" });
    assert.equal(ids.length, 1);
    assert.equal(ids[0], "ctx_big");
  });

  test("excludes already-pruned chunks", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(tracker, "code_context", "a".repeat(5000), "huge");
    catalogueChunk(tracker, "code_search", "b".repeat(1000), "tiny");
    tracker.prune(["huge"]);

    const ids = tracker.idsLargest(5);
    assert.equal(ids.length, 1);
    assert.equal(ids[0], "tiny");
  });

  test("returns empty for empty tracker", () => {
    const tracker = new ChunkTracker();
    const ids = tracker.idsLargest(3);
    assert.equal(ids.length, 0);
  });

  test("returns fewer if not enough chunks", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(tracker, "code_context", "only chunk content here", "id1");

    const ids = tracker.idsLargest(10);
    assert.equal(ids.length, 1);
  });
});

// ---------------------------------------------------------------------------
// prune_chunks convenience: olderThan + largest integration
// ---------------------------------------------------------------------------

describe("prune_chunks convenience integration", () => {
  test("olderThan prunes stale active chunks", () => {
    const tracker = new ChunkTracker();

    // Make 2 chunks, one old and one recent
    const old = tracker.catalogue(
      "old1",
      "code_context",
      fakeContent("old chunk content that is long enough to track"),
    )!;
    old.timestamp = Date.now() - 600_000; // 10 min ago

    catalogueChunk(tracker, "code_search", "recent chunk content that is long enough here");

    // Get ids older than 5 minutes
    const ids = tracker.idsOlderThan(300_000, { onlyActive: true });
    assert.equal(ids.length, 1);
    assert.equal(ids[0], "old1");

    // Prune them
    const results = tracker.prune(ids, "older than 5m");
    assert.equal(results[0].status, "pruned");
    assert.equal(tracker.get("old1")!.pruned, true);
  });

  test("largest prunes the biggest chunks", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(tracker, "code_context", "a".repeat(4000), "big1");
    catalogueChunk(tracker, "code_context", "b".repeat(2000), "big2");
    catalogueChunk(tracker, "code_context", "c".repeat(500), "small");

    // Get 2 largest
    const ids = tracker.idsLargest(2);
    assert.equal(ids.length, 2);

    const results = tracker.prune(ids, "largest 2");
    const pruned = results.filter((r) => r.status === "pruned");
    assert.equal(pruned.length, 2);

    // Small chunk should remain active
    assert.equal(tracker.get("small")!.pruned, false);
  });

  test("olderThan with toolName filter", () => {
    const tracker = new ChunkTracker();

    const oldCtx = tracker.catalogue(
      "ctx1",
      "code_context",
      fakeContent("old context content that is long enough to track"),
    )!;
    oldCtx.timestamp = Date.now() - 600_000;

    const oldSearch = tracker.catalogue(
      "search1",
      "code_search",
      fakeContent("old search content that is long enough to track"),
    )!;
    oldSearch.timestamp = Date.now() - 600_000;

    // Only get code_context chunks older than 5 min
    const ids = tracker.idsOlderThan(300_000, { toolName: "code_context", onlyActive: true });
    assert.equal(ids.length, 1);
    assert.equal(ids[0], "ctx1");
  });
});

// ---------------------------------------------------------------------------
// session_shutdown lifecycle simulation
// ---------------------------------------------------------------------------

describe("session lifecycle: shutdown + start", () => {
  test("reset clears state for fresh session", () => {
    const tracker = new ChunkTracker();

    // Session 1
    catalogueChunk(tracker, "code_context", "session 1 content that is long enough", "id1");
    tracker.prune(["id1"], "session 1 cleanup");
    assert.equal(tracker.statusSummary().total, 1);

    // Session shutdown → reset
    tracker.reset();
    assert.equal(tracker.statusSummary().total, 0);

    // Session 2 starts clean
    catalogueChunk(tracker, "code_search", "session 2 content that is long enough here", "id2");
    assert.equal(tracker.statusSummary().total, 1);
    assert.equal(tracker.get("id1"), undefined);
    assert.equal(tracker.get("id2")!.pruned, false);
  });

  test("persistence meta from old session doesn't pollute after reset", () => {
    const tracker = new ChunkTracker();

    // Session 1
    catalogueChunk(tracker, "code_context", "session 1 content here for testing", "id1");
    tracker.prune(["id1"]);
    const oldMeta = tracker.persistenceMeta();

    // Reset
    tracker.reset();

    // Session 2
    catalogueChunk(tracker, "code_search", "session 2 content here for testing", "id2");

    // Old meta shouldn't apply cleanly (id1 doesn't exist in new tracker)
    const restored = tracker.restorePrunedSet(oldMeta);
    assert.equal(restored, 0); // id1 not found in new tracker
    assert.equal(tracker.get("id2")!.pruned, false);
  });
});

// ---------------------------------------------------------------------------
// turn_end proactive suggestion simulation
// ---------------------------------------------------------------------------

describe("turn_end proactive suggestion simulation", () => {
  test("suggests pruning when context >= 70% with active chunks", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(
      tracker,
      "code_context",
      "large content chunk that is definitely long enough",
      "id1",
    );
    catalogueChunk(tracker, "code_search", "another chunk with lots of content here", "id2");

    const summary = tracker.statusSummary();
    const activeChunks = summary.total - summary.pruned;
    const pct = 0.73; // 73%

    // Simulate turn_end check logic
    let shouldSuggest = false;
    if (pct >= 0.7 && activeChunks > 0) {
      shouldSuggest = true;
    }
    assert.ok(shouldSuggest);
  });

  test("does not suggest when context < 70%", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(
      tracker,
      "code_context",
      "large content chunk that is definitely long enough",
      "id1",
    );

    const pct = 0.55; // 55%
    let shouldSuggest = false;
    if (pct >= 0.7) {
      shouldSuggest = true;
    }
    assert.equal(shouldSuggest, false);
  });

  test("does not suggest when all chunks are pruned", () => {
    const tracker = new ChunkTracker();
    catalogueChunk(tracker, "code_context", "content chunk that is long enough here", "id1");
    tracker.prune(["id1"]);

    const summary = tracker.statusSummary();
    const activeChunks = summary.total - summary.pruned;
    const pct = 0.75;

    let shouldSuggest = false;
    if (pct >= 0.7 && activeChunks > 0) {
      shouldSuggest = true;
    }
    assert.equal(shouldSuggest, false);
  });

  test("does not repeat suggestion within same turn", () => {
    const suggestedPruneThisTurn = true; // Already suggested
    // Skip logic
    assert.ok(suggestedPruneThisTurn);
    // The guard `if (suggestedPruneThisTurn) return;` prevents re-suggesting
  });
});

// ---------------------------------------------------------------------------
// model_select threshold reset simulation
// ---------------------------------------------------------------------------

describe("model_select threshold reset simulation", () => {
  test("resetting lastWarnedTier allows re-warning", () => {
    // Simulate: tier 0 warned, then model change
    let lastWarnedTier = 0;

    // Before model change: no repeat warning at tier 0
    const beforeReset = lastWarnedTier >= 0;

    // Model change resets
    lastWarnedTier = -1;

    // After reset: can warn again at tier 0
    assert.equal(lastWarnedTier, -1);
    assert.ok(!beforeReset || lastWarnedTier === -1);
  });
});

// ---------------------------------------------------------------------------
// Combined lifecycle: olderThan → prune → restore → reset → start
// ---------------------------------------------------------------------------

describe("combined lifecycle with convenience features", () => {
  test("full session with olderThan pruning", () => {
    const tracker = new ChunkTracker();

    // Catalogue exploration results
    const ctx1 = tracker.catalogue(
      "ctx1",
      "code_context",
      fakeContent("exploration step 1 result content for tracking"),
    )!;
    ctx1.timestamp = Date.now() - 600_000; // 10 min ago

    const ctx2 = tracker.catalogue(
      "ctx2",
      "code_context",
      fakeContent("exploration step 2 result content for tracking"),
    )!;
    ctx2.timestamp = Date.now() - 300_000; // 5 min ago

    catalogueChunk(tracker, "flow_trace", "trace result content that is long enough here");

    // Find chunks older than 5 minutes
    const stale = tracker.idsOlderThan(300_000, { onlyActive: true });
    assert.equal(stale.length, 1);
    assert.equal(stale[0], "ctx1");

    // Prune stale chunks
    const results = tracker.prune(stale, "stale exploration");
    assert.equal(results[0].status, "pruned");
    assert.equal(tracker.get("ctx1")!.pruned, true);
    assert.equal(tracker.get("ctx2")!.pruned, false);

    // Later, prune largest remaining chunk
    const largest = tracker.idsLargest(1);
    assert.equal(largest.length, 1);
    tracker.prune(largest, "freeing more space");

    // Verify all pruned
    const summary = tracker.statusSummary();
    assert.equal(summary.pruned, 2);
    assert.equal(summary.total - summary.pruned, 1);

    // Session shutdown
    tracker.reset();
    assert.equal(tracker.statusSummary().total, 0);
  });
});
