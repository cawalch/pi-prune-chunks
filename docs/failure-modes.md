# Failure modes and safeguards

## Provider pair invariants

A well-formed full retirement deletes one assistant tool-call block and its
matching result. Parallel siblings and assistant text survive. Empty assistant
messages are dropped. Missing halves are removed rather than left orphaned;
malformed duplicates collapse to one call plus one neutral result.

## Restore archive failure

Retirement remains restorable from same-session memory even if a background
disk write fails. Debug logging can surface archive errors. On resume, the saved
transcript supplies exact content before state deltas are replayed.

## Oversized output

Large splittable results keep their leading evidence and replace only an old
bulk section with `[older bulk output retired]`. An unsplittable result still
obeys risk, recency, and shown-once protections.

## Conversation pressure

The extension can exhaust its safe tool-output candidates while overall
context remains full. This is expected: conversation history is Pi's domain.
There is no retry loop, forced management turn, tool blocking, or extension-
initiated compaction.

## Legacy configuration

Legacy policy keys and malformed nested settings disable pruning with an explicit
lifecycle warning and `/prune-status` error. The extension remains loaded so the
user can inspect the failure and recover after fixing settings and reloading.
Cache initialization failures use the same path. Project overrides are resolved
before disk storage is touched.

## Source rehydration

If memory and disk content are unavailable, bounded file reads can be restored
from recorded line ranges. An available mtime mismatch returns `source_changed`
rather than presenting new bytes as the original output.

## Thinking history

Tool-call pairing alone does not preserve signed thinking. New retirement and
validation rewrites pause for active reasoning models, prefix-bound effort models,
or replayed thinking blocks. Manual prune/restore mutations are blocked too.
Already-persisted retirement projections remain stable. This does not repair a
prefix invalidated by an earlier version or another extension; start a new session
when upgrading previously rewritten thinking histories.
