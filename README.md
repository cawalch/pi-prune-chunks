# pi-prune-chunks

**Keep the clue. Park the wall of text. Restore it when you need it.**

`pi-prune-chunks` is a Pi extension that keeps long coding sessions usable by
replacing old, bulky tool output in provider context with small restorable
markers. The saved Pi transcript is not rewritten.

It is for the common agent-harness failure mode: searches, file reads, test logs,
ReamerX packs, shell output, subagent results, and diffs pile up until yesterday's
noise crowds out today's task.

## How it works

Before pruning, the model keeps carrying the full result:

```text
ffgrep "renderPressure"
  src/render.ts:120 ...
  src/render.ts:121 ...
  ... hundreds of lines ...
```

After pruning, Pi sends the model a restorable card:

```text
[pruned:pc_0007_a91c2f search/ffgrep "renderPressure" ~1800t
 card="search returned 2 top paths | evidence: src/render.ts; index.ts"
 restore="restore_chunks({ids:['pc_0007_a91c2f']})"]
```

Restore the exact content when needed:

```ts
restore_chunks({ ids: ["pc_0007_a91c2f"] })
```

## Highlights

- Tracks large tool results from reads, searches, shell/test output, diffs,
  ReamerX/FlowTrace packs, subagents, and generic tools.
- Prunes manually or automatically when context pressure rises.
- Leaves transparent tombstones with IDs, token estimates, summaries, source
  hints, and restore instructions.
- Restores from same-session memory, optional disk cache, or source ranges.
- Protects high-risk chunks, pins, recent restores, active paths, reasoning
  anchors, failures, diffs, and continuation state.
- Coalesces many old tombstones when message overhead becomes the problem.
- Supports profiles for local, cloud, privacy, research, coding, and debugging
  workloads.
- Emits telemetry reports without raw tool output.

See the detailed docs for policy and edge cases:

- [Architecture](docs/architecture.md)
- [Auto-prune policy](docs/auto-prune-policy.md)
- [Tool adapters](docs/tool-adapters.md)
- [Failure modes](docs/failure-modes.md)
- [Testing](docs/testing.md)

## Install

```bash
pi --extension /path/to/pi-prune-chunks
```

Or in Pi settings:

```json
{
  "extensions": ["/path/to/pi-prune-chunks"]
}
```

The default profile is `coding-heavy`: conservative enough for normal coding,
but active before emergency compaction.

## Use it in a session

```ts
context_pressure()
list_context_chunks({ sortBy: "tokens", limit: 10 })
prune_chunks({ ids: ["pc_0007_a91c2f"], reason: "old search; top paths are enough" })
pin_chunks({ ids: ["pc_0012_deadbe"], reason: "current failing test log" })
restore_chunks({ ids: ["pc_0007_a91c2f"] })
context_report()
```

Slash commands mirror the tools:

```text
/prune-status
/prune-largest --limit 20
/prune-suggest --limit 10
/prune-now --dry-run
/prune-restore pc_0001_a1b2c3
/prune-report --output prune-report.md
/prune-profile local-32k
/prune-profile reset
```

## Configuration

Most users should start with a profile:

```json
{
  "pruneChunks": {
    "profile": "coding-heavy"
  }
}
```

Useful alternatives:

```json
{ "pruneChunks": { "profile": "local-32k" } }
{ "pruneChunks": { "profile": "privacy-max" } }
{ "pruneChunks": { "profile": "research-heavy" } }
```

Override only what you need:

```json
{
  "pruneChunks": {
    "profile": "coding-heavy",
    "autoPrune": {
      "startAtPercent": 70,
      "targetPercent": 55,
      "maxChunksPerPass": 10
    },
    "restore": {
      "diskCache": {
        "enabled": true,
        "directory": "~/.pi/prune-chunks/cache",
        "maxBytes": 262144000,
        "maxAgeDays": 14,
        "maxBlobBytes": 26214400
      }
    }
  }
}
```

## Safety model

- **Non-destructive:** saved transcript history is not rewritten or deleted.
- **Restorable:** chunks can come back from memory, disk cache, or source ranges.
- **Conservative by default:** high-risk, pinned, recent, restored, and active
  working-context chunks are protected.
- **Transparent:** pruned chunks leave IDs and restore hints unless pressure
  forces compact markers.
- **Bounded:** pressure reports distinguish chunk tokens from non-chunk context.

## Development

```bash
PATH=/opt/homebrew/bin:$PATH npm run check
PATH=/opt/homebrew/bin:$PATH npm run pack:dry
```

Bench fixtures:

```bash
PATH=/opt/homebrew/bin:$PATH npm run bench:policy-compare
PATH=/opt/homebrew/bin:$PATH npm run bench:durable-store
PATH=/opt/homebrew/bin:$PATH npm run bench:context-savings
PATH=/opt/homebrew/bin:$PATH npm run bench:e2e-pruning
```

## Influences

This is a practical Pi implementation experiment inspired by context-engineering
work from Anthropic/Claude, Arize, LangChain, and recent long-horizon agent
papers. It does not try to reproduce those systems. Its narrower bet is that, in
Pi, bulky tool results should be addressable, auditable, cheap to hide, and easy
to restore.
