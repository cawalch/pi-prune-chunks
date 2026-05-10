#!/usr/bin/env node
// bench/context-savings.ts — Simulate an agent session and measure pruning impact.

import { ChunkTracker, estimateTokens, tombstoneFor } from "../src/tracker";

const SIMULATED_RESULTS: Array<{ tool: string; text: string }> = [];

// Build realistic tool result sizes from actual reamer output
function addResult(tool: string, lines: string[]) {
  SIMULATED_RESULTS.push({ tool, text: lines.join("\n") });
}

addResult("code_context", [
  "src/indexer.ts:1-50",
  "import * as fs from 'node:fs';",
  "import * as path from 'node:path';",
  "import Database from 'better-sqlite3';",
  "// ... 50 lines of indexer setup including schema creation, migration logic,",
  "// prepared statements, and helper functions like estimateTokens, firstLine.",
]);

addResult("code_search_symbols", [
  "Found 5 symbols:",
  "1. indexFile [function] src/indexer.ts:800-850",
  "2. search [function] src/indexer.ts:1200-1280",
  "3. context [function] src/indexer.ts:1500-1600",
  "4. related [function] src/indexer.ts:1700-1750",
  "5. extractSymbols [function] src/indexer.ts:400-500",
]);

addResult("code_context", [
  "src/indexer.ts:400-500",
  "function extractSymbols(root: SgNode, lang: Lang): SymbolRow[] {",
  "  const out: SymbolRow[] = [];",
  "  for (const kind of symbolKinds(lang)) {",
  "    for (const node of root.findAll(kind)) {",
  "      const name = node.child(0)?.text ?? '';",
  "      out.push({ kind, name, start_line, end_line, signature });",
  "    }",
  "  }",
  "  return out;",
  "}",
]);

addResult("flow_trace", [
  "indexFile [function] src/indexer.ts:800",
  "├─ extractSymbols [function] src/indexer.ts:400",
  "├─ extractImports [function] src/indexer.ts:600",
  "│  └─ resolveImportPath [function] src/indexer.ts:1040",
  "│     ├─ resolveTsPathImport [function] src/indexer.ts:970",
  "│     ├─ resolvePackageImport [function] src/indexer.ts:1000",
  "│     └─ resolveGoImport [function] src/indexer.ts:1020",
  "├─ indexFileChunks [function] src/indexer.ts:2150",
  "└─ embedChunks [function] src/indexer.ts:2217",
]);

addResult("code_read_range", [
  "src/indexer.ts:800-850",
  "function indexFile(fileId, rp, lang, text, symbols) {",
  "  const fileLines = text.split(/\\r?\\n/);",
  "  const embeddedChunks = [];",
  "  const tx = this.db.transaction(() => {",
  "    for (let i = 0; i < fileLines.length; i += 80) {",
  "      const body = fileLines.slice(i, i + 100).join('\\n');",
  "      // ...",
  "    }",
  "  });",
  "  tx();",
  "  await this.embedChunks(embeddedChunks);",
  "}",
]);

addResult("code_context", [
  "src/tools.ts:1-60",
  "// Tool registration for pi extension",
  "import { Type } from 'typebox';",
  "pi.registerTool({",
  "  name: 'code_search_symbols',",
  "  description: 'Search indexed code symbols...',",
  "  parameters: Type.Object({ query: Type.String() }),",
  "  async execute(toolCallId, params, signal, onUpdate, ctx) { ... }",
  "});",
  "// ... 14 more tools registered",
]);

addResult("code_search", [
  "Results for 'resolveImportPath':",
  "",
  "src/indexer.ts:1040 — function resolveImportPath(cwd, fromFile, specifier, config)",
  "  const relative = resolveRelativeImport(cwd, fromFile, specifier);",
  "  if (relative) return resolvedImport(relative, 'relative');",
  "  ...",
  "",
  "src/indexer.ts:970 — function resolveTsPathImport(cwd, specifier, config)",
  "  for (const rule of config.tsPathRules) { ... }",
]);

addResult("code_context", [
  "src/indexer.ts:1200-1280",
  "function search(this: Engine, q: string, opts: SearchOpts) {",
  "  const terms = identifierWords(q);",
  "  const fts = this.stmts.searchFts.all(...);",
  "  const rows = fts.map(row => ({ ...row, snip: snippet(row, terms) }));",
  "  return rows.sort((a, b) => ftsRowScore(a, terms) - ftsRowScore(b, terms));",
  "}",
]);

addResult("code_context", [
  "src/indexer.ts:1500-1600",
  "async context(this: Engine, q: string, opts: ContextOpts) {",
  "  const retrieved = opts.retrieval === 'hybrid'",
  "    ? rrfMerge(ftsRows, await this.semanticSearch(q, opts), limit)",
  "    : ftsRows;",
  "  // ... deduplication, budget trimming, formatting",
  "  return { content: [{ type: 'text', text: output }], details: {} };",
  "}",
]);

addResult("code_context", [
  "src/indexer.ts:2217-2270",
  "private async embedChunks(chunks: EmbeddedChunk[]) {",
  "  if (!embeddingsEnabled(this.embeddingConfig) || !chunks.length) return;",
  "  const vectors = await this.embedTexts(chunks.map(c => c.text));",
  "  const ins = this.db.prepare('INSERT OR REPLACE INTO chunk_embeddings VALUES (?, ?)');",
  "  for (let i = 0; i < chunks.length; i++) {",
  "    ins.run(chunks[i].rowid, JSON.stringify(vectors[i]));",
  "  }",
  "}",
]);

