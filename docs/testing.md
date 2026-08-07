# Testing and acceptance

Run the full gate:

```bash
npm run check
npm run pack:dry
```

The architecture suite covers:

- 32k, 64k, 200k, and 1M percentage-trigger behavior;
- no ingestion-time deletion for duplicates or zero-result searches;
- shown-once eligibility, pressure recovery, oversized partial results, restored
  grace, active paths, anchors, failures, diffs, and newest/young output;
- sequential and parallel provider pairs, mixed assistant text, partial
  markers, missing pairs, malformed duplicates, and empty-message avoidance;
- post-compaction reconciliation and transcript/delta resume;
- 1,000 unchanged 89% hooks, with tracked output above v0.2's former cap, with
  no rewrite, mutation, persistence entry, notification, model management tool,
  or compaction call;
- provider-reported input/output/cache/cost telemetry and rewrite attribution;
- 100 archived results with scheduled rather than per-write directory scans.

Benchmarks:

```bash
npm run bench:churn
npm run bench:cache
npm run bench:replay
```

The replay compares no cleanup, v0.3 below pressure, and a v0.3 pressure sweep.
Below pressure must be byte-identical to no cleanup. Fact retention is counted
only by searching actual provider messages; no oracle summary injects discarded
facts. A pressure sweep must preserve protected facts and valid tool pairs.
