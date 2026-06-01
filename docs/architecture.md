# Architecture

`pi-prune-chunks` is split into five layers:

1. Collector: turns large text tool results into typed chunk candidates.
2. Registry: owns `ContextChunk` metadata, stable IDs, pin/prune state, audit
   events, and same-session content cache.
3. Pruner: scores safe candidates and applies manual or automatic pruning.
4. Tombstones: renders compact provider-context replacements.
5. Restorer: restores from memory first, then source file ranges when available.

The extension entry point wires these layers into Pi hooks:

- `tool_result` collects chunks.
- `context` auto-prunes when configured and replaces pruned tool-result messages
  in the copied provider context.
- tools and commands expose list, prune, restore, pin, unpin, and pressure flows.

The saved transcript remains the source of truth. Pruning state is metadata over
that transcript, not a destructive transcript edit.
