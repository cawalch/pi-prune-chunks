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

## Settings and current Pi compatibility

The deterministic suite also covers nested JSON validation, lifecycle error
reporting/recovery, deferred cache initialization, trusted project overrides,
branch-local replay, and thinking-history protection. Test fixtures and the churn
benchmark use isolated temporary settings, never the user's Pi configuration.

Run the optional real-SDK smoke against an installed Pi package:

```bash
npm run test:sdk -- /path/to/pi-coding-agent/dist/index.js
```

This uses Pi's public extension discovery API to load the TypeScript entrypoint
and exercises settings, startup warnings, malformed nested input, cache failure,
and trusted project overrides. It does not call a provider or need credentials.
Validated with Pi 0.86.1. Unit tests alone use a small SDK-path fixture and cannot
establish runtime compatibility.

The existing `npm run bench:churn` now loads isolated settings through the same
file-based configuration path as the extension. `bench:replay` and `bench:cache`
remain deterministic component checks; none of these establish live task-quality
or signed-thinking retention benefits.
