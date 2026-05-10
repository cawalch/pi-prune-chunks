#!/usr/bin/env node
// bench/scratchpad-value.ts — Compare tombstone-only vs scratchpad pruning strategies.
//
// Simulates realistic agent sessions to measure:
//   1. Token savings of scratchpad over tombstone-only
//   2. How scratchpad note size affects the savings curve
//   3. Whether the added complexity is justified

import { ChunkTracker, estimateTokens, tombstoneFor } from "../src/tracker";

// ---------------------------------------------------------------------------
// Simulated tool results (realistic sizes)
// ---------------------------------------------------------------------------

const SIMULATED_RESULTS: Array<{ tool: string; text: string; scratchNote: string }> = [];

function add(tool: string, lines: string[], note: string) {
  SIMULATED_RESULTS.push({ tool, text: lines.join("\n"), scratchNote: note });
}

// Each result has:
//   - text: the raw tool output (what the agent sees before pruning)
//   - scratchNote: a realistic compressed note the agent might write before pruning

add(
  "code_context",
  [
    "src/indexer.ts:1-50",
    "import * as fs from 'node:fs';",
    "import * as path from 'node:path';",
    "import Database from 'better-sqlite3';",
    "import { Schema, buildSchema } from './schema';",
    "",
    "const DB_PATH = path.join(os.homedir(), '.cache', 'reamer', 'index.db');",
    "",
    "export class Engine {",
    "  private db: Database.Database;",
    "  private stmts: PreparedStatements;",
    "  private embeddingConfig: EmbeddingConfig;",
    "",
    "  constructor(config?: Partial<EngineConfig>) {",
    "    this.db = new Database(DB_PATH);",
    "    this.db.pragma('journal_mode = WAL');",
    "    this.db.pragma('synchronous = NORMAL');",
    "    const schema = buildSchema(this.db);",
    "    this.stmts = prepareStatements(this.db, schema);",
    "    this.embeddingConfig = config?.embedding ?? defaultEmbeddingConfig();",
    "  }",
    "",
    "  // Indexing pipeline: file scan → parse → symbols → imports → chunks → embed",
    "  async indexDirectory(dir: string, opts?: IndexOpts): Promise<IndexStats> { ... }",
    "  async indexFile(rp: string, lang: Lang): Promise<void> { ... }",
    "",
    "  // Query tools",
    "  search(q: string, opts?: SearchOpts): SearchResult[] { ... }",
    "  async context(q: string, opts?: ContextOpts): Promise<ContextResult> { ... }",
    "  outline(file: string): SymbolRow[] { ... }",
    "  related(file: string): RelatedResult { ... }",
    "}",
    "",
    "// Helpers: estimateTokens, firstLine, identifierWords, snippet",
    "function estimateTokens(text: string): number { ... }",
  ],
  "Engine class: constructor opens WAL db, stmts, embeddingConfig. Methods: indexDirectory, indexFile, search, context, outline, related. Helpers: estimateTokens, firstLine, identifierWords, snippet.",
);

add(
  "code_search_symbols",
  [
    "Found 5 symbols matching 'index':",
    "",
    "1. indexFile [function] src/indexer.ts:800-850",
    "   async indexFile(rp: string, lang: Lang): Promise<void>",
    "   Main indexing entry point. Parses file, extracts symbols and imports, chunks content, embeds.",
    "",
    "2. indexFileChunks [function] src/indexer.ts:2150-2217",
    "   private indexFileChunks(fileId: number, text: string, lines: string[]): ChunkRow[]",
    "   Splits file into ~80-line overlapping chunks for embedding.",
    "",
    "3. indexDirectory [function] src/indexer.ts:700-760",
    "   async indexDirectory(dir: string, opts?: IndexOpts): Promise<IndexStats>",
    "   Walks directory, filters by extension, calls indexFile for each. Reports progress.",
    "",
    "4. reindexFile [function] src/indexer.ts:860-900",
    "   async reindexFile(rp: string): Promise<boolean>",
    "   Checks mtime hash, re-indexes if changed. Returns true if re-indexed.",
    "",
    "5. buildFileIndex [function] src/indexer.ts:680-700",
    "   buildFileIndex(dir: string): Map<string, FileEntry>",
    "   Recursively walks directory tree building file map with extensions and mtimes.",
  ],
  "5 symbols: indexFile (800, main entry), indexFileChunks (2150, ~80-line chunks), indexDirectory (700, walks dir), reindexFile (860, mtime check), buildFileIndex (680, file map).",
);

