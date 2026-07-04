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
[pruned:pc_0001_a1b2c3 search/code_search "src/a.ts:10" ~1200t card="search returned 2 top paths | evidence: src/a.ts; src/b.ts | restore when: need full snippets" restore="restore_chunks({ids:['pc_0001_a1b2c3']})"]
```

Saved transcript entries are not rewritten or deleted. Very large results may also expose child part IDs such as `pc_0001_a1b2c3#bulk`; pruning that child keeps the high-signal prefix/failure lines visible while tombstoning only the bulky tail.

## Tools

### `list_context_chunks`

Lists tracked chunks with kind, risk, token estimate, prune/pin state, restore
availability, decision-card preview, source metadata, child part markers for
partial-prune candidates, and optional `main`/`subagent`/`chain` scope metadata.

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
- `/prune-largest --scope subagent` focuses on child-agent context.
- `/prune-suggest --limit 10` lists safe candidates without pruning.
- `/prune-now --target 45000 --dry-run` previews safe immediate pruning.
- `/prune-now` prunes up to the configured max safe candidates.
- `/prune-restore pc_0001_a1b2c3` restores one or more pruned chunks.
- `/prune-report --output prune-report.md` writes a Markdown telemetry report
  with token savings, restore hit rate, tombstone overhead, and policy metrics.
- `/prune-profile` shows available profiles; `/prune-profile cloud-200k` switches
  the live session profile; `/prune-profile reset` returns to settings/default.
- `/prune-status` reports context pressure and whether a continuation manifest
  has been prepared for Pi compaction/resume.

## Configuration

Pi may provide extension config under `pruneChunks`:

```json
{
  "pruneChunks": {
    "profile": "coding-heavy",
    "enabled": true,
    "trackTools": ["*"],
    "track": { "minChunkTokens": 200 },
    "autoPrune": {
      "enabled": true,
      "policy": "adaptive-v1",
      "modelProfile": "auto",
      "startAtPercent": 70,
      "targetPercent": 55,
      "preserveRecentChunks": 5,
      "preserveRecentMinutes": 3,
      "minChunkTokens": 300,
      "maxChunksPerPass": 10,
      "pruneSupersededOnIngest": true,
      "pruneZeroMatchSearchesOnIngest": true
    },
    "reamerx": {
      "pruneExploratoryAfterTerminal": true
    },
    "tombstones": {
      "includeSummary": true,
      "includeRestoreHint": true,
      "maxSummaryChars": 180,
      "compactAtPercent": 90,
      "coalesceAtPercent": 98,
      "coalesceMinChunks": 16,
      "maxCoalescedEntries": 120
    },
    "contextGuards": {
      "compactFailedToolValidation": true,
      "maxFailedToolValidationChars": 1200
    },
    "restore": {
      "memory": true,
      "diskCache": {
        "enabled": true,
        "directory": "~/.pi/prune-chunks/cache",
        "maxBytes": 262144000,
        "maxAgeDays": 14,
        "maxBlobBytes": 26214400
      },
      "sourceRehydrate": true
    },
    "debug": false
  }
}
```

Profiles apply named defaults before explicit config overrides. Available profiles are `local-32k`, `local-64k`, `cloud-200k`, `cloud-1m`, `privacy-max`, `research-heavy`, `coding-heavy`, and `debug-failures`. For example, `"profile": "local-32k"` lowers prune thresholds and compacts tombstones earlier, while `"profile": "cloud-1m"` preserves more recent evidence and prunes mostly for latency/noise. Any explicit field such as `autoPrune.targetPercent` overrides the selected profile. Use `/prune-profile <name>` to switch profiles for the current live session without reloading; the live override is stored in extension state for the session lineage.

Raw tool output is persisted to the local durable disk cache by default for non-privacy profiles so non-file chunks can be restored after Pi restarts. Use `"profile": "privacy-max"` or `"restore": { "diskCache": false }` to keep raw tool output memory-only. For backward-compatible config, `"diskCache": true` is accepted and expands to the default durable-cache settings.

## Safety Model

- Non-destructive: provider context is rewritten, saved transcript history is not.
- Restorable: same-session memory restores exact content; optional durable disk
  cache can restore non-file chunks after restart; source rehydrate can recover
  file ranges when metadata is available.
- Conservative auto-prune: pinned, high-risk, the most recent chunks, recently
  restored chunks, and latest-assistant-referenced chunks are preserved. Created
  age and token floors relax once usage is materially above the start threshold.
- Ingest pruning: safely superseded chunks are pruned as soon as a newer result
  arrives. This covers overlapping file reads, repeated shell/search/test
  commands, exact duplicate outputs, superseded diffs of the same file, and
  zero-match search results.
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
- ReamerX exploratory chunks (`repo_map`, `context`, `trace`, `impact`, `search`,
  `symbols`, and Pi-prefixed equivalents) are tombstoned after terminal ReamerX
  evidence (`edit_pack`, `slice`, or `changes`) is acquired, while the terminal
  evidence remains active.
- Exact duplicate tool outputs are scored higher as prune candidates.
- Named policy profiles: top-level `profile` selects workload/model-window
  defaults; explicit config overrides always win.
- Adaptive policy mode is the default: `autoPrune.policy: "adaptive-v1"` adds
  deterministic restore-cost, pressure-band, task-phase, model-profile, and
  restore-history scoring. `modelProfile: "local-32k"` prunes more aggressively
  than `"cloud-1m"`; `"heuristic-v1"` remains available for conservative
  compatibility.
- Telemetry reports: `context_report` or `/prune-report` summarize collected,
  pruned, restored, restore availability, pruned-token buckets, coalesced, and
  tombstoned tokens without storing raw tool output in telemetry.
- Continuation manifest: near the compact tombstone pressure band, the extension
  pins carry-forward evidence such as failures, diffs, and modified-path chunks,
  then exposes a raw-output-free manifest of active IDs, pruned restore hints,
  failures/tests, and recent restores through `context_pressure` and
  `/prune-status`.
- Subagent-aware isolation: when Pi provides run/agent metadata, chunks are tagged
  as `main`, `subagent`, or `chain`. `list_context_chunks` and `/prune-largest`
  can filter by scope, and adaptive scoring prioritizes child exploratory output
  after a child manifest/final answer has been captured while keeping IDs
  restorable from the parent.
- Scope boundary: this extension prunes tracked tool-result chunks, not system
  prompts or ordinary conversation history. If non-chunk overhead dominates,
  conversation-level compression is a separate mechanism.
- Partial pruning: very large results can be split into restorable child parts
  such as `#bulk`. Pruning a child removes only that line range from provider
  context while retaining the parent prefix/failure metadata and allowing
  selective child restore by ID.
- Transparent: every pruned chunk leaves a tombstone with ID, kind, tool, label,
  token estimate, deterministic decision-card summary, and restore hint. Cards
  preserve a gist, key evidence, and restore triggers without requiring an LLM.
- High-pressure tombstones: once provider context reaches the compact threshold,
  tombstones shrink to ID/kind/token markers to avoid tombstone overhead causing
  compaction or provider-window failures.
- Tombstone coalescing: once context is over the coalesce threshold, or once many
  pruned tombstones accumulate (`coalesceMinChunks`), old pruned tool-result
  tombstones are collapsed into a small manifest message with restore IDs instead
  of preserving one provider message per pruned chunk. The saved transcript
  remains unchanged.
- Failed-tool validation guard: oversized validation errors that echo full tool
  arguments are compacted in provider context, preserving the schema error and
  omitting the raw `Received arguments` payload.

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
