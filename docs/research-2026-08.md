# July/August 2026 value audit

## Verdict

The v0.2 fixed-working-set strategy is not cost-effective for ordinary cached
Pi sessions. The extension remains defensible only as a rare pressure safety
rail for a gap in Pi's tool-loop compaction timing. If Pi closes that gap, or if
provider cache/cost observations show no practical benefit at pressure, this
plugin should be retired rather than expanded.

## Controlled live A/B

On 2026-08-07, control and v0.2 replayed the same real saved session through Pi
0.83.0 and `openrouter/z-ai/glm-5.2`. Both arms used equal-length system prompts,
thinking disabled, no tools, and three sequential turns.

| Measure | Control | v0.2 | Change |
| --- | ---: | ---: | ---: |
| Average provider context | 495,153 | 455,843 | -7.94% |
| Fresh input tokens | 495,242 | 1,159,135 | +134.05% |
| Cache-read tokens | 990,208 | 208,384 | -78.96% |
| Cache-read share | 66.66% | 15.24% | -51.42 pp |
| Provider-reported cost | $0.760666 | $1.341610 | +76.37% |

v0.2 performed 54 retirements across two passes. Even assigning every later
turn the full observed per-turn context reduction, the initial cache penalty
would require roughly 70 stable turns to break even. That is not a credible
default strategy for coding sessions.

The repository replay also showed why token reduction is not a quality proof:
v0.2 reduced an estimated 9,275-token fixture to 3,003 tokens while retaining
only 5 of 16 ordinary facts. The new replay requires below-pressure output to be
identical to no cleanup and reports fact deletion explicitly.

## v0.3 below-pressure live canary

After implementation, a second matched canary replayed the same 181-entry raw
session prefix for two turns per arm with equal-length, arm-specific system
prompts. The provider-bound input plus cache-read totals were 261,069 tokens in
both first turns. On the second turns they were 261,079 for control and 261,080
for v0.3; the one-token difference followed a one-token difference in the first
assistant output. v0.3 wrote zero retirement deltas.

This confirms the intended below-pressure behavior on a real session: no token
reduction and no result drop. Reported costs still varied between arms because
OpenRouter divided identical totals differently between fresh input and cache
reads. That variance is another reason not to infer plugin value from a single
unmatched run.

## Upstream changes that matter

- Pi [v0.80.7](https://github.com/earendil-works/pi/releases/tag/v0.80.7)
  added cache-friendly dynamic tool loading and removed the current date from
  the default prompt specifically to preserve cache prefixes. A plugin that
  repeatedly rewrites old history works against that direction.
- Pi [v0.81.0](https://github.com/earendil-works/pi/releases/tag/v0.81.0)
  expanded persisted usage accounting to tools, compaction, and branch
  summaries, making real usage measurement more reliable.
- Pi's pruning API discussion [explicitly identifies the first request after a
  context-hook rewrite as a cache bust](https://github.com/earendil-works/pi/discussions/330).
- In Pi [v0.84.1](https://github.com/earendil-works/pi/releases/tag/v0.84.1),
  coding-agent source still records the last assistant message for an
  auto-compaction check at `agent_end`. This leaves a narrow risk window during
  a long uninterrupted tool loop; issue
  [#6879](https://github.com/earendil-works/pi/issues/6879) reports that failure
  mode.

## v0.3 decision rules

1. Never automatically retire output below 90% context usage.
2. At pressure, perform one cache-disrupting batch toward 80%, then wait for
   8,192 tokens of further growth before retrying.
3. Keep the saved transcript authoritative and never call Pi compaction.
4. Record provider-reported input, output, cache reads/writes, and cost for
   every observed response; separately identify responses following rewrites.
5. Do not claim savings from one arm. A savings claim requires a matched control
   on the same session/model/provider with equal prompts and multiple turns.
6. Retire the plugin if Pi compacts safely inside tool loops or if matched
   pressure experiments fail to show lower cost or fewer overflow failures.
