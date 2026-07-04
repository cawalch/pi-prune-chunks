# Architecture

`pi-prune-chunks` is split into five layers:

1. Collector: turns large text tool results into typed chunk candidates and
   deterministic decision cards.
2. Registry: owns `ContextChunk` metadata, stable IDs, pin/prune state, audit
   events, and configured content caches.
3. Pruner: scores safe candidates and applies manual or automatic pruning.
4. Tombstones: renders compact provider-context replacements with decision-card
   previews under the configured summary budget. For partial child chunks, it
   replaces only the child's source line range with a tombstone and keeps the
   parent prefix/failure lines visible.
5. Continuation manifest: when provider pressure reaches the compact tombstone
   band, pins carry-forward failures/diffs/modified-path chunks and persists a
   compact ID/card/restore-hint manifest to help Pi compaction and resume.
6. Scope isolation: when Pi tool events include run/agent metadata, chunks carry
   `main`, `subagent`, or `chain` scope so child-agent exploration can be listed,
   pruned, and restored independently from parent working context.
5. Restorer: restores from memory first, then optional durable disk cache, then
   source file ranges when available.

The extension entry point wires these layers into Pi hooks:

- `tool_result` collects chunks.
- `context` auto-prunes when configured and replaces pruned tool-result messages
  in the copied provider context.
- tools and commands expose list, prune, restore, pin, unpin, and pressure flows.
  `/prune-restore` is a command wrapper over the same restore path as the
  `restore_chunks` tool.

The saved transcript remains the source of truth. Pruning state is metadata over
that transcript, not a destructive transcript edit. Non-privacy profiles enable a
compressed content-addressed blob cache by default for exact restore after a Pi
process restart; use `profile: "privacy-max"` or `restore.diskCache.enabled:
false` for memory-only raw content.

Large collected chunks can create child part chunks such as `#bulk`. The parent
keeps the exact full content for full restore, while child chunks let the pruner
or user remove a bulky tail without losing the high-signal prefix. Restoring the
child ID makes the original provider-bound tool result visible again on the next
context pass.

The extension only manages tracked tool-result chunks. It reports provider
tokens outside those chunks, but it does not compress the system prompt or
ordinary conversation history. Long sessions that are dominated by non-chunk
tokens need a separate conversation-level compression layer.
