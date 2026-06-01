# pi-prune-chunks Planning Brief

## Project Summary

`pi-prune-chunks` is a Pi coding-agent extension that reduces context-window pressure by tracking large tool-result payloads, replacing low-value historical content with compact tombstones before provider calls, and allowing the agent to restore pruned content when needed.

The core goal is not generic summarization. The core goal is **context garbage collection for restorable tool outputs**.

Pi already has compaction, but compaction happens after the conversation has grown too large and may cause degraded state, lost details, or continuation bugs. This extension should reduce how often Pi reaches dangerous compaction paths by pruning bulky, restorable context before every LLM call.

## Background and Motivation

Long agentic coding sessions accumulate large amounts of tool-result context:

* whole-file reads
* code search results
* code context packs
* flow traces
* test output
* shell output
* diff output
* repeated file snapshots
* PR bodies and generated markdown
* debugging logs

This causes several problems:

1. **Context overflow**

   * Requests can exceed the provider or local server context window.
   * Example failure pattern: request exceeds 65,536 tokens by a small margin.

2. **Excessive compaction**

   * The agent triggers automatic compaction frequently.
   * Compaction may erase useful detail or destabilize the session.

3. **Bad resume states**

   * Pi can sometimes compact into a state that cannot continue, such as:
     `Error: Cannot continue from message role: assistant`

4. **Degraded local-agent performance**

   * Local models with 32k–64k context are especially sensitive.
   * Large contexts slow prompt processing and increase failure rates.
   * Long irrelevant tool history distracts the model.

`pi-prune-chunks` should provide a finer-grained context management layer before compaction is needed.

## Product Vision

The extension should let Pi keep the full saved transcript intact while giving the provider a smaller, more useful context view.

The end state is:

> A Pi extension that automatically and safely reduces context pressure by turning old, restorable tool-result chunks into informative tombstones, while allowing the agent or user to list, prune, pin, restore, and inspect those chunks.

This should make long coding sessions more reliable, especially on local llama.cpp models with practical context limits.

## Core Principles

### 1. Non-destructive by default

Do not rewrite or delete Pi’s saved transcript entries.

Pruning should happen in the `context` hook, before provider calls, by modifying the copied message list sent to the model.

The original session history remains intact.

### 2. Restorable when possible

Pruned content should be recoverable during the same session.

For file-backed chunks, restore should ideally be possible by re-reading the original file range when exact content is no longer cached.

### 3. Tombstones, not silent deletion

Never remove content without leaving a compact marker.

The model should know that something was pruned, why it was pruned, approximately how large it was, and how to restore it.

Example tombstone:

```text
[pruned:abc123 code_read_range "compiler/opcodes.go:120-220" ~3100t
 summary="opcode constants; BE64 collision with halt/nop"
 restore="restore_chunks({ids:['abc123']})"]
```

### 4. Agent-visible and policy-assisted

The agent should have tools to list, prune, restore, pin, and unpin chunks.

However, the extension should not rely entirely on the model remembering to prune. It should also support optional safe automatic pruning policies.

### 5. Preserve current working context

Do not prune recent, task-critical information.

Preserve:

* the latest user request
* the current plan
* recent tool failures
* current test errors
* current git diff summaries
* modified-file summaries
* explicitly pinned chunks
* recently restored chunks
* chunks referenced by the latest assistant response

### 6. Prefer pruning restorable, stale, bulky content

Good pruning candidates:

* old search results
* old code context packs
* old successful test output
* repeated reads of files that can be re-read
* old flow traces
* old shell output
* large output already summarized
* stale file snapshots

Bad pruning candidates:

* current failing test output
* recent error stack traces
* current user instructions
* current TODO list
* PR/commit constraints
* modified code not yet summarized
* chunks explicitly pinned by user or agent

## Target Users

Primary target:

* Developers using Pi for long-running local agentic coding sessions.
* Developers running local llama.cpp models with 32k–64k practical context.
* Users who rely on code search, file reads, Reamer, FlowTrace, or similar code-intelligence tools.

