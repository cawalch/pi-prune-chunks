# Testing and acceptance

Run the full gate:

```bash
npm run check
npm run pack:dry
```

The architecture suite covers:

- absolute 32,768-to-16,384 tracked-tool working-set behavior independent of
  model context-window size;
- shown-once working-set retirement below provider pressure and retry
  hysteresis based on new tracked-output growth;
- 32k, 64k, 200k, and 1M percentage-trigger behavior;
- no ingestion-time deletion for duplicates or zero-result searches, with
  evidence-backed supersession ranked first once a batch is actually needed;
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

No benchmark harness is part of the v0.4 product diff. The live matched result
is retained as audit evidence in the research note, while the committed gate is
the deterministic behavioral suite above.