add(
  "flow_trace",
  [
    "indexFile [function] src/indexer.ts:800",
    "├─ extractSymbols [function] src/indexer.ts:400",
    "│  Uses tree-sitter AST to find declarations by kind (function, class, method, etc.)",
    "│  Returns SymbolRow[] with kind, name, start_line, end_line, signature",
    "├─ extractImports [function] src/indexer.ts:600",
    "│  └─ resolveImportPath [function] src/indexer.ts:1040",
    "│     Resolves bare specifiers: ts paths → package.json → relative",
    "│     ├─ resolveTsPathImport [function] src/indexer.ts:970",
    "│     │  Applies tsconfig paths rules (baseUrl + paths patterns)",
    "│     ├─ resolvePackageImport [function] src/indexer.ts:1000",
    "│     │  Looks up exports/imports in package.json, falls back to index",
    "│     └─ resolveGoImport [function] src/indexer.ts:1020",
    "│        Resolves Go module paths using go.mod and vendor directory",
    "├─ indexFileChunks [function] src/indexer.ts:2150",
    "│  Splits into overlapping ~80-line chunks, stores in file_chunks table",
    "└─ embedChunks [function] src/indexer.ts:2217",
    "   Batch embeds chunk text using configured embedding model, stores vectors",
  ],
  "indexFile call tree: extractSymbols (AST→SymbolRow[]) → extractImports → resolveImportPath (ts paths/package/relative) → indexFileChunks (~80-line overlap) → embedChunks (batch embed). Key fn resolveImportPath at :1040.",
);

add(
  "code_read_range",
  [
    "src/indexer.ts:800-850",
    "",
    "async indexFile(this: Engine, rp: string, lang: Lang): Promise<void> {",
    "  const fullPath = path.join(this.rootDir, rp);",
    "  const text = await fs.promises.readFile(fullPath, 'utf-8');",
    "  const fileLines = text.split(/\\r?\\n/);",
    "",
    "  // Phase 1: Parse and extract symbols",
    "  const parser = new Parser();",
    "  parser.setLanguage(langGrammar(lang));",
    "  const tree = parser.parse(text);",
    "  const symbols = extractSymbols(tree.rootNode, lang);",
    "",
    "  // Phase 2: Extract imports",
    "  const imports = extractImports(tree.rootNode, lang, rp, this.rootDir);",
    "",
    "  // Phase 3: Upsert file record",
    "  const fileId = this.stmts.upsertFile.run(rp, text.length, hashText(text)).lastInsertRowid;",
    "",
    "  // Phase 4: Clear old symbols/imports for this file",
    "  this.stmts.deleteFileSymbols.run(fileId);",
    "  this.stmts.deleteFileImports.run(fileId);",
    "",
    "  // Phase 5: Insert new symbols and imports in a transaction",
    "  const tx = this.db.transaction(() => {",
    "    for (const sym of symbols) {",
    "      this.stmts.insertSymbol.run(fileId, sym.kind, sym.name, sym.start_line, sym.end_line, sym.signature);",
    "    }",
    "    for (const imp of imports) {",
    "      this.stmts.insertImport.run(fileId, imp.specifier, imp.resolvedPath, imp.line);",
    "    }",
    "  });",
    "  tx();",
    "",
    "  // Phase 6: Chunk and embed",
    "  const chunks = this.indexFileChunks(fileId, text, fileLines);",
    "  await this.embedChunks(chunks);",
    "}",
  ],
  "indexFile: read file → parse (tree-sitter) → extractSymbols + extractImports → upsert file → transactional insert symbols+imports → indexFileChunks → embedChunks. 6-phase pipeline.",
);

