# pi-prune-chunks

`pi-prune-chunks` is a narrow pressure safety rail for unusually tool-heavy Pi
sessions. Below 90% context usage it does not automatically retire tool output.
It is invisible to the model: there are no pruning tools, restore instructions,
decision cards, or context-management turns.

Pi still owns conversation compaction. The extension never calls
`ctx.compact()`, never blocks ordinary agent tools, and never rewrites the saved
Pi transcript.

## What v0.3 does

At or above 90% provider-context usage, the extension may perform one batched
sweep of old, low-risk, already-seen tool output, targeting 80%. It waits until
a result has appeared in at least one provider request. It preserves:

- high-risk output, current failures, and diffs;
- active paths and reasoning anchors;
- restored content during its grace period;
- the six newest results; and
- results younger than three minutes.

There is no fixed tool-output budget and no immediate deletion of duplicates or
zero-result searches. A sweep is not retried until provider usage grows by
another 8,192 tokens. Pi still decides whether conversation compaction is
needed.

This is deliberately less ambitious than v0.2. A controlled live A/B found
that v0.2 reduced average context by 7.94% but increased provider-reported cost
by 76.37% because repeated history rewrites destroyed cache reuse. See the
[July/August 2026 research and experiment](docs/research-2026-08.md).

## Provider safety and restore

Full retirement removes both the matching assistant tool-call block and its
tool result from the provider copy. Sibling calls and assistant text remain.
Malformed or partial structures use a neutral, provider-valid fallback. Large
results can be partially trimmed with a neutral marker.

Exact retired content remains available to the user. It is archived only when
retired, using queued atomic writes and a memory index. Cache cleanup is
scheduled rather than performed on every result.

## Install

```bash
pi --extension /path/to/pi-prune-chunks
```

Or add it to Pi settings:

```json
{
  "extensions": ["/path/to/pi-prune-chunks"]
}
```

## Human commands

These commands are for inspection and explicit user control; none are exposed
to the model:

```text
/prune-status
/prune-largest --limit 20
/prune-suggest --limit 10
/prune-now --dry-run
/prune-now pc_123456789abc
/prune-restore pc_123456789abc
/prune-report --output prune-report.md
```

## Configuration

The defaults are usually sufficient. The pressure policy is explicit:

```json
{
  "pruneChunks": {
    "pressure": {
      "triggerPercent": 90,
      "targetPercent": 80,
      "retryAfterGrowthTokens": 8192,
      "preserveRecentResults": 6,
      "preserveRecentMinutes": 3
    },
    "track": {
      "minChunkTokens": 200,
      "maxSummaryChars": 180
    },
    "restore": {
      "memory": true,
      "sourceRehydrate": true,
      "diskCache": {
        "enabled": true,
        "directory": "~/.pi/prune-chunks/cache-v2",
        "maxBytes": 262144000,
        "maxAgeDays": 14,
        "maxBlobBytes": 26214400
      }
    },
    "debug": false
  }
}
```

`enabled`, `trackTools`, `contextGuards`, restore/cache, and debug controls are
also configurable; see [the policy reference](docs/auto-prune-policy.md).

## Migration

v0.3 rejects v0.2 `budget`, `emergency`, and `redundancy` blocks as well as the
older `profile`, `autoPrune`, `decisionCards`, `tombstones`, and `reamerx`
blocks. Remove them or replace them with `pressure`. Old v0.2 retirement deltas
are ignored, so upgrading reconstructs active content from the raw transcript.

The following model-facing tools were removed:
`list_context_chunks`, `prune_chunks`, `restore_chunks`, `pin_chunks`,
`unpin_chunks`, `context_pressure`, and `context_report`. `/prune-profile` was
also removed.

## Development

```bash
npm run check
npm run bench:churn
npm run bench:cache
npm run bench:replay
npm run pack:dry
```

Detailed design and acceptance notes:

- [Architecture](docs/architecture.md)
- [Retirement policy](docs/auto-prune-policy.md)
- [Tool adapters](docs/tool-adapters.md)
- [Failure modes](docs/failure-modes.md)
- [Testing](docs/testing.md)
- [July/August 2026 research](docs/research-2026-08.md)
