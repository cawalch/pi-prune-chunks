# pi-prune-chunks

`pi-prune-chunks` keeps a bounded working set of bulky tool output in the
provider context. It is invisible to the model: there are no pruning tools,
restore instructions, decision cards, or context-management turns.

Pi still owns conversation compaction. The extension never calls
`ctx.compact()`, never blocks ordinary agent tools, and never rewrites the saved
Pi transcript.

## What v0.2 does

The extension retires output in two ways:

1. Provably redundant output is retired immediately: exact duplicates,
   zero-result searches, older file reads fully covered by a newer range, and
   exploratory ReamerX results superseded by a terminal result.
2. Unique low-risk output becomes eligible only after one provider pass. When
   active tool output exceeds its budget, the oldest safe results are retired.

The active tool-output budget is:

```text
clamp(contextWindow × 25%, 8,192, 65,536) tokens
```

By default, the extension preserves:

- high-risk output, current failures, and diffs;
- active paths and reasoning anchors;
- restored content during its grace period;
- the six newest results; and
- results younger than three minutes.

Crossing 70% context usage has no special meaning in v0.2. A rare emergency
sweep can retire safe old tool output above `contextWindow - 8,192` to create
response headroom. It runs at most once until tracked content changes or usage
grows another 2,048 tokens. Pi then decides whether conversation compaction is
needed.

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

The defaults are usually sufficient. All v0.2 policy settings are explicit:

```json
{
  "pruneChunks": {
    "budget": {
      "windowFraction": 0.25,
      "minTokens": 8192,
      "maxTokens": 65536,
      "preserveRecentResults": 6,
      "preserveRecentMinutes": 3
    },
    "emergency": {
      "minResponseHeadroomTokens": 8192,
      "retryAfterGrowthTokens": 2048
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

`enabled`, `trackTools`, `contextGuards`, `redundancy`, restore/cache, and debug
controls are also configurable; see [the policy reference](docs/auto-prune-policy.md).

## v0.1 migration

v0.2 is intentionally breaking. Remove `profile`, `autoPrune`,
`decisionCards`, `tombstones`, and `reamerx` policy blocks. The extension emits
a clear startup error if it sees one of these keys instead of silently mapping
old behavior.

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