Secondary target:

* Cloud-model Pi users who want cheaper/faster long sessions.
* Extension authors building high-volume tool integrations.
* Users debugging compaction and context overflow issues.

## Explicit Non-goals

This project should not initially try to:

* replace Pi’s built-in compaction
* summarize entire conversations
* become a general memory system
* implement semantic retrieval over the whole repo
* modify saved transcript history destructively
* decide code correctness
* compress arbitrary assistant reasoning
* solve every context problem automatically

The MVP should focus on **tool-result chunk pruning**.

## Desired End State

At completion, a user should be able to run Pi with the extension and experience the following:

1. Long sessions accumulate fewer provider-context tokens.
2. Large old tool outputs are automatically tombstoned when context pressure grows.
3. The agent can inspect context usage with a tool or command.
4. The agent can restore pruned chunks when needed.
5. The transcript remains auditable.
6. Pi compaction happens less often.
7. Context overflow errors become rarer.
8. Assistant-role resume failures become rarer because risky compaction paths are avoided.
9. The user can see what was pruned and why.
10. The extension works safely with both local and cloud models.

## MVP Scope

The MVP should implement:

### Hooks

* `tool_result` hook

  * Observe tool results.
  * Detect large, useful-to-track outputs.
  * Register chunk metadata.
  * Optionally summarize or label the chunk.
  * Preserve original content in memory.

* `context` hook

  * Before each LLM call, replace pruned chunk content with tombstones.
  * Optionally auto-prune low-risk chunks when token pressure exceeds threshold.
  * Never mutate saved transcript entries directly.

### Tools

* `list_context_chunks`
* `prune_chunks`
* `restore_chunks`
* `pin_chunks`
* `unpin_chunks`
* optional: `context_pressure`

### Commands

* `/prune-status`
* `/prune-largest`
* `/prune-suggest`
* `/prune-now`
* optional: `/prune-restore <id>`

### Tracked Initial Tool Families

Track generic Pi outputs first, then Reamer/FlowTrace-specific outputs.

Initial generic categories:

* file read results
* code search results
* shell command output
* test output
* git diff output
* code outline/context results

Initial Reamer/FlowTrace tools:

* `code_context`
* `code_search`
* `code_search_symbols`
* `code_read_range`
* `code_read_symbol`
* `code_outline`
* `code_related`
* `code_pattern_search`
* `code_semantic_search`
* `code_flow_trace`
* `flow_trace`
* `flow_path`
* `flow_impact`

## Proposed Architecture

The extension should be split into four layers.

### 1. Collector

Responsible for observing tool results and extracting chunks.

Responsibilities:

* identify trackable tool results
* estimate token count
* infer labels
* infer source location when possible
* classify chunk kind
* store original content in memory
* persist metadata when appropriate

### 2. Registry

Responsible for chunk state.

Responsibilities:

* assign stable chunk IDs
* store metadata
* track prune state
* track pin state
* track restore availability
* track source rehydration information
* track reasons/audit events
* expose query operations

### 3. Pruner

Responsible for deciding what becomes a tombstone.

Responsibilities:

* apply explicit prune requests
* apply optional auto-prune policy
* avoid high-risk chunks
* preserve recent chunks
* preserve pinned chunks
* target a configured context-token budget
* produce tombstone replacements

### 4. Restorer

Responsible for bringing content back.

Responsibilities:

* restore exact in-memory content during the same session
* optionally restore from disk cache
* optionally rehydrate file-backed chunks from source files
* report when exact restore is impossible
* update audit trail

## Data Model

Suggested TypeScript model:

