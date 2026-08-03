# Tool adapters

Tracking is deliberately generic. Known names improve classification, while
`trackTools: ["*"]` allows arbitrary tool results to participate.

## Reads and searches

Paths and line ranges are inferred from structured arguments first, then safe
command/text patterns. Only complete newer range coverage retires an older read.
Searches are low risk unless their content carries a current failure signal.

## Shell, tests, and diffs

Read-only bounded shell output may be low risk. Current test failures are high
risk; successful test logs may become eligible after recency protection. Diffs
are always excluded from automatic budget retirement.

## ReamerX and flow tools

Repo maps, searches, symbols, traces, paths, impacts, and context tools are
exploratory. Edit packs, slices, and changes are terminal results. A terminal
result can supersede exploratory output only within the same recorded scope.

## Subagents

Scope metadata is retained when tool events provide run, parent, or agent
information. Live-context reconciliation requires at least one surviving main
result, preventing a subagent context from evicting the root task's registry.
