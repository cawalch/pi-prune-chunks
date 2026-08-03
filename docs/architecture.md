# Architecture

v0.2 is a provider-copy hygiene layer, not an agent workflow and not a
replacement for Pi compaction.

## Data flow

1. `tool_result` classifies sufficiently large output and records compact
   metadata plus exact content in session memory.
2. Provable redundancy can retire a result immediately. Unique output is merely
   tracked.
3. The `context` hook reconciles results removed by Pi compaction, enforces the
   bounded tool-output budget, and evaluates the one-shot emergency safeguard.
4. Full retired exchanges are removed as a validated tool-call/result pair from
   the provider copy. A bulk child can instead be replaced by a neutral partial
   marker.
5. The original messages and saved transcript remain untouched.

The context hook returns nothing when no provider rewrite is needed. It never
adds management prompt content and never calls `ctx.compact()`.

## Registry and persistence

Chunk IDs are stable hashes of the tool-call ID, tool name, and exact result.
The registry is rebuilt from saved transcript messages on resume. Small v2
custom entries contain only state transitions (`active` or `pruned`) and are
replayed afterward. Full registries, audit logs, telemetry snapshots, and raw
output are not appended to the transcript.

Pi's transcript is authoritative. Compaction is observed for telemetry, then
live-context reconciliation retires tracked results that Pi removed from the
provider history.

## Archive layer

Active content stays in memory. Retirement schedules an archive operation;
disk writes are serialized, gzip-compressed, content-addressed, and atomically
renamed. An in-memory ID index avoids a directory scan on each operation.
Cleanup runs at startup, every 64 archives, or when the configured byte bound is
crossed.

## Telemetry and UI

Telemetry is aggregate and memory-only. It records effective provider-token
savings, retirement cause, rewrite time, archive time, restores, fallback
markers, and Pi compactions. No raw output is included. Normal passes generate
no notification; a single compact status line reports the working-set budget.