add(
  "code_context",
  [
    "src/indexer.ts:400-500",
    "function extractSymbols(root: SgNode, lang: Lang): SymbolRow[] {",
    "  const out: SymbolRow[] = [];",
    "  const kinds = symbolKinds(lang);",
    "  // kinds maps language to tree-sitter node types:",
    "  //   TypeScript: function_declaration, class_declaration, method_definition, ...",
    "  //   Go: function_declaration, method_declaration, type_declaration, ...",
    "  //   Python: function_definition, class_definition, decorated_definition, ...",
    "",
    "  for (const kind of kinds) {",
    "    for (const node of root.findAll(kind)) {",
    "      const name = node.child(0)?.text ?? '';",
    "      const startLine = node.startPosition.row;",
    "      const endLine = node.endPosition.row;",
    "      const signature = extractSignature(node, lang);",
    "      out.push({ kind: kind as string, name, start_line: startLine, end_line: endLine, signature });",
    "    }",
    "  }",
    "  return out;",
    "}",
    "",
    "// symbolKinds returns the set of AST node types to search for a given language",
    "function symbolKinds(lang: Lang): string[] {",
    "  const KIND_MAP: Record<Lang, string[]> = {",
    "    typescript: ['function_declaration', 'class_declaration', 'method_definition', ...],",
    "    javascript: ['function_declaration', 'class_declaration', ...],",
    "    go: ['function_declaration', 'method_declaration', 'type_declaration', ...],",
    "    python: ['function_definition', 'class_definition', 'decorated_definition', ...],",
    "  };",
    "  return KIND_MAP[lang] ?? [];",
    "}",
  ],
  "extractSymbols: walks AST by language-specific node kinds (TS/Go/Python), extracts name/start/end/signature. symbolKinds maps lang→node types.",
);

add(
  "code_search",
  [
    "Results for 'resolveImportPath':",
    "",
    "━━━ src/indexer.ts:1040-1060 ━━━",
    "function resolveImportPath(cwd: string, fromFile: string, specifier: string, config: ProjectConfig): string | null {",
    "  // Try relative first",
    "  const relative = resolveRelativeImport(cwd, fromFile, specifier);",
    "  if (relative) return resolvedImport(relative, 'relative');",
    "",
    "  // Try TypeScript path aliases",
    "  const tsPath = resolveTsPathImport(cwd, specifier, config);",
    "  if (tsPath) return resolvedImport(tsPath, 'ts_path');",
    "",
    "  // Try package.json exports/imports",
    "  const pkg = resolvePackageImport(cwd, specifier, config);",
    "  if (pkg) return resolvedImport(pkg, 'package');",
    "",
    "  // Try Go module resolution (if go.mod present)",
    "  const goPath = resolveGoImport(cwd, specifier, config);",
    "  if (goPath) return resolvedImport(goPath, 'go_module');",
    "",
    "  return null; // Unresolvable",
    "}",
    "",
    "━━━ src/indexer.ts:970-1000 ━━━",
    "function resolveTsPathImport(cwd: string, specifier: string, config: ProjectConfig): string | null {",
    "  if (!config.tsPathRules?.length) return null;",
    "  for (const rule of config.tsPathRules) {",
    "    const match = specifier.match(rule.pattern);",
    "    if (match) {",
    "      const resolved = rule.targets.map(t => t.replace('*', match[1]));",
    "      for (const r of resolved) {",
    "        const fullPath = path.join(config.baseUrl, r);",
    "        if (fs.existsSync(fullPath)) return fullPath;",
    "      }",
    "    }",
    "  }",
    "  return null;",
    "}",
  ],
  "resolveImportPath (:1040): resolves in order: relative → ts path aliases → package.json exports → go module. Returns null if unresolvable. resolveTsPathImport (:970): applies tsconfig paths patterns with wildcard matching.",
);

add(
  "code_context",
  [
    "src/indexer.ts:1200-1280",
    "function search(this: Engine, q: string, opts: SearchOpts = {}): SearchResult[] {",
    "  const terms = identifierWords(q);",
    "  const limit = opts.limit ?? 20;",
    "",
    "  // FTS5 search with BM25 ranking",
    "  const fts = this.stmts.searchFts.all(terms.join(' '), limit * 2);",
    "",
    "  // Score and rank results",
    "  const rows = fts.map(row => ({",
    "    ...row,",
    "    snip: snippet(row.content, terms),",
    "    score: ftsRowScore(row, terms),",
    "  }));",
    "",
    "  return rows",
    "    .sort((a, b) => b.score - a.score)",
    "    .slice(0, limit);",
    "}",
    "",
    "// ftsRowScore computes a relevance score combining:",
    "//   - BM25 score from FTS5 (built-in)",
    "//   - Identifier match bonus (exact word match in name)",
    "//   - Symbol kind weighting (functions > variables > imports)",
    "function ftsRowScore(row: any, terms: string[]): number {",
    "  let score = row.rank ?? 0; // FTS5 BM25",
    "  for (const t of terms) {",
    "    if (row.name?.includes(t)) score += 2.0; // name match bonus",
    "    if (row.kind === 'function_declaration') score += 0.5;",
    "  }",
    "  return score;",
    "}",
  ],
  "search (:1200): FTS5 with BM25, limit*2 overfetch. Scoring: BM25 + identifier match bonus + symbol kind weighting (functions > vars). ftsRowScore: rank + name match +2 + function kind +0.5.",
);

