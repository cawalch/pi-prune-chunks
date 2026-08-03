# Tool-output retirement policy

## Budget

```text
budget = clamp(contextWindow × budget.windowFraction,
               budget.minTokens,
               budget.maxTokens)
```

Defaults yield 8,192 tokens for a 32k model, 16,384 for 64k, 50,000
for 200k, and 65,536 for a 1M model. The exact 64,000-style window yields
16,000; Pi uses the model's reported window.

Context percentage does not trigger ordinary retirement. If active tool output
is below budget, crossing 70% alone is a no-op.

## Immediate redundancy

The following are evidence strong enough for immediate retirement:

- identical content hash and kind;
- a search explicitly reporting no/zero matches, results, or hits;
- an older read whose path and complete line range are covered by a newer read;
- exploratory ReamerX output in the same scope after a terminal edit pack,
  slice, or changes result.

Matching commands, partially overlapping reads, and same-file diffs are not
proof of supersession.

## Budget eligibility

Unique output is eligible only after it has appeared in one provider context.
Candidates must be low risk and older than the configured grace period. The
oldest candidates are selected until the working set fits its budget.

The policy protects high-risk results, failures, diffs, pinned internal state,
active paths, reasoning anchors, recent restores, the newest result families,
and young results. For a partially splittable result, the bulk child is selected
before its parent.

## Emergency safeguard

When usage exceeds:

```text
contextWindow - emergency.minResponseHeadroomTokens
```

the extension may perform one safe sweep to recover the missing headroom. It
uses the same conservative eligibility rules. It does not retry until registry
revision changes or usage grows by `emergency.retryAfterGrowthTokens`. It does
not call Pi compaction; conversation-heavy pressure is left to Pi.

## Settings

Alongside the README configuration, these optional settings remain:

```json
{
  "pruneChunks": {
    "enabled": true,
    "trackTools": ["*"],
    "redundancy": {
      "enabled": true,
      "pruneZeroMatchSearches": true,
      "pruneReamerxExplorationAfterTerminal": true
    },
    "contextGuards": {
      "compactFailedToolValidation": true,
      "maxFailedToolValidationChars": 1200
    }
  }
}
```