```ts
export type ChunkKind =
  | "file_read"
  | "search"
  | "flow_trace"
  | "context_pack"
  | "shell"
  | "test_output"
  | "diff"
  | "outline"
  | "symbol"
  | "other";

export type ChunkRisk = "low" | "medium" | "high";

export type RestoreMode =
  | "memory"
  | "disk_cache"
  | "source_rehydrate"
  | "unavailable";

export interface ChunkSource {
  path?: string;
  startLine?: number;
  endLine?: number;
  symbol?: string;
  command?: string;
  toolCallId?: string;
  contentHash?: string;
  mtimeMs?: number;
}

export interface ContextChunk {
  id: string;
  toolName: string;
  label: string;
  kind: ChunkKind;
  risk: ChunkRisk;
  tokenEstimate: number;
  createdAt: number;
  updatedAt: number;
  lastSeenAt?: number;
  lastRestoredAt?: number;
  pruned: boolean;
  pinned: boolean;
  pruneReason?: string;
  summary?: string;
  source?: ChunkSource;
  restoreMode: RestoreMode;
  restoreAvailable: boolean;
}
```

In-memory content cache:

```ts
export interface ChunkContentCache {
  get(id: string): string | undefined;
  set(id: string, content: string): void;
  delete(id: string): void;
  has(id: string): boolean;
}
```

Audit event:

```ts
export interface ChunkAuditEvent {
  id: string;
  chunkId: string;
  action: "tracked" | "pruned" | "restored" | "pinned" | "unpinned" | "auto_pruned" | "rehydrated";
  reason?: string;
  timestamp: number;
}
```

## Chunk ID Strategy

Chunk IDs should be:

* stable within a session
* short enough for model use
* collision-resistant enough for repeated tool outputs

Suggested format:

```text
pc_<base36 counter>_<short hash>
```

Example:

```text
pc_00af_91c2d7
```

Do not rely only on array indexes because chunks may be restored, rehydrated, or loaded from persisted state.

## Tombstone Format

Tombstones should be compact but useful.

Base format:

```text
[pruned:<id> <toolName> "<label>" ~<tokenEstimate>t — use restore_chunks to recover]
```

Preferred richer format:

```text
[pruned:<id> <kind>/<toolName> "<label>" ~<tokenEstimate>t
 summary="<short summary>"
 restore="restore_chunks({ids:['<id>']})"]
```

Constraints:

* Keep tombstones short.
* Avoid multi-paragraph tombstones.
* Include enough information to avoid unnecessary restore calls.
* Include source location when available.
* Avoid leaking huge summaries back into context.

## Tool Specifications

### list_context_chunks

Purpose:

List tracked chunks with metadata so the agent can decide what to prune or restore.

Input:

```ts
{
  toolName?: string;
  kind?: ChunkKind;
  pruned?: boolean;
  pinned?: boolean;
  minTokens?: number;
  limit?: number;
  sortBy?: "tokens" | "age" | "recent" | "risk";
}
```

Output should include:

* id
* label
* toolName
* kind
* tokenEstimate
* pruned
* pinned
* restoreAvailable
* summary
* source when available

### prune_chunks

Purpose:

Prune one or more chunks by ID.

Input:

```ts
{
  ids: string[];
  reason?: string;
}
```

Behavior:

* Mark chunks as pruned.
* Do not delete original content from in-memory cache.
* Persist pruned state.
* Return token estimate saved.
* Return skipped IDs with reasons.

### restore_chunks

Purpose:

Restore pruned chunks.

Input:

```ts
{
  ids: string[];
}
```

Behavior:

* If memory content exists, unprune.
* If disk cache exists, load and unprune.
* If source rehydrate exists, attempt source re-read and unprune.
* If unavailable, report clear failure.

### pin_chunks

Purpose:

Prevent chunks from being auto-pruned.

Input:

```ts
{
  ids: string[];
  reason?: string;
}
```

### unpin_chunks

Purpose:

Allow previously pinned chunks to be pruned.

Input:

```ts
{
  ids: string[];
}
```

### context_pressure

Purpose:

Return current known context pressure summary.

Output should include:

* estimated active chunk tokens
* estimated pruned tokens
* largest unpruned chunks
* auto-prune status
* configured thresholds
* recommended prune candidates

## Command Specifications

### /prune-status

