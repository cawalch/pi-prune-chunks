# July/August 2026 value audit

## Verdict

Context rot and compaction are separate problems. Recent long-horizon evidence
shows that accumulated stale tool output can reduce task accuracy well before a
window fills, and that trimming can improve outcomes. The repository should be
kept, but v0.3's pressure-only design did not address that goal. v0.4 restores a
batched absolute tool-output working set and retains pressure handling only as
an emergency fallback.

The strongest directly relevant results are:

- [Diagnosing and Mitigating Context Rot in Long-horizon Search](https://arxiv.org/abs/2606.29718)
  controls for query difficulty and finds premature termination rises with
  trajectory length. Simple discard/keep-latest strategies improve average
  accuracy across three long-search benchmarks.
- [Less Context, Better Agents](https://arxiv.org/abs/2606.10209) reports 71.0%
  completion with full history, 79.0% with five recent tool pairs, and 91.6%
  with recent pairs plus summaries.
- [SWE-Pruner Pro](https://arxiv.org/abs/2607.18213) reports up to 39% token
  savings while preserving quality, plus 3.8 points on SWE-Bench Verified and
  2.2 points on long-context Oolong.
- [Self-GC](https://arxiv.org/abs/2607.00692) shows indexed, recoverable,
  dependency-aware lifecycle control is safer than blind chronological
  heuristics. v0.4 retains exact archives and protects current dependencies,
  while acknowledging that its inexpensive heuristic has a lower ceiling.

## Why v0.2 failed

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
an aggressive sweep reduces an estimated 9,275-token fixture to 3,003 tokens
while retaining only 5 of 16 ordinary facts. The replay reports fact deletion
explicitly; only the provider-backed outcome benchmark supports a value claim.

## v0.3 below-pressure live canary

After implementation, a second matched canary replayed the same 181-entry raw
session prefix for two turns per arm with equal-length, arm-specific system
prompts. The provider-bound input plus cache-read totals were 261,069 tokens in
both first turns. On the second turns they were 261,079 for control and 261,080
for v0.3; the one-token difference followed a one-token difference in the first
assistant output. v0.3 wrote zero retirement deltas.

This confirmed the intended v0.3 behavior—but also confirmed that it delivered
no rot control in ordinary long sessions. Reported costs varied between arms because
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

## v0.4 provider-backed rot A/B

On 2026-08-07, five matched trials ran through Pi 0.83.0 and
`openrouter/google/gemini-2.5-flash-lite`. Each session contained six current
authoritative observations behind 65,536 requested tokens of obsolete,
conflicting tool-output hypotheses. The protocol warmed the common full-history
prefix, alternated arm order, disabled tools and thinking, rejected compaction,
and scored an exact six-field current-state object.

| Measure | Full history | v0.4 | Change |
| --- | ---: | ---: | ---: |
| Exact current state | 3/5 | 5/5 | +2 trials |
| Average provider context | 107,482 | 21,885 | -79.6% |
| Fresh input tokens | 324,011 | 88,182 | -72.8% |
| Cache-read tokens | 213,399 | 21,243 | -90.0% |
| Provider-reported answer cost | $0.034693 | $0.009187 | -73.5% |
| Pi compactions | 0 | 0 | unchanged |

Both full-history failures copied a checksum from obsolete history; v0.4
returned the six current values in all trials. This is direct evidence of
reduced stale-state interference, not merely a token estimate.

A separate fully cached trial exposed the intended economic tradeoff. The first
rewritten v0.4 answer cost $0.002221 versus the cached control's $0.001181. The
next unchanged v0.4 turn reused 21,235 cached tokens, performed zero additional
retirements, and cost $0.000290 versus $0.001162 for control. At that rate, a
second follow-up repays the initial cache-bust premium. This is why v0.4 uses a
high/low watermark instead of v0.2's incremental churn.

## v0.4 decision rules

1. Trigger normal rot control at 32,768 tracked tool-output tokens, independent
   of model window size, and target 16,384.
2. Require 8,192 tokens of new tracked-output growth before another batch.
3. Protect failures, diffs, current paths, reasoning anchors, recent restores,
   young results, and the six newest result families.
4. Keep the saved transcript authoritative, archive retired content exactly,
   preserve valid tool-call/result pairing, and never call Pi compaction.
5. Retain the 90%-to-80% provider-pressure gate only as an emergency rail.
6. Treat the five-trial result as evidence for this controlled stale-state
   workload, not a universal model ranking; repeat across providers before
   changing the default thresholds materially.

Exact archiving is a safety property, not evidence of value; no restoration was
used or scored in the matched result. The benchmark harness and raw reports are
kept outside the product change.
