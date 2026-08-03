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

v0.1 profiles and percentage/tombstone policy keys fail startup with a migration
message. Silent reinterpretation would make a breaking policy change difficult
to diagnose.

## Source rehydration

If memory and disk content are unavailable, bounded file reads can be restored
from recorded line ranges. An available mtime mismatch returns `source_changed`
rather than presenting new bytes as the original output.
