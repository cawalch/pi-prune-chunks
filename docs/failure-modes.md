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

Auto-prune can also fail to reach the configured target when provider context
outside tracked chunks, such as system prompt and conversation history, already
exceeds the target. Pressure reports show non-chunk tokens and the best possible
post-prune percentage so this does not look like a chunk-pruning bug.

Tombstones can still confuse a model if they are too noisy or too terse. Keep
summaries bounded and restore only the specific chunks needed.

Many pruned chunks can make tombstone overhead material. When provider context
reaches the configured compact tombstone threshold, the context hook emits
minimal tombstones so old pruned-tool markers do not themselves push Pi's
auto-compaction or provider request over the context window.

Raw tool output is not persisted by default. This protects privacy but means
same-session memory restore is the only exact restore path unless source
rehydration metadata is available. Chunks without source path and line-range
metadata, such as repo maps or directory overviews, are intentionally
unavailable after memory is gone.
