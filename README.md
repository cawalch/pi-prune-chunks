# pi-prune-chunks

`pi-prune-chunks` keeps stale tool output from degrading reasoning in long Pi
sessions. It maintains a bounded tool-output working set before the model
approaches its context limit. It is invisible to the model: there are no
pruning tools, restore instructions, decision cards, or context-management
turns.

Pi still owns conversation compaction. The extension never calls
`ctx.compact()`, never blocks ordinary agent tools, and never rewrites the saved
Pi transcript.

## What v0.4 does

When tracked tool output reaches about 32,768 tokens, the extension performs
one batched sweep of old, low-risk, already-seen results toward a 16,384-token
working set. This absolute gate is independent of the model's advertised
context window: it targets long-horizon context rot, not overflow. It waits
until a result has appeared in at least one provider request. Within each
batch it retires evidenced stale output first—exact duplicates, covered reads,
zero-result searches, and exploration superseded by terminal evidence—before
falling back to the oldest eligible output. It preserves:

- high-risk output, current failures, and diffs;
- active paths and reasoning anchors;
- restored content during its grace period;
- the six newest results; and
- results younger than three minutes.

After a sweep, another one requires 8,192 tokens of tracked-output growth. This
hysteresis batches cache-disrupting changes; unchanged later turns receive the
same rewritten prefix and can regain provider cache reuse.

The former 90%-to-80% provider-pressure rule remains only as an emergency rail.
Its usage decision takes the greater of Pi's estimate and a local estimate of
the provider-bound messages. Pi still decides whether conversation compaction
is needed.

Unlike v0.2, v0.4 does not retire incrementally every turn. The working set
crosses a high-water mark once, falls toward a low-water mark, and stays stable
until substantial new growth. See the
[July/August 2026 research and experiments](docs/research-2026-08.md).

## Live long-horizon evidence

A five-trial matched A/B used real provider calls through Pi with 65,536 tokens
of obsolete tool-output hypotheses per trial. The full-history arm reconstructed
the exact six-field current state in 3/5 trials; v0.4 succeeded in 5/5. Both
control failures selected a stale checksum.

Average provider context fell from 107,482 to 21,885 tokens (79.6%), aggregate
measured answer cost fell from $0.034693 to $0.009187 (73.5%), and neither arm
compacted. A separate fully cached probe measured the expected first-rewrite
premium, followed by cache recovery on the next unchanged turn: v0.4 cache-read
21,235 of 21,979 context tokens and cost $0.000290 versus the control's
$0.001162. One more similar follow-up repays the initial rewrite premium.

This is controlled evidence for stale-state interference on one model, not a
claim that every model or workload improves. The benchmark harness and raw
reports are intentionally not part of the product change.

## Provider safety and restore

Full retirement removes both the matching assistant tool-call block and its
tool result from the provider copy. Sibling calls and assistant text remain.
Malformed or partial structures use a neutral, provider-valid fallback. Large
results can be partially trimmed with a neutral marker.

Exact retired content remains available to the user. It is archived only when
retired, using queued atomic writes and a memory index. Cache cleanup is
scheduled rather than performed on every result.

Restore is a reversibility safeguard, not the value proposition: no restore
hint enters model context, the model never restores automatically, and the
evidence above counts task accuracy and provider context without restoration.

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

The defaults are usually sufficient. Rot control and emergency pressure are
configured separately:

```json
{
  "pruneChunks": {
    "workingSet": {
      "triggerTokens": 32768,
      "targetTokens": 16384,
      "retryAfterGrowthTokens": 8192
    },
    "pressure": {
      "triggerPercent": 90,
      "targetPercent": 80,
      "retryAfterGrowthTokens": 8192
    },
    "retention": {
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

`enabled`, `trackTools`, `contextGuards`, restore/cache, and debug
controls are also configurable; see [the policy reference](docs/auto-prune-policy.md).

## Migration

v0.4 accepts v0.3 `pressure.preserveRecent*` settings and migrates them into
`retention`; new configuration should use the explicit shape above. It rejects
v0.2 `budget`, `emergency`, and `redundancy` blocks as well as the
older `profile`, `autoPrune`, `decisionCards`, `tombstones`, and `reamerx`
blocks. Remove them or replace them with `workingSet`, `retention`, and
`pressure`. Old v0.2 retirement deltas are ignored, so upgrading reconstructs
active content from the raw transcript.

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