add(
  "flow_trace",
  [
    "search [function] src/indexer.ts:1200",
    "├─ identifierWords [function] src/indexer.ts:1040",
    "│  Splits query into camelCase/snake_case words, filters stop words",
    "├─ ftsRowScore [function] src/indexer.ts:1060",
    "│  Combines BM25 + name match + kind weighting",
    "├─ snippet [function] src/indexer.ts:1080",
    "│  Extracts relevant lines around matched terms, bolds matches",
    "└─ searchFts (prepared statement)",
    "   FTS5 MATCH query with BM25 ranking built-in",
  ],
  "search tree: identifierWords (split camelCase/snake) → ftsRowScore (BM25+name+kind) → snippet (bold matches) → FTS5 MATCH stmt.",
);

add(
  "code_context",
  [
    "src/indexer.ts:1500-1600",
    "async context(this: Engine, q: string, opts: ContextOpts = {}): Promise<ContextResult> {",
    "  const limit = opts.limit ?? 5;",
    "  const budget = opts.budgetTokens ?? 2000;",
    "",
    "  // Step 1: Retrieve candidates",
    "  const ftsRows = this.search(q, { limit: limit * 3 });",
    "  let retrieved: SearchResult[];",
    "",
    "  if (opts.retrieval === 'hybrid') {",
    "    const semantic = await this.semanticSearch(q, { limit });",
    "    retrieved = rrfMerge(ftsRows, semantic, limit);",
    "  } else {",
    "    retrieved = ftsRows.slice(0, limit);",
    "  }",
    "",
    "  // Step 2: Deduplicate by file+line range overlap",
    "  const deduped = dedupeFtsRows(retrieved);",
    "",
    "  // Step 3: Budget trimming — read code ranges, trim to fit",
    "  let usedTokens = 0;",
    "  const output: string[] = [];",
    "  for (const row of deduped) {",
    "    const range = this.readRange(row.file, row.start_line, row.end_line);",
    "    const tokens = estimateTokens(range);",
    "    if (usedTokens + tokens > budget) break;",
    "    usedTokens += tokens;",
    "    output.push(`${row.file}:${row.start_line}-${row.end_line}`, range);",
    "  }",
    "",
    "  return { content: [{ type: 'text', text: output.join('\\n') }], details: {} };",
    "}",
  ],
  "context (:1500): retrieve (FTS or hybrid FTS+semantic via rrfMerge) → dedupe (file+line overlap) → budget trim (estimateTokens, stop at budgetTokens). Default: 5 results, 2000 token budget.",
);

add(
  "code_search_symbols",
  [
    "Found 4 symbols matching 'rrf':",
    "",
    "1. rrfMerge [function] src/indexer.ts:614-640",
    "   rrfMerge(ftsRows: SearchResult[], semanticRows: SearchResult[], limit: number): SearchResult[]",
    "   Reciprocal Rank Fusion: merges FTS and semantic results using k=60 scoring.",
    "",
    "2. dedupeFtsRows [function] src/indexer.ts:1090-1110",
    "   dedupeFtsRows(rows: SearchResult[]): SearchResult[]",
    "   Removes overlapping file+line ranges, keeps highest scored.",
    "",
    "3. semanticSearch [function] src/indexer.ts:1900-1960",
    "   async semanticSearch(this: Engine, q: string, opts): Promise<SearchResult[]>",
    "   Embeds query, does nearest-neighbor search in chunk_embeddings table.",
    "",
    "4. readRange [function] src/indexer.ts:1600-1640",
    "   readRange(file: string, start: number, end: number): string",
    "   Reads source lines from file, returns formatted code block.",
  ],
  "4 symbols: rrfMerge (:614, RRF k=60), dedupeFtsRows (:1090, overlap removal), semanticSearch (:1900, embed+NN), readRange (:1600, source lines).",
);

// ---------------------------------------------------------------------------
// Tombstone + scratchpad formats
// ---------------------------------------------------------------------------

