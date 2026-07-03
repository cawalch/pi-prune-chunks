# Auto-prune Policy

Auto-prune is enabled by default with the `coding-heavy` named profile and adaptive deterministic policy thresholds:

- profile `coding-heavy`
- policy `adaptive-v1`
- model profile `auto`
- start at 70 percent context usage
- target 55 percent usage
- preserve the 5 most recent chunks
- preserve chunks created or restored in the last 3 minutes
- only consider chunks with at least 300 estimated tokens
- prune at most 10 chunks per pass
- prune safely superseded chunks at ingestion
- prune zero-match search results at ingestion

Candidates are rejected when they are already pruned, pinned, high risk, not yet
seen in model context, too small, recent, recently restored, or referenced by
the latest assistant message.
Once pressure is at least 5 percentage points above the start threshold, the
created-age window and token floor relax so fast sessions can still shed safe
old-enough-by-position chunks. Pinned, high-risk, most-recent, recently restored,
and latest-assistant-referenced chunks remain protected.

Pressure reports separate tracked chunk tokens from non-chunk provider tokens.
If the system prompt and conversation history already exceed the configured
target, the report says the target cannot be reached by pruning tracked chunks
alone.

Ingest pruning runs before the pressure threshold. When
`autoPrune.pruneSupersededOnIngest` is enabled, a newer result prunes older
restorable active chunks that it safely supersedes: exact duplicate output,
repeated shell/search/test commands, overlapping reads of the same file, and
older diffs for the same file. When
`autoPrune.pruneZeroMatchSearchesOnIngest` is enabled, zero-match search results
are pruned immediately. Pinned, high-risk, and unrestorable chunks are not
pruned by this path.

Tombstones are normally informative, with label, source, bounded summary, and
restore hint. At high provider-context pressure, the context hook switches to
compact tombstones that keep only the chunk ID, kind, token estimate, and restore
marker. This preserves restorability while preventing large numbers of pruned
chunks from creating enough tombstone overhead to break compaction or provider
requests.

When pressure is extreme, compact tombstones can still be too expensive because
each old pruned tool result remains a provider message. The coalescing policy
uses `tombstones.coalesceAtPercent` to replace many old pruned tool-result
messages with a single manifest containing chunk IDs and a `restore_chunks`
hint. `tombstones.maxCoalescedEntries` bounds the number of IDs listed in one
manifest. Coalescing is a provider-context rewrite only; it does not delete or
rewrite saved transcript messages.

File reads are treated more carefully than search and context-pack output:
instruction files, manifests, and common entrypoints are high risk and are not
auto-pruned; large unbounded whole-file reads are medium risk and are held until
the session reaches a higher pressure band. Short non-anchor file reads and
bounded source ranges are low risk because they are easier to restore or repeat.
This delay applies only to file reads with a concrete source path; pathless
orientation output and directory trees are eligible like other exploratory
context.

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

`autoPrune.policy: "adaptive-v1"` keeps the same hard safety blocks but uses
candidate ordering from a deterministic policy decision. It adds score reasons
for restore cost (`memory` < `disk_cache` < `source_rehydrate` < unavailable),
pressure band, inferred task phase, model profile, source-anchor value, and
restore history. `modelProfile: "local-32k"` relaxes guards earlier and boosts
large candidates for tighter local windows; `"cloud-1m"` keeps more recent and
medium-risk context until higher pressure. Recently restored chunks are
protected for a longer temporary window, and chunks restored before receive a
score penalty after that window expires.

Pressure reports include the active policy, model profile, pressure band,
candidate score, confidence, blocked reason, and deltas since the last pressure
check so the agent can see why a chunk would or would not be pruned.

Named profiles tune these thresholds for common workloads and context windows:
`local-32k`, `local-64k`, `cloud-200k`, `cloud-1m`, `privacy-max`,
`research-heavy`, `coding-heavy`, and `debug-failures`. Profiles are only
presets: explicit user config is merged after the profile and takes precedence.
Use `/prune-profile <name>` to switch the active profile in a live session;
`/prune-profile reset` returns to the configured settings/default profile.

`autoPrune.policy: "heuristic-v1"` remains available for sessions that need the
previous conservative compatibility behavior.

The policy is intentionally cheap and metadata-driven. It does not do semantic
analysis and it does not decide code correctness.
