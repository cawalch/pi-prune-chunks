# pi-prune-chunks

**Keep the clue. Park the wall of text. Restore it when you need it.**

`pi-prune-chunks` is a Pi extension that keeps long coding sessions usable by
turning old, bulky tool output into small, restorable markers. The transcript is
left alone. Only the provider-bound context is cleaned up before the next model
call.

It is built for the failure mode every agent harness eventually hits: searches,
file reads, test logs, ReamerX packs, shell output, subagent results, and diffs
pile up until the model is staring at yesterday's noise instead of today's task.

## What it looks like

A long search result is useful once. Ten turns later it is usually clutter.

Before pruning, the model keeps carrying the full result:

```text
ffgrep "renderPressure"
  src/render.ts:120 ...
  src/render.ts:121 ...
  src/render.ts:122 ...
  ... hundreds of lines of matches and context ...
```

After pruning, Pi sends the model the card instead:

```text
[pruned:pc_0007_a91c2f search/ffgrep "renderPressure" ~1800t
 card="search returned 2 top paths | evidence: src/render.ts; index.ts |
 restore when: need full snippets"
 restore="restore_chunks({ids:['pc_0007_a91c2f']})"]
```

If the agent needs the exact lines again:

```ts
restore_chunks({ ids: ["pc_0007_a91c2f"] })
```

The saved Pi transcript still contains the original tool result. The tombstone is
only what the model sees in future provider calls.

## Current capability

This extension currently:

- tracks large tool results from file reads, searches, shell commands, test runs,
  diffs, ReamerX/FlowTrace-style context packs, outlines, symbols, and generic
  tools;
- assigns stable IDs, source anchors, risk labels, token estimates, and compact
  decision cards, with optional config-gated model-assisted card responses;
- manually prunes, restores, pins, and unpins chunks by ID;
- auto-prunes safe old chunks when context pressure crosses a configured band;
- prunes superseded or duplicate results as new evidence arrives;
- prunes zero-match searches immediately when configured;
- restores exact content from same-session memory, optional durable disk cache,
  or source-file rehydration when path/range metadata is available;
- splits very large results into child parts such as `#bulk` so the bulky tail can
  be pruned while the high-signal prefix stays visible;
- protects high-risk chunks, pins, recent restores, active modified paths,
  chunks referenced by the latest working context, and active reasoning anchors
  such as issue IDs, test names, commands, and error signatures;
- has named profiles for `local-32k`, `local-64k`, `cloud-200k`, `cloud-1m`,
  `privacy-max`, `research-heavy`, `coding-heavy`, and `debug-failures`;
- compacts tombstones at high pressure and coalesces many old tombstones into a
  single manifest when message overhead becomes the problem;
- tags chunks as `main`, `subagent`, or `chain` when Pi supplies scope metadata;
- cleans up exploratory ReamerX output after terminal evidence such as an
  edit-pack, slice, or change report is collected;
- emits pressure and telemetry reports without storing raw output in telemetry;
- prepares a continuation manifest near compaction pressure with a compact task
  state summary so failures, diffs, modified paths, protected chunks, and restore
  hints survive a resume;
- compacts oversized failed-tool validation payloads and large tool-input echoes
  in provider context so a bad or bulky tool call does not poison the next call
  with a giant argument block.

## Install

```bash
pi --extension /path/to/pi-prune-chunks
```

Or in Pi settings:

```json
{
  "extensions": ["/path/to/pi-prune-chunks"]
}
```

The default profile is `coding-heavy`: conservative enough for normal coding,
but active before the session reaches emergency compaction.

## Use it in a session

See what is taking space:

```ts
context_pressure()
list_context_chunks({ sortBy: "tokens", limit: 10 })
```

Prune the obvious bulk:

```ts
prune_chunks({ ids: ["pc_0007_a91c2f"], reason: "old search; top paths are enough" })
```

Keep something important nearby:

```ts
pin_chunks({ ids: ["pc_0012_deadbe"], reason: "current failing test log" })
```

Bring content back:

```ts
restore_chunks({ ids: ["pc_0007_a91c2f"] })
```

Ask for an audit-friendly report:

```ts
context_report()
```

## Slash commands

| Command | What it shows or does |
| --- | --- |
| `/prune-status` | Current pressure, policy, continuation-manifest status |
| `/prune-largest --limit 20` | Biggest active chunks |
| `/prune-largest --scope subagent` | Biggest child-agent chunks |
| `/prune-suggest --limit 10` | Safe candidates without pruning |
| `/prune-now --target 45000 --dry-run` | Preview immediate safe pruning |
| `/prune-now` | Apply safe pruning now |
| `/prune-restore pc_0001_a1b2c3` | Restore one or more chunk IDs |
| `/prune-report --output prune-report.md` | Write a Markdown telemetry report |
| `/prune-profile` | Show available profiles |
| `/prune-profile local-32k` | Switch this live session to a tighter-window profile |
| `/prune-profile reset` | Return to configured/default profile |

## Bench snapshots

These are synthetic fixtures, not universal claims, but they show what the
current implementation is designed to protect against.

Policy replay:

```text
policy         modelProfile  pruned  savedTokens  activeTokens  prunedTokens
heuristic-v1   auto          2       3470         7880          3470
adaptive-v1    local-32k     2       3470         7880          3470
adaptive-v1    cloud-1m      1       1870         9480          1870
```

Durable restore after restart:

```text
Simulated pruned non-file chunks: 3
Simulated pruned tokens: ~14345
After restart without disk cache: 0/3 exact restores
After restart with disk cache:    3/3 exact restores (~1264t)
```

Tombstone-overhead regression fixture:

```text
Shape:           100 tracked, 95 pruned, 5 active
Observed class:  provider usage over-window while active chunks are tiny
Full tombstones: 6934 tokens across 95 messages
Compact stones:  1361 tokens across 95 messages
Manifest:        368 tokens across 1 message
```

Run the fixtures locally:

```bash
PATH=/opt/homebrew/bin:$PATH npm run bench:policy-compare
PATH=/opt/homebrew/bin:$PATH npm run bench:durable-store
PATH=/opt/homebrew/bin:$PATH npm run bench:context-savings
PATH=/opt/homebrew/bin:$PATH npm run bench:e2e-pruning
```

## Configuration

Most users should start with a profile:

```json
{
  "pruneChunks": {
    "profile": "coding-heavy"
  }
}
```

Tighter local model window:

```json
{
  "pruneChunks": {
    "profile": "local-32k"
  }
}
```

Research-heavy sessions can accept bounded, externally supplied model-assisted
card responses while still falling back to deterministic heuristic cards when no
valid response is provided:

```json
{
  "pruneChunks": {
    "profile": "research-heavy",
    "decisionCards": {
      "mode": "model-assisted",
      "maxModelInputTokens": 1800,
      "maxModelOutputChars": 1200
    }
  }
}
```

Maximum privacy, with raw tool output kept memory-only:

```json
{
  "pruneChunks": {
    "profile": "privacy-max"
  }
}
```

Override only what you need:

```json
{
  "pruneChunks": {
    "profile": "coding-heavy",
    "autoPrune": {
      "startAtPercent": 70,
      "targetPercent": 55,
      "maxChunksPerPass": 10
    },
    "restore": {
      "diskCache": {
        "enabled": true,
        "directory": "~/.pi/prune-chunks/cache",
        "maxBytes": 262144000,
        "maxAgeDays": 14,
        "maxBlobBytes": 26214400
      }
    }
  }
}
```

## Safety model

- **Non-destructive:** saved transcript history is not rewritten or deleted.
- **Restorable:** chunks can come back from memory, disk cache, or source ranges.
- **Conservative by default:** high-risk, pinned, recent, restored, and active
  working-context chunks are protected.
- **Transparent:** every pruned chunk leaves an ID, kind, token estimate, summary,
  source hints, and restore instruction unless pressure forces compact markers.
- **Scoped:** subagent and chain output can be listed and pruned separately when
  Pi supplies scope metadata.
- **Bounded:** if non-chunk tokens dominate the provider request, pressure reports
  say so instead of pretending chunk pruning can fix it.

## Influences and references

This project is an implementation experiment around ideas that are showing up in
Claude/Anthropic guidance, Arize agent-harness writing, and recent arXiv papers
on context management:

- Anthropic, **"Effective context engineering for AI agents"** — frames context
  as a scarce, actively curated resource rather than a passive prompt buffer.
  <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
- Claude, **"Using Claude Code: session management and 1M context"** — explains
  how tool calls, tool outputs, files, compaction, clearing, rewinding, and
  subagents shape long Claude Code sessions.
  <https://claude.com/blog/using-claude-code-session-management-and-1m-context>
- Anthropic docs, **Context editing / compaction** — documents clearing or
  compacting prior context while preserving task continuity.
  <https://platform.claude.com/docs/en/build-with-claude/context-editing>
- Arize, **"Context management in agent harnesses: memory, files, and
  subagents"** — describes harness-level choices around file reads, tool
  results, subagent output, memory, truncation, and retrieval.
  <https://arize.com/blog/context-management-in-agent-harnesses/>
- Lodha et al., **"Less Context, Better Agents: Efficient Context Engineering
  for Long-Horizon Tool-Using LLM Agents"** — evaluates pruning and summarizing
  tool interactions for long enterprise workflows.
  <https://arxiv.org/html/2606.10209v1>
- **"Optimizing Context Compression for Long-horizon LLM Agents"** — nearby
  research on compression strategies for long-running agents.
  <https://arxiv.org/html/2510.00615v1>
- **"Active Context Compression: Autonomous Memory Management in LLM Agents"** —
  nearby research on agents managing what to retain and compress.
  <https://arxiv.org/html/2601.07190v1>
- **"Escaping the Context Bottleneck: Active Context Curation for LLM Agents via
  Reinforcement Learning"** — nearby research on choosing context rather than
  blindly carrying full history.
  <https://arxiv.org/html/2604.11462v1>
- LangChain, **"Context Management for Deep Agents"** — practical discussion of
  trimming, summarizing, and separating long-horizon agent state.
  <https://www.langchain.com/blog/context-management-for-deepagents>

`pi-prune-chunks` does not claim to reproduce those systems or papers. Its narrow
bet is simpler: in Pi, bulky tool results should be addressable, auditable,
cheap to hide, and easy to restore.

## Development

```bash
PATH=/opt/homebrew/bin:$PATH npm run check
PATH=/opt/homebrew/bin:$PATH npm run pack:dry
```

## More docs

- [Architecture](docs/architecture.md)
- [Auto-prune policy](docs/auto-prune-policy.md)
- [Tool adapters](docs/tool-adapters.md)
- [Testing](docs/testing.md)
- [Failure modes](docs/failure-modes.md)