function tombstoneText(chunk: { id: string; toolName: string; label: string; estTokens: number }): string {
  return `[pruned:${chunk.id} ${chunk.toolName} "${chunk.label}" ~${chunk.estTokens}t — use restore_chunks to recover]`;
}

function scratchpadText(
  chunk: { id: string; toolName: string; label: string; estTokens: number },
  note: string,
): string {
  return `[pruned:${chunk.id} ${chunk.toolName} ~${chunk.estTokens}t — ${note}]`;
}

// ---------------------------------------------------------------------------
// Simulated chunk state
// ---------------------------------------------------------------------------

type SimChunk = {
  id: string;
  toolName: string;
  text: string;
  estTokens: number;
  label: string;
  scratchNote: string;
};

// ---------------------------------------------------------------------------
// Simulations
// ---------------------------------------------------------------------------

const PRUNE_AGE = 10; // Prune chunks older than 10 steps
const SESSION_LENGTH = 60;

function runSimulation() {
  console.log("=".repeat(80));
  console.log("SCRATCHPAD VALUE ANALYSIS — Simulated Agent Session");
  console.log("=".repeat(80));
  console.log(`Session: ${SESSION_LENGTH} tool calls, prune age: ${PRUNE_AGE} steps`);
  console.log(`Simulated tool results: ${SIMULATED_RESULTS.length} unique chunks`);
  console.log("");

  // Build chunk history
  let idCounter = 0;
  const history: SimChunk[] = [];

  for (let i = 0; i < SESSION_LENGTH; i++) {
    const result = SIMULATED_RESULTS[i % SIMULATED_RESULTS.length];
    history.push({
      id: `call_${++idCounter}`,
      toolName: result.tool,
      text: result.text,
      estTokens: estimateTokens(result.text),
      label: `${result.tool}: ${result.text.split("\n")[0]?.slice(0, 60) ?? ""}`,
      scratchNote: result.scratchNote,
    });
  }

  // --- Strategy 1: No pruning (baseline) ---
  const noPruneTokens: number[] = [];
  let noPruneCumulative = 0;
  for (let i = 0; i < SESSION_LENGTH; i++) {
    noPruneCumulative += history[i].estTokens;
    noPruneTokens.push(noPruneCumulative);
  }

  // --- Strategy 2: Tombstone-only pruning ---
  const tombstoneTokens: number[] = [];
  for (let i = 0; i < SESSION_LENGTH; i++) {
    let contextTokens = 0;
    for (let j = 0; j <= i; j++) {
      const age = i - j;
      if (age > PRUNE_AGE) {
        contextTokens += estimateTokens(tombstoneText(history[j]));
      } else {
        contextTokens += history[j].estTokens;
      }
    }
    tombstoneTokens.push(contextTokens);
  }

  // --- Strategy 3: Scratchpad pruning ---
  const scratchpadTokens: number[] = [];
  for (let i = 0; i < SESSION_LENGTH; i++) {
    let contextTokens = 0;
    for (let j = 0; j <= i; j++) {
      const age = i - j;
      if (age > PRUNE_AGE) {
        contextTokens += estimateTokens(scratchpadText(history[j], history[j].scratchNote));
      } else {
        contextTokens += history[j].estTokens;
      }
    }
    scratchpadTokens.push(contextTokens);
  }

  // --- Strategy 4: Scratchpad with aggressive compression (agent writes very terse notes) ---
  const scratchpadAggressiveTokens: number[] = [];
  for (let i = 0; i < SESSION_LENGTH; i++) {
    let contextTokens = 0;
    for (let j = 0; j <= i; j++) {
      const age = i - j;
      if (age > PRUNE_AGE) {
        // Aggressive: truncate note to 60 chars
        const terse = history[j].scratchNote.slice(0, 60);
        contextTokens += estimateTokens(scratchpadText(history[j], terse));
      } else {
        contextTokens += history[j].estTokens;
      }
    }
    scratchpadAggressiveTokens.push(contextTokens);
  }

  // ---------------------------------------------------------------------------
  // Analysis
  // ---------------------------------------------------------------------------

  console.log("─".repeat(80));
  console.log("STEP-BY-STEP COMPARISON (sampled every 5 steps)");
  console.log("─".repeat(80));
  console.log(
    "Step  │ No-Prune  │ Tombstone │ Scratch  │ Aggress. │ Δ(Tomb→Scr) │ Δ(Tomb→Aggr)",
  );
  console.log(
    "──────┼───────────┼───────────┼──────────┼─────────┼─────────────┼─────────────",
  );

  for (let i = 4; i < SESSION_LENGTH; i += 5) {
    const np = noPruneTokens[i];
    const ts = tombstoneTokens[i];
    const sp = scratchpadTokens[i];
    const ag = scratchpadAggressiveTokens[i];
    const deltaScratch = ts - sp;
    const deltaAggr = ts - ag;
    const pctScratch = ((deltaScratch / ts) * 100).toFixed(1);
    const pctAggr = ((deltaAggr / ts) * 100).toFixed(1);
    console.log(
      `${String(i + 1).padStart(5)} │ ${String(np).padStart(9)} │ ${String(ts).padStart(9)} │ ${String(sp).padStart(8)} │ ${String(ag).padStart(7)} │ ${`+${deltaScratch} (${pctScratch}%)`.padStart(11)} │ ${`+${deltaAggr} (${pctAggr}%)`.padStart(11)}`,
    );
  }

  // Final summary
  const finalNP = noPruneTokens[SESSION_LENGTH - 1];
  const finalTS = tombstoneTokens[SESSION_LENGTH - 1];
  const finalSP = scratchpadTokens[SESSION_LENGTH - 1];
  const finalAG = scratchpadAggressiveTokens[SESSION_LENGTH - 1];

  console.log("");
  console.log("=".repeat(80));
  console.log("FINAL CONTEXT STATE (end of session)");
  console.log("=".repeat(80));
  console.log(`  No-prune baseline:      ${String(finalNP).padStart(7)} tokens`);
  console.log(`  Tombstone-only:         ${String(finalTS).padStart(7)} tokens  (saved ${finalNP - finalTS} vs no-prune, ${(((finalNP - finalTS) / finalNP) * 100).toFixed(1)}%)`);
  console.log(`  Scratchpad:             ${String(finalSP).padStart(7)} tokens  (saved ${finalNP - finalSP} vs no-prune, ${(((finalNP - finalSP) / finalNP) * 100).toFixed(1)}%)`);
  console.log(`  Aggressive scratchpad:  ${String(finalAG).padStart(7)} tokens  (saved ${finalNP - finalAG} vs no-prune, ${(((finalNP - finalAG) / finalNP) * 100).toFixed(1)}%)`);
  console.log("");

  // The key metric: incremental savings of scratchpad over tombstone
  const incrementalSaved = finalTS - finalSP;
  const incrementalPct = ((incrementalSaved / finalTS) * 100).toFixed(1);
  const aggressiveSaved = finalTS - finalAG;
  const aggressivePct = ((aggressiveSaved / finalTS) * 100).toFixed(1);

  console.log("=".repeat(80));
  console.log("INCREMENTAL VALUE OF SCRATCHPAD OVER TOMBSTONE-ONLY");
  console.log("=".repeat(80));
  console.log(`  Full notes:      saves ${incrementalSaved} additional tokens (${incrementalPct}% less than tombstone-only)`);
  console.log(`  Aggressive (60c): saves ${aggressiveSaved} additional tokens (${aggressivePct}% less than tombstone-only)`);
  console.log("");

  // Per-chunk analysis: what does each strategy cost?
  console.log("=".repeat(80));
  console.log("PER-CHUNK SIZE ANALYSIS");
  console.log("=".repeat(80));
  console.log("");

  // Analyze the first few chunks that would be pruned
  const prunedChunks = history.slice(0, Math.min(5, history.length - PRUNE_AGE));
  console.log(
    "Chunk              │ Raw   │ Tombstone │ Scratch │ Aggressive │ Ratio",
  );
  console.log(
    "───────────────────┼───────┼───────────┼─────────┼────────────┼──────",
  );

  let totalRaw = 0;
  let totalTomb = 0;
  let totalScratch = 0;
  let totalAggr = 0;

  for (const chunk of prunedChunks) {
    const raw = chunk.estTokens;
    const tomb = estimateTokens(tombstoneText(chunk));
    const note = chunk.scratchNote;
    const scratch = estimateTokens(scratchpadText(chunk, note));
    const aggr = estimateTokens(scratchpadText(chunk, note.slice(0, 60)));

    totalRaw += raw;
    totalTomb += tomb;
    totalScratch += scratch;
    totalAggr += aggr;

    const ratio = (scratch / tomb).toFixed(2);
    console.log(
      `${chunk.id.padEnd(18)} │ ${String(raw).padStart(5)} │ ${String(tomb).padStart(9)} │ ${String(scratch).padStart(7)} │ ${String(aggr).padStart(10)} │ ${ratio}x`,
    );
  }

  console.log(
    "───────────────────┼───────┼───────────┼─────────┼────────────┼──────",
  );
  console.log(
    `${"TOTAL".padEnd(18)} │ ${String(totalRaw).padStart(5)} │ ${String(totalTomb).padStart(9)} │ ${String(totalScratch).padStart(7)} │ ${String(totalAggr).padStart(10)} │ ${(totalScratch / totalTomb).toFixed(2)}x`,
  );

  console.log("");
  console.log("Compression ratios:");
  console.log(`  Raw → Tombstone:        ${(totalTomb / totalRaw * 100).toFixed(1)}% of original`);
  console.log(`  Raw → Scratchpad:       ${(totalScratch / totalRaw * 100).toFixed(1)}% of original`);
  console.log(`  Raw → Aggressive:       ${(totalAggr / totalRaw * 100).toFixed(1)}% of original`);
  console.log(`  Tombstone → Scratchpad: ${((totalScratch - totalTomb) / totalTomb * 100).toFixed(1)}% larger than tombstone`);
  console.log("");

  // ---------------------------------------------------------------------------
  // LOE vs Value assessment
  // ---------------------------------------------------------------------------

  console.log("=".repeat(80));
  console.log("LOE vs VALUE ASSESSMENT");
  console.log("=".repeat(80));
  console.log("");

  const scratchLarger = totalScratch > totalTomb;
  const overheadPct = Math.abs((totalScratch - totalTomb) / totalTomb * 100).toFixed(1);

  if (scratchLarger) {
    console.log(`⚠️  SCRATCHPAD NOTES ARE ${overheadPct}% LARGER THAN TOMBSTONES`);
    console.log("");
    console.log("Root cause: The agent's scratchpad notes contain useful information");
    console.log("(function signatures, call trees, key findings) that makes them");
    console.log(`significantly longer than tombstones (~${totalScratch}t vs ~${totalTomb}t per chunk).`);
    console.log("");
    console.log("This means scratchpad pruning is COUNTERPRODUCTIVE — it uses more");
    console.log("tokens than tombstone-only pruning, defeating its own purpose.");
  } else {
    console.log(`✅ Scratchpad saves ${overheadPct}% over tombstones`);
  }

  console.log("");
  console.log("VERDICT:");
  console.log("");

  if (scratchLarger && Number(overheadPct) > 10) {
    console.log("  DO NOT IMPLEMENT scratchpad as currently specified.");
    console.log("");
    console.log("  The scratchpad's purpose is to save tokens by compressing raw text");
    console.log("  into compact notes. But in practice:");
    console.log("");
    console.log("  1. A useful scratchpad note (containing signatures, relationships,");
    console.log("     key findings) is LONGER than a tombstone by nature.");
    console.log("  2. The current tombstone format already provides id + tool + label,");
    console.log("     which is sufficient for the agent to know WHAT was pruned.");
    console.log("  3. If the agent needs the content, restore_chunks is available.");
    console.log("");
    console.log("  RECOMMENDATION: Close #5. The tombstone+restore pattern already");
    console.log("  provides the right tradeoff. Evidence fidelity is preserved by");
    console.log("  the binary keep-or-discard decision as the Chroma researchers intended.");
  } else {
    console.log("  WORTH IMPLEMENTING. The token savings justify the added complexity.");
  }

  console.log("");
  console.log("IMPLEMENTATION COST IF PURSUED:");
  console.log("  - Add scratchNote field to ToolChunk type");
  console.log("  - Add optional note param to prune_chunks tool");
  console.log("  - Modify tombstoneFor() to include note when present");
  console.log("  - Persist scratchpad content in appendEntry");
  console.log("  - Expose in list_context_chunks output");
  console.log("  - Update README and tests");
  console.log("  ESTIMATED: ~150 LOC, ~2-3 hours, 8-10 new tests");
  console.log("");
  console.log("RISK: The agent writes poor/verbose notes → scratchpad becomes a");
  console.log("net token consumer. Requires prompt engineering in tool descriptions");
  console.log("to teach the agent to write terse, useful notes. Hard to validate.");
}

runSimulation();
