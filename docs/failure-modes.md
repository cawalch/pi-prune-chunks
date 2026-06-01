# Failure Modes

Restore can fail when:

- a chunk was loaded from metadata after process restart and has no memory cache
- source metadata lacks a path or line range
- the source file no longer exists
- the source file changed after the chunk was tracked
- source rehydration is disabled

Auto-prune can fail to free enough tokens when all remaining chunks are pinned,
recent, high risk, too small, or already pruned. In that case the extension
reports that no safe candidates were available.

Tombstones can still confuse a model if they are too noisy or too terse. Keep
summaries bounded and restore only the specific chunks needed.

Raw tool output is not persisted by default. This protects privacy but means
same-session memory restore is the only exact restore path unless source
rehydration metadata is available.
