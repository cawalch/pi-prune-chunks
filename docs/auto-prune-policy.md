# Tool-output retirement policy

## Pressure gate

```text
trigger = contextWindow × 90%
target  = contextWindow × 80%
```

Below the trigger, automatic retirement is disabled regardless of how much
tracked output exists. There is no fixed working-set budget and no special
treatment for duplicates, zero-match searches, covered reads, or terminal
tool output.

The policy uses the greater of Pi's reported usage and a conservative estimate
of the provider-bound messages. This covers restored or upgraded sessions where
the usage sensor may lag the raw transcript.

## Eligibility

Output is eligible only after it has appeared in one provider context.
Candidates must be low risk and older than the configured grace period. The
oldest candidates are selected until estimated provider usage reaches the
target. If safe candidates are insufficient, the extension stops; it does not
block tools or request compaction.

The policy protects high-risk results, failures, diffs, pinned internal state,
active paths, reasoning anchors, recent restores, the newest result families,
and young results. For a partially splittable result, the bulk child is selected
before its parent.

## Retry behavior

After a pressure attempt, another sweep requires at least
`pressure.retryAfterGrowthTokens` of provider-context growth. Adding a tracked
result does not by itself trigger another rewrite. Falling below the pressure
threshold resets the gate.

## Settings

Alongside the README configuration, these optional settings remain:

```json
{
  "pruneChunks": {
    "enabled": true,
    "trackTools": ["*"],
    "pressure": {
      "triggerPercent": 90,
      "targetPercent": 80,
      "retryAfterGrowthTokens": 8192,
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