Show:

* total tracked chunks
* pruned chunks
* pinned chunks
* estimated tokens tracked
* estimated tokens currently saved
* top five largest chunks
* auto-prune policy status

### /prune-largest

Show largest unpruned chunks.

Options:

```text
/prune-largest
/prune-largest --limit 20
/prune-largest --kind search
```

### /prune-suggest

Show recommended prune candidates without pruning.

### /prune-now

Apply safe auto-pruning immediately.

Options:

```text
/prune-now
/prune-now --target 45000
/prune-now --dry-run
```

## Auto-pruning Policy

Auto-pruning should be optional, but enabled by default once stable.

Suggested configuration:

```json
{
  "autoPrune": {
    "enabled": true,
    "startAtPercent": 70,
    "targetPercent": 55,
    "preserveRecentChunks": 5,
    "preserveRecentMinutes": 10,
    "minChunkTokens": 500,
    "maxChunksPerPass": 10
  }
}
```

Default behavior:

1. Estimate context pressure before provider call.
2. If below threshold, do nothing.
3. If above threshold, score candidate chunks.
4. Prune low-risk chunks until the target is met or no safe candidates remain.
5. Leave tombstones.
6. Record audit events.

Candidate score should consider:

* token size
* age
* recency
* chunk kind
* restore availability
* whether summarized
* whether pinned
* risk
* whether the chunk comes from a file that can be re-read
* whether it appears related to the current user request

Example scoring direction:

```text
higher prune priority:
  old + large + low-risk + restorable + search/context/trace

lower prune priority:
  recent + error/test failure + pinned + current diff + unavailable restore
```

## Risk Classification

### Low risk

Safe to prune automatically.

Examples:

* old search results
* old successful test logs
* old file reads with source path and line range
* old code outlines
* old flow traces already summarized
* repeated command outputs

### Medium risk

Can prune if pressure is high.

Examples:

* large file reads without line ranges
* old diffs
* old shell output from debugging
* generated markdown drafts
* context packs from relevant modules

### High risk

Do not auto-prune.

Examples:

* latest failing test output
* current user instructions
* current assistant plan
* current git status
* latest diff summary
* active PR/commit instructions
* chunks pinned by user/agent
* chunks restored recently

## Persistence Strategy

MVP persistence:

* Persist chunk metadata and pruned/pinned state using Pi extension persistence APIs.
* Keep original content in memory only.
* Restore exact content only during the same process/session.

Improved persistence:

* Optional local disk cache.
* Store content by hash.
* Keep cache under project `.pi/prune-chunks/cache` or user cache directory.
* Allow user to disable disk cache.
* Consider privacy implications before enabling by default.

Best future persistence:

* For file-backed chunks, store source metadata:

  * path
  * line range
  * symbol name
  * content hash
  * mtime
* On restore, if memory content is missing:

  * verify file still exists
  * verify hash/mtime if available
  * re-read range
  * warn if file changed

## Configuration

Suggested config shape:

```json
{
  "pruneChunks": {
    "enabled": true,
    "trackTools": ["*"],
    "autoPrune": {
      "enabled": true,
      "startAtPercent": 70,
      "targetPercent": 55,
      "preserveRecentChunks": 5,
      "preserveRecentMinutes": 10,
      "minChunkTokens": 500,
      "maxChunksPerPass": 10
    },
    "tombstones": {
      "includeSummary": true,
      "includeRestoreHint": true,
      "maxSummaryChars": 180
    },
    "restore": {
      "memory": true,
      "diskCache": false,
      "sourceRehydrate": true
    },
    "debug": false
  }
}
```

## Extension Behavior Examples

### Example 1: Old file read pruned

Original tool output:

```text
read compiler/opcodes.go
<4000 tokens of file content>
```

Tombstone:

```text
[pruned:pc_001a_a91d file_read/code_read_range "compiler/opcodes.go:1-240" ~4000t
 summary="opcode constants and BE64 read opcode definitions"
 restore="restore_chunks({ids:['pc_001a_a91d']})"]
```

