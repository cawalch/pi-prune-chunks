# Failure Modes

Restore can fail when:

- a chunk was loaded from metadata after process restart and has no memory cache
- durable disk cache is disabled, missing, expired, size-trimmed, or corrupted
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

At more extreme pressure, the remaining risk is not tombstone text size but the
number of provider messages. A session can look healthy by chunk accounting, for
example `97 tracked, 95 pruned, ~759t active`, and still fail before the
provider call with a request such as `71834 tokens exceeds the available context
size 65536`. In that shape, many old pruned tool-result messages plus system
prompt and conversation history dominate the request. The coalesce threshold, or
the `coalesceMinChunks` count trigger when many pruned tombstones accumulate,
collapses older pruned tombstones into one manifest that preserves chunk IDs and
the `restore_chunks` hint while reducing provider-message overhead.

Failed tool-call validation can create a separate overflow path. A malformed
call can fail before execution and echo a large `Received arguments` block, such
as an `edit` request with a full `oldText` body but no valid `newText`. Large
tool-input echoes can create the same problem before or after execution. The
context guard compacts oversized validation errors and explicit tool-input echoes
in the provider copy, preserving the tool name, schema/error or source-path
hints, request-overflow line when present, and content hash while omitting the
raw echoed arguments. The saved transcript remains unchanged.

Raw tool output is persisted to a local compressed disk cache by default for
non-privacy profiles. This improves exact restore for chunks without source path
and line-range metadata, such as repo maps or directory overviews, after Pi
restart. Use `profile: "privacy-max"` or disable `restore.diskCache` when raw
tool output must stay memory-only; in that mode same-session memory restore is
the only exact restore path unless source rehydration metadata is available. If
the cache is later removed or trimmed, restore falls back to source rehydrate
when possible and otherwise reports the unavailable reason.
