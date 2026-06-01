# pi-prune-chunks

`pi-prune-chunks` is a Pi coding-agent extension for restorable context garbage
collection. It tracks bulky tool results, replaces low-value pruned results with
compact tombstones before provider calls, and keeps Pi's saved transcript intact.

Pi's built-in compaction is still useful, but it happens late. This extension
reduces context pressure before compaction by pruning old, restorable tool output
such as file reads, searches, shell logs, test output, diffs, Reamer context
packs, and FlowTrace results.

## Installation

```bash
pi --extension /path/to/pi-prune-chunks
```

Or in Pi settings:

```json
{
  "extensions": ["/path/to/pi-prune-chunks"]
}
```

## How It Works

1. The `tool_result` hook collects large text tool results into chunk metadata.
2. The registry assigns stable IDs such as `pc_0001_a1b2c3`, stores metadata,
   and keeps same-session content in memory for restore.
3. The `context` hook optionally auto-prunes safe old chunks when context usage
   exceeds the configured threshold.
4. Pruned chunks are replaced only in the provider-bound message copy with a
   tombstone like:

```text
[pruned:pc_0001_a1b2c3 search/code_search "src/a.ts:10" ~1200t summary="..." restore="restore_chunks({ids:['pc_0001_a1b2c3']})"]
```

Saved transcript entries are not rewritten or deleted.

## Tools

### `list_context_chunks`

Lists tracked chunks with kind, risk, token estimate, prune/pin state, restore
availability, summary, and source metadata.

```ts
{
  toolName?: string;
  kind?: "file_read" | "search" | "flow_trace" | "context_pack" | "shell" | "test_output" | "diff" | "outline" | "symbol" | "other";
  pruned?: boolean;
  pinned?: boolean;
  minTokens?: number;
  limit?: number;
  sortBy?: "tokens" | "age" | "recent" | "risk";
}
```

### `prune_chunks`

Prunes explicit chunk IDs. Legacy age/size convenience pruning is intentionally
not part of v1.

```ts
{ ids: string[]; reason?: string }
```

### `restore_chunks`

Restores pruned chunks from same-session memory, then source rehydration for
file-backed chunks with path and line range metadata.

```ts
{ ids: string[] }
```

### `pin_chunks` / `unpin_chunks`

Pins prevent auto-prune from pruning important chunks. Manual prune by explicit
ID remains available.

```ts
pin_chunks({ ids: string[], reason?: string })
unpin_chunks({ ids: string[] })
```

### `context_pressure`

Reports active/pruned chunk tokens, largest active chunks, auto-prune settings,
and recommended prune candidates.

## Commands

- `/prune-status` shows pressure and policy state.
- `/prune-largest --limit 20 --kind search` lists largest active chunks.
- `/prune-suggest --limit 10` lists safe candidates without pruning.
- `/prune-now --target 45000 --dry-run` previews safe immediate pruning.
- `/prune-now` prunes up to the configured max safe candidates.
- `/prune-restore pc_0001_a1b2c3` restores one or more pruned chunks.

## Configuration

Pi may provide extension config under `pruneChunks`:

```json
{
  "pruneChunks": {
    "enabled": true,
    "trackTools": ["*"],
    "track": { "minChunkTokens": 200 },
    "autoPrune": {
      "enabled": true,
      "startAtPercent": 70,
      "targetPercent": 55,
      "preserveRecentChunks": 5,
      "preserveRecentMinutes": 3,
      "minChunkTokens": 300,
      "maxChunksPerPass": 10
    },
    "tombstones": {
      "includeSummary": true,
      "includeRestoreHint": true,
      "maxSummaryChars": 180,
      "compactAtPercent": 90
    },
    "restore": {
      "memory": true,
      "diskCache": false,
      "sourceRehydrate": true
    },
    "debug": false
  }
}
```

Raw tool output is not persisted to disk by default.

## Safety Model

- Non-destructive: provider context is rewritten, saved transcript history is not.
- Restorable: same-session memory restores exact content; source rehydrate can
  recover file ranges when metadata is available.
- Conservative auto-prune: pinned, high-risk, the most recent chunks, recently
  restored chunks, and latest-assistant-referenced chunks are preserved. Created
  age and token floors relax once usage is materially above the start threshold.
- File-read pruning is cautious: instruction files, manifests, and common
  entrypoints are high risk, while unbounded whole-file reads wait for a higher
  pressure band than searches or context packs.
- Working-context protection: chunks whose source path is mentioned in the
  latest user or assistant message, or reported by Pi as modified, are protected
  from auto-prune and shown as protected in pressure reports.
- Recent chunks are preserved conservatively at the start threshold, then the
  protected recent window narrows under pressure and drops away in the
  high-pressure band so auto-prune can keep working toward the configured target.
- Pressure reports show non-chunk provider tokens and call out when the target
  cannot be reached by pruning tracked chunks alone.
- Exact duplicate tool outputs are scored higher as prune candidates.
- Scope boundary: this extension prunes tracked tool-result chunks, not system
  prompts or ordinary conversation history. If non-chunk overhead dominates,
  conversation-level compression is a separate mechanism.
- Transparent: every pruned chunk leaves a tombstone with ID, kind, tool, label,
  token estimate, optional summary, and restore hint.
- High-pressure tombstones: once provider context reaches the compact threshold,
  tombstones shrink to ID/kind/token markers to avoid tombstone overhead causing
  compaction or provider-window failures.

## Development

Use the Homebrew Node path in shells where `npm` is not on `PATH`:

```bash
PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/npm run check
PATH=/opt/homebrew/bin:$PATH /opt/homebrew/bin/npm run pack:dry
```

## More Docs

- [Architecture](docs/architecture.md)
- [Auto-prune policy](docs/auto-prune-policy.md)
- [Tool adapters](docs/tool-adapters.md)
- [Testing](docs/testing.md)
- [Failure modes](docs/failure-modes.md)
