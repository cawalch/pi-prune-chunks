# Tool-output retirement policy

## Long-horizon working-set gate

```text
trigger = 32,768 tracked tool-output tokens
target  = 16,384 tracked tool-output tokens
retry   = 8,192 tokens of later tracked-output growth
```

This absolute budget is deliberately independent of the advertised model
window. Long-horizon state interference appears before overflow, including on
models with very large windows. Crossing the high-water mark performs one
batched rewrite toward the low-water mark; unchanged later turns reuse the
same provider prefix.

## Emergency pressure gate

```text
trigger = contextWindow × 90%
target  = contextWindow × 80%
```

This percentage gate remains a fallback when conversation material, protected
tool output, or a smaller model window creates imminent pressure. It is not the
normal trigger for rot control.

The policy uses the greater of Pi's reported usage and a conservative estimate
of the provider-bound messages. This covers restored or upgraded sessions where
the usage sensor may lag the raw transcript.

## Eligibility

Output is eligible only after it has appeared in one provider context.
Candidates must be low risk and older than the configured grace period.
Candidate order first favors evidence of staleness: exact duplicates superseded
by a newer result, file ranges fully covered by a newer read, zero-result
searches, and exploration superseded by terminal evidence. The oldest generic
low-risk candidates follow until the active tool working set or provider
pressure reaches its applicable target. If safe candidates are insufficient,
the extension stops; it does not block tools or request compaction.

The policy protects high-risk results, failures, diffs, pinned internal state,
active paths, reasoning anchors, recent restores, the newest result families,
and young results. For a partially splittable result, the bulk child is selected
before its parent.

## Retry behavior

After a working-set attempt, another sweep requires
`workingSet.retryAfterGrowthTokens` of active tracked-output growth. Pressure
attempts use their own provider-context growth gate. Falling below either
trigger resets that gate. A newly collected result must still appear in one
provider request before it becomes eligible.

## Settings

Alongside the README configuration, these optional settings remain:

```json
{
  "pruneChunks": {
    "enabled": true,
    "trackTools": ["*"],
    "workingSet": {
      "triggerTokens": 32768,
      "targetTokens": 16384,
      "retryAfterGrowthTokens": 8192
    },
    "pressure": {
      "triggerPercent": 90,
      "targetPercent": 80,
      "retryAfterGrowthTokens": 8192
    },
    "retention": {
      "preserveRecentResults": 6,
      "preserveRecentMinutes": 3
    },
    "contextGuards": {
      "compactFailedToolValidation": true,
      "maxFailedToolValidationChars": 1200
    }
  }
}
```