addResult("code_search_symbols", [
  "Found 3 symbols:",
  "1. ftsRowScore [function] src/indexer.ts:1060",
  "2. rrfMerge [function] src/indexer.ts:614",
  "3. dedupeFtsRows [function] src/indexer.ts:1090",
]);

addResult("code_read_range", [
  "src/indexer.ts:614-640",
  "function rrfMerge(ftsRows, semanticRows, limit) {",
  "  const k = 60;",
  "  const byId = new Map();",
  "  const add = (rows) => {",
  "    rows.forEach((row, i) => {",
  "      const existing = byId.get(row.rowid);",
  "      const score = 1 / (k + i + 1);",
  "      byId.set(row.rowid, { row: existing?.row ?? row, score: (existing?.score ?? 0) + score });",
  "    });",
  "  };",
  "  add(ftsRows);",
  "  add(semanticRows);",
  "  return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, limit);",
  "}",
]);

addResult("code_context", [
  "tests/helpers.mjs:1-40",
  "import fs from 'node:fs';",
  "import os from 'node:os';",
  "import path from 'node:path';",
  "",
  "export async function startExtension(projectDir) {",
  "  const compiledDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reamer-test-'));",
  "  return { harness: { tools, handlers, commands }, compiledDir };",
  "}",
  "export async function waitForIndexed(harness, opts) { ... }",
  "export async function exec(tool, params) { ... }",
]);

addResult("flow_trace", [
  "search [function] src/indexer.ts:1200",
  "├─ ftsRowScore [function] src/indexer.ts:1060",
  "├─ snippet [function] src/indexer.ts:1080",
  "└─ identifierWords [function] src/indexer.ts:1040",
]);

addResult("code_context", [
  "src/indexer.ts:1700-1750",
  "function related(this: Engine, filePath: string, opts) {",
  "  const outline = this.outline(filePath);",
  "  const importers = this.stmts.importsForFile.all(filePath);",
  "  return { content: [{ type: 'text', text: output }], details: { outline, importers } };",
  "}",
]);

let idCounter = 0;
function nextId(): string {
  return `call_${++idCounter}`;
}

function simulate() {
  console.log("Simulating 50-tool-call agent session\n");

  // 1. No pruning baseline
  idCounter = 0;
  const trackerNoPrune = new ChunkTracker();
  const noPruneTokens: number[] = [];
  let noPruneCumulative = 0;

  for (let i = 0; i < 50; i++) {
    const result = SIMULATED_RESULTS[i % SIMULATED_RESULTS.length];
    const content = [{ type: "text" as const, text: result.text }];
    trackerNoPrune.catalogue(nextId(), result.tool, content);
    noPruneCumulative += estimateTokens(result.text);
    noPruneTokens.push(noPruneCumulative);
  }

  // 2. With pruning — prune chunks older than 10 tool calls
  idCounter = 0;
  const trackerPrune = new ChunkTracker();
  const pruneTokens: number[] = [];
  const catalogueHistory: string[] = [];
  const PRUNE_AGE = 10;

  for (let i = 0; i < 50; i++) {
    const result = SIMULATED_RESULTS[i % SIMULATED_RESULTS.length];
    const content = [{ type: "text" as const, text: result.text }];
    const id = nextId();
    trackerPrune.catalogue(id, result.tool, content);
    catalogueHistory.push(id);

    if (catalogueHistory.length > PRUNE_AGE) {
      const toPrune = catalogueHistory.slice(0, catalogueHistory.length - PRUNE_AGE);
      const alreadyPruned = trackerPrune.prunedIds();
      const fresh = toPrune.filter((x) => !alreadyPruned.has(x));
      if (fresh.length > 0) {
        trackerPrune.prune(fresh, `older than ${PRUNE_AGE} steps`);
      }
    }

    let contextTokens = 0;
    for (const chunkId of catalogueHistory) {
      const chunk = trackerPrune.get(chunkId);
      if (!chunk) continue;
      if (chunk.pruned) {
        contextTokens += estimateTokens(tombstoneFor(chunk)[0].text);
      } else {
        contextTokens += chunk.estTokens;
      }
    }
    pruneTokens.push(contextTokens);
  }

  // 3. Comparison table
  console.log("Step  No-Prune   Pruned   Saved    %Saved");
  console.log("----  ---------  -------  -------  ------");
  for (let i = 0; i < 50; i += 5) {
    const np = noPruneTokens[i];
    const pr = pruneTokens[i];
    const saved = np - pr;
    const pct = ((saved / np) * 100).toFixed(1);
    console.log(
      `${String(i + 1).padStart(4)}  ${String(np).padStart(9)}  ${String(pr).padStart(7)}  ${String(saved).padStart(7)}  ${pct.padStart(5)}%`,
    );
  }

  const finalNoPrune = noPruneTokens[49];
  const finalPruned = pruneTokens[49];
  const finalSaved = finalNoPrune - finalPruned;
  const finalPct = ((finalSaved / finalNoPrune) * 100).toFixed(1);

  console.log("\nFinal context state:");
  console.log(`  No-prune total:  ${finalNoPrune} tokens`);
  console.log(`  Pruned total:    ${finalPruned} tokens`);
  console.log(`  Saved:           ${finalSaved} tokens (${finalPct}%)`);
  console.log(`  Pruned chunks:   ${trackerPrune.prunedIds().size}`);
  console.log(
    `  Active chunks:   ${trackerPrune.list().totalChunks - trackerPrune.prunedIds().size}`,
  );

  const savings = noPruneTokens.map((np, i) => ((np - pruneTokens[i]) / np) * 100);
  console.log("\nSavings curve (every 10 steps):");
  for (let i = 9; i < 50; i += 10) {
    console.log(`  Step ${i + 1}: ${savings[i].toFixed(1)}% saved`);
  }
}

simulate();
