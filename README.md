# pi-prune-chunks

Context management companion for [pi](https://github.com/cawalch/pi-coding-agent) — tracks tool-result chunks from Reamer and FlowTrace and lets the agent prune/restore them to manage the context window.

## Why

Long agentic coding sessions accumulate tool-result context: `code_context` packs, `flow_trace` trees, search results. As context fills up, the model either triggers compaction (losing earlier work) or produces degraded reasoning.

Prune-chunks gives the agent a controlled lever: list what's consuming context, prune chunks that are no longer needed, and restore them if priorities change.

## How it works

1. **`tool_result` hook**: Automatically catalogues chunks from 13 Reamer/FlowTrace tools
2. **`context` hook**: Replaces pruned chunk content with compact tombstones before each LLM call — the saved transcript is untouched
3. **3 custom tools**: The agent can list, prune, and restore chunks with stable ids
4. **`/prune-status` command**: Show tracking summary in the TUI

Tombstone format: `[pruned:<id> <tool> "<label>" ~<tokens>t — use restore_chunks to recover]`

## Installation

```bash
# As a pi extension
pi --extension /path/to/pi-prune-chunks

# Or in settings.json
{
  "extensions": ["path/to/pi-prune-chunks"]
}
```

## Tools

### `list_context_chunks`

List tracked tool-result chunks with token estimates.

```
list_context_chunks({
  toolName?: string,    // filter by tool name
  pruned?: boolean,     // filter by pruned status
  limit?: number        // max chunks to list (default 20)
})
```

### `prune_chunks`

Replace chunk content with tombstones to free context tokens.

```
prune_chunks({
  ids: string[],        // chunk ids to prune (from list_context_chunks)
  reason?: string       // optional reason for audit trail
})
```

### `restore_chunks`

Recover pruned chunk content (same session only — content is not persisted across reloads).

```
restore_chunks({
  ids: string[]         // chunk ids to restore
})
```

## Tracked tools

The extension catalogues results from these tools:

- `code_context`, `code_search`, `code_search_symbols`
- `code_read_range`, `code_read_symbol`, `code_outline`, `code_related`
- `code_pattern_search`, `code_semantic_search`, `code_flow_trace`
- `flow_trace`, `flow_path`, `flow_impact`

## Persistence

- Pruned-set is persisted via `pi.appendEntry()` for reload/resume
- Original content is kept in memory for same-session restore
- Across reloads, pruned status is retained but content cannot be restored (tombstones remain)

## Design decisions

- **Non-destructive**: Pruning happens in the `context` hook (pre-provider), not by modifying session entries. This preserves transcript integrity and provider prefix-cache hits.
- **Agent-driven**: The model decides what to prune. No automatic heuristics that might remove the wrong context.
- **Reversible within session**: Restore is always available for the current session.
- **Tombstones, not deletion**: Pruned content is replaced with a compact reference, not removed. The agent always knows what was pruned and can decide to restore it.

## Development

```bash
npm install
npm run check          # lint + typecheck + test + coverage
npm test               # run tests
npm run pack:dry       # verify package contents
```

## License

MIT