### Example 2: Old successful test output pruned

Original:

```text
go test ./...
ok package/a
ok package/b
...
```

Tombstone:

```text
[pruned:pc_001f_b02e test_output/bash "go test ./..." ~2800t
 summary="successful full test run; no failures"
 restore="restore_chunks({ids:['pc_001f_b02e']})"]
```

### Example 3: Current failure preserved

Current failing test output should not be auto-pruned:

```text
FAIL: TestParseAnonymousStrings
expected offset 12, got 10
...
```

Reason:

* recent
* error-bearing
* likely task-critical

## Testing Strategy

### Unit Tests

Test:

* token estimation
* chunk ID generation
* chunk extraction per tool type
* prune state transitions
* restore state transitions
* pin/unpin behavior
* tombstone rendering
* auto-prune scoring
* auto-prune threshold behavior
* high-risk preservation
* persistence serialization
* persistence restoration

### Integration Tests

Test with mocked Pi hooks:

1. `tool_result` captures large output.
2. `context` replaces pruned content with tombstone.
3. Saved transcript remains unchanged.
4. `restore_chunks` unprunes same-session content.
5. Auto-prune activates at threshold.
6. Pinned chunks are preserved.
7. Recent error chunks are preserved.
8. Disk/source rehydrate path works when implemented.

### Dogfood Tests

Use real Pi sessions against a repository with:

* many file reads
* repeated test runs
* large search results
* flow traces
* PR creation workflow

Success criteria:

* fewer automatic compactions
* no context overflow
* no assistant-role continuation crash
* agent can restore pruned content when needed
* PR/task completes correctly

### Regression Tests for Known Failure Mode

Create a scripted or semi-scripted session that previously produced:

```text
[compaction]
Compacted from 50,449 tokens
Error: Cannot continue from message role: assistant
```

Run with extension enabled.

Expected result:

* extension prunes old tool chunks before Pi compaction
* session remains below configured pressure target
* no assistant-role continuation failure
* task completes or reaches a clean manual handoff point

## Quality Gates

Before claiming MVP complete:

```bash
npm install
npm run check
npm test
npm run pack:dry
```

Expected quality gates:

* TypeScript strict mode passes.
* Lint passes.
* Unit tests pass.
* Integration tests pass.
* Package contents are minimal and correct.
* README includes examples.
* Extension can be installed via:
  `pi --extension /path/to/pi-prune-chunks`
* Extension can be configured via settings.
* Failure modes are documented.

## Documentation Requirements

README should include:

1. What problem it solves.
2. Why Pi compaction alone is not enough.
3. Installation.
4. Configuration.
5. Tools.
6. Commands.
7. Safety model.
8. Restore limitations.
9. Examples.
10. Known limitations.

Also include:

* `docs/architecture.md`
* `docs/auto-prune-policy.md`
* `docs/tool-adapters.md`
* `docs/testing.md`
* `docs/failure-modes.md`

## First Implementation Plan

### Phase 0: Repo orientation

Agent should inspect:

* existing package structure
* `package.json`
* TypeScript config
* tests
* extension entry point
* Pi extension API usage
* current README
* any abandoned implementation code

Commands:

```bash
git status --short
find . -maxdepth 3 -type f | sort
cat package.json
find src test tests -type f 2>/dev/null | sort
```

Do not read every file blindly. Use targeted reads.

### Phase 1: Minimal chunk registry

Implement:

* `ContextChunk` type
* in-memory registry
* chunk ID generation
* add/list/update operations
* prune/restore/pin state transitions
* token estimate field

Tests:

* create chunks
* list chunks
* prune chunks
* restore chunks
* pin chunks

### Phase 2: Tombstone renderer

Implement:

* compact tombstone rendering
* summary length cap
* source-aware labels
* restore hint

Tests:

* tombstone contains id, label, tool, token estimate
* long summaries are capped
* source info appears when available

### Phase 3: Tool-result collector

