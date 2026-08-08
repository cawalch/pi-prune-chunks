# Architecture

v0.4 is a provider-copy working-set controller for long-horizon tool use. It is
not an agent workflow and not a replacement for Pi compaction.

## Data flow

1. `tool_result` classifies sufficiently large output and records compact
   metadata plus exact content in session memory.
2. Results are tracked without changing provider context.
3. The `context` hook reconciles results removed by Pi compaction, evaluates
   the absolute tracked-tool working set, and separately evaluates the
   90%-to-80% emergency pressure gate.
4. Full retired exchanges are removed as a validated tool-call/result pair from
   the provider copy. A bulk child can instead be replaced by a neutral partial
   marker.
5. The original messages and saved transcript remain untouched.

The 32,768-to-16,384-token working-set hysteresis operates independently of the
model window. It performs one large batch, then requires 8,192 tokens of new
tracked-output growth before changing the retired set again. Stable later
provider copies therefore retain a cacheable prefix. The context hook returns
nothing when no provider rewrite is needed. It never adds management prompt
content and never calls `ctx.compact()`.

This complements Pi compaction rather than duplicating it. Pi performs a lossy
summary of conversation history near its context threshold and keeps a recent
suffix. This extension selectively filters stale tool observations from Pi's
cloned provider-bound messages between those events without modifying the
saved transcript; exact retired bytes remain user-recoverable. It
does not register `session_before_compact` and does not create summaries,
manifests, tombstones, or continuation instructions. After `session_compact`,
it only reconciles its registry with the results Pi no longer keeps live.

## Registry and persistence

Chunk IDs are stable hashes of the tool-call ID, tool name, and exact result.
The registry is rebuilt from saved transcript messages on resume. Small custom
v3 entries contain only state transitions (`active` or `pruned`) and are
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

The archive makes retirement reversible for the user. It does not contribute
to pruning efficacy and is never exposed to the model as a restore workflow.

## Telemetry and UI

Telemetry is aggregate and memory-only. It records provider-reported input,
output, cache reads/writes, and cost from assistant `message_end` events, along
with rewrite attribution, retirement cause, hook time, archive time, restores,
fallback markers, and Pi compactions. The report explicitly treats these as
observations, not counterfactual savings. No raw output is included. Normal
passes generate no notification; a compact status line reports tracked output
against the rot-control trigger.
