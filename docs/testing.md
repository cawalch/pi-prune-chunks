# Testing and acceptance

Run the full gate:

```bash
npm run check
npm run pack:dry
```

The architecture suite covers:

- 32k, 64k, 200k, and 1M budget/headroom behavior;
- exact duplicates, zero-result searches, fully covered reads, terminal tools,
  and negative supersession cases;
- shown-once eligibility, budget overflow, oversized partial results, restored
  grace, active paths, anchors, failures, diffs, and newest/young output;
- sequential and parallel provider pairs, mixed assistant text, partial
  markers, missing pairs, malformed duplicates, and empty-message avoidance;
- post-compaction reconciliation and transcript/delta resume;
- 1,000 unchanged 70% hooks with no rewrite, persistence entry, notification,
  model management tool, or compaction call; and
- 100 archived results with scheduled rather than per-write directory scans.

Benchmarks:

```bash
npm run bench:churn
npm run bench:cache
npm run bench:replay
```

The replay compares no cleanup, the v0.1 pressure/tombstone shape, and v0.2.
Fact retention is counted only by searching the actual provider messages; no
oracle summary injects facts that the strategy discarded. Acceptance requires
critical facts to remain and every surviving tool result to have a matching
tool call.
