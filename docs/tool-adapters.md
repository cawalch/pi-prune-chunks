# Tool adapters

Tracking is deliberately generic. Known names improve classification, while
`trackTools: ["*"]` allows arbitrary tool results to participate.

## Reads and searches

Paths and line ranges are inferred from structured arguments first, then safe
command/text patterns. Searches are low risk unless their content carries a
current failure signal. Classification affects pressure eligibility only; it
does not cause immediate retirement.

## Shell, tests, and diffs

Read-only bounded shell output may be low risk. Current test failures are high
risk; successful test logs may become eligible after recency protection. Diffs
are always excluded from automatic pressure retirement.

## ReamerX and flow tools

Repo maps, searches, symbols, traces, paths, impacts, and context tools retain
their classification and scope metadata. Terminal output does not immediately
supersede exploratory output.

## Subagents

Scope metadata is retained when tool events provide run, parent, or agent
information. Live-context reconciliation requires at least one surviving main
result, preventing a subagent context from evicting the root task's registry.