Implement:

* generic collector for large string outputs
* adapter interface
* initial adapters for:

  * file reads
  * shell output
  * search results
  * Reamer/FlowTrace known tool names

Tests:

* captures trackable result
* ignores tiny result
* labels known tools correctly
* estimates token count

### Phase 4: Context hook pruning

Implement:

* context hook walks copied messages
* identifies tracked tool outputs
* replaces pruned chunks with tombstones
* does not mutate original saved transcript

Tests:

* pruned content replaced
* unpruned content preserved
* original entry object remains unchanged if possible
* multiple chunks in one message handled correctly

### Phase 5: Custom tools

Implement:

* `list_context_chunks`
* `prune_chunks`
* `restore_chunks`
* `pin_chunks`
* `unpin_chunks`

Tests:

* schemas validate
* tools return useful summaries
* invalid IDs handled
* restore unavailable handled

### Phase 6: Commands

Implement:

* `/prune-status`
* `/prune-largest`
* `/prune-suggest`
* `/prune-now`

Tests:

* command output stable
* largest chunks sorted correctly
* dry run works

### Phase 7: Auto-prune policy

Implement:

* config parsing
* pressure estimation
* scoring
* threshold trigger
* target pruning
* preserve rules

Tests:

* below threshold does nothing
* above threshold prunes low-risk chunks
* pinned chunks preserved
* recent chunks preserved
* high-risk chunks preserved
* target percent respected when possible

### Phase 8: Persistence

Implement MVP persistence:

* pruned state
* pinned state
* metadata
* audit events

Optional:

* disk cache
* source rehydrate

Tests:

* reload metadata
* pruned state retained
* unavailable restore reported clearly

### Phase 9: Dogfood and hardening

Run against real coding sessions.

Measure:

* number of compactions
* max context usage
* number of pruned chunks
* estimated tokens saved
* successful restores
* failed restores
* task completion
* model confusion caused by tombstones

Fix:

* noisy tombstones
* bad auto-prune candidates
* missing adapters
* poor labels
* restore failures
* excessive tool overhead

## Agent Instructions for Building This Project

When working on this repository:

1. Do not read large files blindly.
2. Use `rg`, `sed -n`, and targeted reads.
3. Keep context summaries short.
4. Run tests after each meaningful change.
5. Prefer small commits.
6. Maintain backward compatibility with Pi extension APIs.
7. Do not destructively modify session transcripts.
8. Preserve privacy; do not persist raw tool outputs to disk unless explicitly configured.
9. Add tests before adding complicated policy logic.
10. Keep the MVP narrow.

## Suggested First Prompt for an LLM Agent

Use this prompt to start implementation:

```text
We are building pi-prune-chunks, a Pi coding-agent extension for context garbage collection of large tool-result chunks.

Goal: implement an MVP that tracks large tool results, allows pruning/restoring by stable IDs, and replaces pruned content with tombstones in the context hook before provider calls without modifying the saved transcript.

Start by inspecting the repo structure with targeted commands only:
- git status --short
- find . -maxdepth 3 -type f | sort
- cat package.json
- find src test tests -type f 2>/dev/null | sort

Then produce a short implementation plan and begin with the chunk registry and tests.

Constraints:
- Do not read multiple whole files at once.
- Use targeted reads.
- Keep changes small.
- Run npm test or npm run check when appropriate.
- Preserve transcript integrity.
- Do not add auto-prune until manual list/prune/restore works.
```

## MVP Acceptance Criteria

The MVP is complete when:

1. The extension installs successfully.
2. Large tool outputs are tracked as chunks.
3. `list_context_chunks` shows tracked chunks with token estimates.
4. `prune_chunks` marks selected chunks as pruned.
5. The `context` hook replaces pruned content with tombstones before provider calls.
6. The saved transcript is not destructively modified.
7. `restore_chunks` restores same-session content.
8. `/prune-status` shows meaningful state.
9. Tests cover registry, tombstones, pruning, restoring, and context hook behavior.
10. A real Pi session can prune old tool results and continue without losing task state.

