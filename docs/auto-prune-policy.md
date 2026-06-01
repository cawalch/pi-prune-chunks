# Auto-prune Policy

Auto-prune is enabled by default with conservative thresholds:

- start at 70 percent context usage
- target 55 percent usage
- preserve the 5 most recent chunks
- preserve chunks created or restored in the last 3 minutes
- only consider chunks with at least 300 estimated tokens
- prune at most 10 chunks per pass

Candidates are rejected when they are already pruned, pinned, high risk, too
small, recent, recently restored, or referenced by the latest assistant message.
Once pressure is at least 5 percentage points above the start threshold, the
created-age window and token floor relax so fast sessions can still shed safe
old-enough-by-position chunks. Pinned, high-risk, most-recent, recently restored,
and latest-assistant-referenced chunks remain protected.

Pressure reports separate tracked chunk tokens from non-chunk provider tokens.
If the system prompt and conversation history already exceed the configured
target, the report says the target cannot be reached by pruning tracked chunks
alone.

Tombstones are normally informative, with label, source, bounded summary, and
restore hint. At high provider-context pressure, the context hook switches to
compact tombstones that keep only the chunk ID, kind, token estimate, and restore
marker. This preserves restorability while preventing large numbers of pruned
chunks from creating enough tombstone overhead to break compaction or provider
requests.

File reads are treated more carefully than search and context-pack output:
instruction files, manifests, and common entrypoints are high risk and are not
auto-pruned; unbounded whole-file reads are medium risk and are held until the
session reaches a higher pressure band. This delay applies only to file reads
with a concrete source path; pathless orientation output and directory trees are
eligible like other exploratory context. Bounded source ranges remain low-risk
because they can usually be rehydrated.

Working-context protection adds another guard above generic scoring. If the
latest user or assistant message mentions a tracked source path, or Pi exposes
that path as modified in the current context, the chunk is blocked from
auto-prune with the reason `referenced by active working context`. Pressure
reports show the largest protected chunks and their block reasons so the agent
can decide whether to manually pin, restore, or leave them alone.

The recent-chunk guard is adaptive. At the start threshold, auto-prune keeps the
configured recent window intact. Once pressure rises a few points higher, it
narrows that window so a session that is still above the target is not blocked
entirely by recency alone. In the high-pressure band, recency alone no longer
blocks a chunk. Pinned chunks, high-risk chunks, restored-recently chunks, and
working-context chunks remain hard stops.

Remaining candidates are scored higher when they are large, old, low risk,
restorable, or belong to exploratory tool kinds such as search, outline, symbol,
or flow trace output. Exact duplicate content hashes also receive a boost so
repeated tool output is pruned before unique context with similar size and risk.

The policy is intentionally cheap and metadata-driven. It does not do semantic
analysis and it does not decide code correctness.
