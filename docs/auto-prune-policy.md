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

File reads are treated more carefully than search and context-pack output:
instruction files, manifests, and common entrypoints are high risk and are not
auto-pruned; unbounded whole-file reads are medium risk and are held until the
session reaches a higher pressure band. Bounded source ranges remain low-risk
because they can usually be rehydrated.

Remaining candidates are scored higher when they are large, old, low risk,
restorable, or belong to exploratory tool kinds such as search, outline, symbol,
or flow trace output.

The policy is intentionally cheap and metadata-driven. It does not do semantic
analysis and it does not decide code correctness.