## Full End State Goals

The mature version should provide:

### Functional goals

* Track tool-result chunks from generic Pi tools and Reamer/FlowTrace tools.
* Estimate token impact of each chunk.
* Let agent/user list, prune, restore, pin, and unpin chunks.
* Apply tombstones in provider context only.
* Support optional safe auto-pruning.
* Persist metadata and prune/pin state.
* Restore exact content during same session.
* Rehydrate file-backed chunks when possible.
* Provide TUI commands for status, suggestions, and pruning.
* Produce audit trail of pruning actions.

### Reliability goals

* Reduce context overflow errors.
* Reduce automatic compaction frequency.
* Avoid assistant-tail compaction continuation failures by preventing risky context pressure.
* Never silently remove important current context.
* Never destroy the transcript.
* Fail safe when restore is impossible.
* Keep extension overhead low.

### Usability goals

* Agent can understand tombstones.
* User can inspect what was pruned.
* User can manually restore important chunks.
* Default settings are safe.
* Advanced users can tune thresholds.
* Documentation is clear enough for local-model users.

### Performance goals

* Context hook should be fast enough to run before every LLM call.
* Chunk lookup should be efficient.
* Token estimation should be approximate but cheap.
* Auto-prune should avoid expensive semantic analysis by default.
* Optional summaries should be bounded in size.

### Safety and privacy goals

* No raw tool-output disk persistence by default.
* Disk cache, if implemented, must be opt-in.
* Clearly document what is stored.
* Avoid persisting secrets from command output.
* Provide config to exclude tools, paths, or output patterns.

### Extensibility goals

* Adapter API for new tool types.
* Configurable prune policy.
* Configurable tombstone renderer.
* Future compatibility with MCP-style tools.
* Future compatibility with semantic summaries or embeddings, but no dependency on them for MVP.

## Potential Future Enhancements

After MVP:

1. Disk-backed restore cache.
2. Source rehydration for file ranges.
3. Semantic summaries for large chunks.
4. Chunk relevance scoring against current task.
5. Auto-pin chunks referenced by recent assistant messages.
6. Secret detection before optional disk cache.
7. Metrics export.
8. Provider-specific context budget profiles.
9. Interactive TUI chunk browser.
10. Integration with Pi compaction trigger to prune before compacting.
11. Repo-map mode that replaces old file reads with durable file summaries.
12. PR/session handoff generator using current unpruned state.

## Key Risks

### Risk: Auto-prune removes needed context

Mitigation:

* Start with manual pruning.
* Add conservative auto-prune.
* Preserve recent and high-risk chunks.
* Make restore easy.
* Include useful tombstone summaries.

### Risk: Tombstones confuse the model

Mitigation:

* Keep tombstone format consistent.
* Include restore instruction.
* Include short summary.
* Test with real agent sessions.

### Risk: Restore does not work after reload

Mitigation:

* Clearly document MVP limitation.
* Add source rehydrate for file reads.
* Add optional disk cache later.

### Risk: Token estimates are inaccurate

Mitigation:

* Use estimates only for ranking.
* Keep safety margins.
* Allow manual inspection.
* Consider provider tokenizer integration later.

### Risk: Extension itself adds too much context

Mitigation:

* Keep tool outputs concise.
* Cap list outputs.
* Do not emit large audit logs into context.
* Commands can show detailed info to user without forcing all detail into model context when possible.

## Final Direction

Build the project as a narrow, practical Pi extension:

> `pi-prune-chunks`: restorable context garbage collection for bulky tool results.

Do not try to solve all memory, retrieval, summarization, or compaction problems at once.

The first useful version should make this possible:

1. Agent reads lots of files/search results.
2. Context pressure grows.
3. Agent or policy prunes old bulky chunks.
4. Provider sees tombstones instead of massive stale outputs.
5. Agent restores only what it needs.
6. Session avoids compaction cliffs and continues reliably.

