#!/usr/bin/env node
// bench/code-scratchpad-value.ts
//
// Tests a fundamentally different scratchpad: instead of prose notes,
// uses STRUCTURED CODE REPRESENTATIONS as the scratchpad format.
//
// Motivated by:
//   - rtk: "signatures only (strips bodies)" — 60-90% token reduction
//   - distill MCP: AST-aware compression — up to 98% savings
//   - SWEzze (arxiv 2603.28119): skeleton compression — 6x ratio
//   - SWE-Pruner (arxiv 2601.16746): task-aware selective skimming
//
// The key insight: code has STRUCTURE that compresses differently than prose.
// A function body can be 50 lines, but its signature is 1 line.
// A type definition can be 20 lines, but its interface is 2 lines.
// A call tree can be 30 lines of trace output, but an adjacency list is 3 lines.

import { estimateTokens } from "../src/tracker";

// ---------------------------------------------------------------------------
// Simulated tool results with multiple compression strategies
// ---------------------------------------------------------------------------

type ChunkVariant = {
  raw: string;
  skeleton: string;       // signatures + types only (strip bodies)
  interface_: string;     // public interface / type stubs only
  adjacency: string;      // call graph as adjacency list
};

const CHUNKS: ChunkVariant[] = [
  {
    raw: `src/indexer.ts:1-50
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { Schema, buildSchema } from './schema';

const DB_PATH = path.join(os.homedir(), '.cache', 'reamer', 'index.db');

export class Engine {
  private db: Database.Database;
  private stmts: PreparedStatements;
  private embeddingConfig: EmbeddingConfig;

  constructor(config?: Partial<EngineConfig>) {
    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    const schema = buildSchema(this.db);
    this.stmts = prepareStatements(this.db, schema);
    this.embeddingConfig = config?.embedding ?? defaultEmbeddingConfig();
  }

  async indexDirectory(dir: string, opts?: IndexOpts): Promise<IndexStats> {
    // 30 lines of directory walking, file filtering, progress reporting
    const entries = walkDir(dir);
    const filtered = entries.filter(e => supportedExt(e));
    let indexed = 0, skipped = 0;
    for (const entry of filtered) {
      try {
        await this.indexFile(entry.relativePath, detectLang(entry));
        indexed++;
      } catch { skipped++; }
    }
    return { indexed, skipped, total: filtered.length };
  }

  async indexFile(rp: string, lang: Lang): Promise<void> {
    // 40 lines of parsing, symbol extraction, import resolution, chunking, embedding
  }

  search(q: string, opts?: SearchOpts): SearchResult[] {
    // 15 lines of FTS5 query, scoring, ranking
  }

  async context(q: string, opts?: ContextOpts): Promise<ContextResult> {
    // 20 lines of hybrid retrieval, dedup, budget trimming
  }

  outline(file: string): SymbolRow[] { /* 10 lines */ }
  related(file: string): RelatedResult { /* 8 lines */ }
}`,
    skeleton: `class Engine {
  private db, stmts, embeddingConfig
  constructor(config?: Partial<EngineConfig>)
  async indexDirectory(dir, opts?): Promise<IndexStats>
  async indexFile(rp, lang): Promise<void>
  search(q, opts?): SearchResult[]
  async context(q, opts?): Promise<ContextResult>
  outline(file): SymbolRow[]
  related(file): RelatedResult
}`,
    interface_: `Engine: indexDirectory, indexFile, search, context, outline, related`,
    adjacency: ``,
  },
  {
    raw: `src/indexer.ts:800-850
async indexFile(this: Engine, rp: string, lang: Lang): Promise<void> {
  const fullPath = path.join(this.rootDir, rp);
  const text = await fs.promises.readFile(fullPath, 'utf-8');
  const fileLines = text.split(/\\r?\\n/);

  // Phase 1: Parse and extract symbols
  const parser = new Parser();
  parser.setLanguage(langGrammar(lang));
  const tree = parser.parse(text);
  const symbols = extractSymbols(tree.rootNode, lang);

  // Phase 2: Extract imports
  const imports = extractImports(tree.rootNode, lang, rp, this.rootDir);

  // Phase 3: Upsert file record
  const fileId = this.stmts.upsertFile.run(rp, text.length, hashText(text)).lastInsertRowid;

  // Phase 4: Clear old symbols/imports for this file
  this.stmts.deleteFileSymbols.run(fileId);
  this.stmts.deleteFileImports.run(fileId);

  // Phase 5: Insert new symbols and imports in a transaction
  const tx = this.db.transaction(() => {
    for (const sym of symbols) {
      this.stmts.insertSymbol.run(fileId, sym.kind, sym.name, sym.start_line, sym.end_line, sym.signature);
    }
    for (const imp of imports) {
      this.stmts.insertImport.run(fileId, imp.specifier, imp.resolvedPath, imp.line);
    }
  });
  tx();

  // Phase 6: Chunk and embed
  const chunks = this.indexFileChunks(fileId, text, fileLines);
  await this.embedChunks(chunks);
}`,
    skeleton: `async indexFile(rp, lang): Promise<void>
  parse(tree-sitter) → extractSymbols + extractImports
  upsert file → tx(insert symbols, insert imports)
  indexFileChunks → embedChunks`,
    interface_: `indexFile(rp, lang): void — 6-phase pipeline: parse→symbols→imports→upsert→chunks→embed`,
    adjacency: `indexFile → extractSymbols, extractImports, indexFileChunks, embedChunks`,
  },
  {
    raw: `src/indexer.ts:400-500
function extractSymbols(root: SgNode, lang: Lang): SymbolRow[] {
  const out: SymbolRow[] = [];
  const kinds = symbolKinds(lang);
  // kinds maps language to tree-sitter node types:
  //   TypeScript: function_declaration, class_declaration, method_definition, ...
  //   Go: function_declaration, method_declaration, type_declaration, ...
  //   Python: function_definition, class_definition, decorated_definition, ...

  for (const kind of kinds) {
    for (const node of root.findAll(kind)) {
      const name = node.child(0)?.text ?? '';
      const startLine = node.startPosition.row;
      const endLine = node.endPosition.row;
      const signature = extractSignature(node, lang);
      out.push({ kind: kind as string, name, start_line: startLine, end_line: endLine, signature });
    }
  }
  return out;
}

function symbolKinds(lang: Lang): string[] {
  const KIND_MAP: Record<Lang, string[]> = {
    typescript: ['function_declaration', 'class_declaration', 'method_definition', ...],
    javascript: ['function_declaration', 'class_declaration', ...],
    go: ['function_declaration', 'method_declaration', 'type_declaration', ...],
    python: ['function_definition', 'class_definition', 'decorated_definition', ...],
  };
  return KIND_MAP[lang] ?? [];
}`,
    skeleton: `extractSymbols(root: SgNode, lang: Lang): SymbolRow[]
  walks AST by language-specific node kinds → {kind, name, start, end, signature}
symbolKinds(lang): string[] — maps lang→AST node types (TS/Go/Python)`,
    interface_: `extractSymbols(SgNode, Lang): SymbolRow[] — AST walk by lang node kinds`,
    adjacency: `extractSymbols → symbolKinds, extractSignature`,
  },
  {
    raw: `indexFile [function] src/indexer.ts:800
├─ extractSymbols [function] src/indexer.ts:400
│  Uses tree-sitter AST to find declarations by kind (function, class, method, etc.)
│  Returns SymbolRow[] with kind, name, start_line, end_line, signature
├─ extractImports [function] src/indexer.ts:600
│  └─ resolveImportPath [function] src/indexer.ts:1040
│     Resolves bare specifiers: ts paths → package.json → relative
│     ├─ resolveTsPathImport [function] src/indexer.ts:970
│     │  Applies tsconfig paths rules (baseUrl + paths patterns)
│     ├─ resolvePackageImport [function] src/indexer.ts:1000
│     │  Looks up exports/imports in package.json, falls back to index
│     └─ resolveGoImport [function] src/indexer.ts:1020
│        Resolves Go module paths using go.mod and vendor directory
├─ indexFileChunks [function] src/indexer.ts:2150
│  Splits into overlapping ~80-line chunks, stores in file_chunks table
└─ embedChunks [function] src/indexer.ts:2217
   Batch embeds chunk text using configured embedding model, stores vectors`,
    skeleton: ``,
    interface_: ``,
    adjacency: `indexFile → extractSymbols, extractImports→resolveImportPath→{resolveTsPath,resolvePackage,resolveGo}, indexFileChunks, embedChunks`,
  },
  {
    raw: `function search(this: Engine, q: string, opts: SearchOpts = {}): SearchResult[] {
  const terms = identifierWords(q);
  const limit = opts.limit ?? 20;

  // FTS5 search with BM25 ranking
  const fts = this.stmts.searchFts.all(terms.join(' '), limit * 2);

  // Score and rank results
  const rows = fts.map(row => ({
    ...row,
    snip: snippet(row.content, terms),
    score: ftsRowScore(row, terms),
  }));

  return rows
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function ftsRowScore(row: any, terms: string[]): number {
  let score = row.rank ?? 0;
  for (const t of terms) {
    if (row.name?.includes(t)) score += 2.0;
    if (row.kind === 'function_declaration') score += 0.5;
  }
  return score;
}`,
    skeleton: `search(q, opts?): SearchResult[]
  identifierWords → FTS5 BM25 → ftsRowScore → sort+slice
ftsRowScore(row, terms): number = BM25 + name_match(+2) + function_kind(+0.5)`,
    interface_: `search(q, opts?): SearchResult[] — FTS5 BM25 + custom scoring`,
    adjacency: `search → identifierWords, ftsRowScore, snippet`,
  },
  {
    raw: `async context(this: Engine, q: string, opts: ContextOpts = {}): Promise<ContextResult> {
  const limit = opts.limit ?? 5;
  const budget = opts.budgetTokens ?? 2000;

  const ftsRows = this.search(q, { limit: limit * 3 });
  let retrieved: SearchResult[];

  if (opts.retrieval === 'hybrid') {
    const semantic = await this.semanticSearch(q, { limit });
    retrieved = rrfMerge(ftsRows, semantic, limit);
  } else {
    retrieved = ftsRows.slice(0, limit);
  }

  const deduped = dedupeFtsRows(retrieved);

  let usedTokens = 0;
  const output: string[] = [];
  for (const row of deduped) {
    const range = this.readRange(row.file, row.start_line, row.end_line);
    const tokens = estimateTokens(range);
    if (usedTokens + tokens > budget) break;
    usedTokens += tokens;
    output.push(\`\${row.file}:\${row.start_line}-\${row.end_line}\`, range);
  }

  return { content: [{ type: 'text', text: output.join('\\n') }], details: {} };
}`,
    skeleton: `async context(q, opts?): Promise<ContextResult>
  search(limit*3) → [if hybrid: rrfMerge(fts, semantic)] → dedupeFtsRows → budget-trim loop → output
  defaults: limit=5, budget=2000t`,
    interface_: `context(q, opts?): ContextResult — FTS or hybrid retrieve → dedupe → budget trim`,
    adjacency: `context → search, semanticSearch, rrfMerge, dedupeFtsRows, readRange`,
  },
  {
    raw: `Found 5 symbols matching 'index':

1. indexFile [function] src/indexer.ts:800-850
   async indexFile(rp: string, lang: Lang): Promise<void>
   Main indexing entry point. Parses file, extracts symbols and imports, chunks content, embeds.

2. indexFileChunks [function] src/indexer.ts:2150-2217
   private indexFileChunks(fileId: number, text: string, lines: string[]): ChunkRow[]
   Splits file into ~80-line overlapping chunks for embedding.

3. indexDirectory [function] src/indexer.ts:700-760
   async indexDirectory(dir: string, opts?: IndexOpts): Promise<IndexStats>
   Walks directory, filters by extension, calls indexFile for each. Reports progress.

4. reindexFile [function] src/indexer.ts:860-900
   async reindexFile(rp: string): Promise<boolean>
   Checks mtime hash, re-indexes if changed. Returns true if re-indexed.

5. buildFileIndex [function] src/indexer.ts:680-700
   buildFileIndex(dir: string): Map<string, FileEntry>
   Recursively walks directory tree building file map with extensions and mtimes.`,
    skeleton: `5 symbols: indexFile(:800), indexFileChunks(:2150), indexDirectory(:700), reindexFile(:860), buildFileIndex(:680)`,
    interface_: `5 index* symbols: indexFile, indexFileChunks, indexDirectory, reindexFile, buildFileIndex`,
    adjacency: ``,
  },
  {
    raw: `function resolveImportPath(cwd: string, fromFile: string, specifier: string, config: ProjectConfig): string | null {
  const relative = resolveRelativeImport(cwd, fromFile, specifier);
  if (relative) return resolvedImport(relative, 'relative');
  const tsPath = resolveTsPathImport(cwd, specifier, config);
  if (tsPath) return resolvedImport(tsPath, 'ts_path');
  const pkg = resolvePackageImport(cwd, specifier, config);
  if (pkg) return resolvedImport(pkg, 'package');
  const goPath = resolveGoImport(cwd, specifier, config);
  if (goPath) return resolvedImport(goPath, 'go_module');
  return null;
}

function resolveTsPathImport(cwd: string, specifier: string, config: ProjectConfig): string | null {
  if (!config.tsPathRules?.length) return null;
  for (const rule of config.tsPathRules) {
    const match = specifier.match(rule.pattern);
    if (match) {
      const resolved = rule.targets.map(t => t.replace('*', match[1]));
      for (const r of resolved) {
        const fullPath = path.join(config.baseUrl, r);
        if (fs.existsSync(fullPath)) return fullPath;
      }
    }
  }
  return null;
}`,
    skeleton: `resolveImportPath(cwd, fromFile, specifier, config): string|null
  tries: relative → tsPath → package → goModule → null
resolveTsPathImport(cwd, specifier, config): string|null
  applies tsconfig paths rules, wildcard matching`,
    interface_: `resolveImportPath: relative→tsPath→package→go→null | resolveTsPathImport: tsconfig paths`,
    adjacency: `resolveImportPath → resolveRelative, resolveTsPath, resolvePackage, resolveGo`,
  },
];

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function tombstoneText(id: string, tool: string, tokens: number): string {
  return `[pruned:${id} ${tool} ~${tokens}t]`;
}

function skeletonText(id: string, skeleton: string): string {
  return skeleton ? `[skel:${id}] ${skeleton}` : tombstoneText(id, "unknown", 0);
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

const SESSION_LENGTH = 60;
const PRUNE_AGE = 10;

function run() {
  console.log("=".repeat(80));
  console.log("CODE-STRUCTURED SCRATCHPAD VALUE ANALYSIS");
  console.log("=".repeat(80));
  console.log(`Session: ${SESSION_LENGTH} tool calls, prune age: ${PRUNE_AGE} steps`);
  console.log(`Chunks: ${CHUNKS.length} unique with raw/skeleton/interface/adjacency variants`);
  console.log("");

  // Compute token sizes per variant
  console.log("─".repeat(80));
  console.log("PER-CHUNK COMPRESSION ANALYSIS");
  console.log("─".repeat(80));
  console.log(
    "Chunk │  Raw  │ Tomb │ Skel │  Int │  Adj │ Skel% │  Int% │  Adj%",
  );
  console.log(
    "──────┼───────┼──────┼──────┼──────┼──────┼───────┼───────┼──────",
  );

  const variantTotals = { raw: 0, tomb: 0, skel: 0, int: 0, adj: 0 };

  for (let i = 0; i < CHUNKS.length; i++) {
    const c = CHUNKS[i];
    const raw = estimateTokens(c.raw);
    const tomb = estimateTokens(tombstoneText(`call_${i + 1}`, "code_context", raw));
    const skel = c.skeleton ? estimateTokens(skeletonText(`call_${i + 1}`, c.skeleton)) : tomb;
    const intv = c.interface_ ? estimateTokens(skeletonText(`call_${i + 1}`, c.interface_)) : tomb;
    const adj = c.adjacency ? estimateTokens(skeletonText(`call_${i + 1}`, c.adjacency)) : tomb;

    variantTotals.raw += raw;
    variantTotals.tomb += tomb;
    variantTotals.skel += skel;
    variantTotals.int += intv;
    variantTotals.adj += adj;

    const skelPct = ((skel / raw) * 100).toFixed(0);
    const intPct = ((intv / raw) * 100).toFixed(0);
    const adjPct = ((adj / raw) * 100).toFixed(0);

    console.log(
      `${String(i + 1).padStart(5)} │ ${String(raw).padStart(5)} │ ${String(tomb).padStart(4)} │ ${String(skel).padStart(4)} │ ${String(intv).padStart(4)} │ ${String(adj).padStart(4)} │ ${skelPct.padStart(5)}% │ ${intPct.padStart(5)}% │ ${adjPct.padStart(5)}%`,
    );
  }

  console.log(
    "──────┼───────┼──────┼──────┼──────┼──────┼───────┼───────┼──────",
  );

  const t = variantTotals;
  console.log(
    `  Tot │ ${String(t.raw).padStart(5)} │ ${String(t.tomb).padStart(4)} │ ${String(t.skel).padStart(4)} │ ${String(t.int).padStart(4)} │ ${String(t.adj).padStart(4)} │ ${((t.skel / t.raw) * 100).toFixed(0).padStart(5)}% │ ${((t.int / t.raw) * 100).toFixed(0).padStart(5)}% │ ${((t.adj / t.raw) * 100).toFixed(0).padStart(5)}%`,
  );

  console.log("");
  console.log("Compression ratios vs RAW:");
  console.log(`  Tombstone:  ${(t.tomb / t.raw * 100).toFixed(1)}% of raw`);
  console.log(`  Skeleton:   ${(t.skel / t.raw * 100).toFixed(1)}% of raw  (${((t.skel - t.tomb) / t.tomb * 100).toFixed(0)}% vs tombstone)`);
  console.log(`  Interface:  ${(t.int / t.raw * 100).toFixed(1)}% of raw  (${((t.int - t.tomb) / t.tomb * 100).toFixed(0)}% vs tombstone)`);
  console.log(`  Adjacency:  ${(t.adj / t.raw * 100).toFixed(1)}% of raw  (${((t.adj - t.tomb) / t.tomb * 100).toFixed(0)}% vs tombstone)`);

  // --- Full session simulation ---
  console.log("");
  console.log("=".repeat(80));
  console.log("SESSION SIMULATION (60 tool calls, prune age 10)");
  console.log("=".repeat(80));

  type StratTokens = { tomb: number[]; skel: number[]; intf: number[]; adj: number[] };
  const strats: StratTokens = { tomb: [], skel: [], intf: [], adj: [] };

  for (let i = 0; i < SESSION_LENGTH; i++) {
    let tombCtx = 0, skelCtx = 0, intCtx = 0, adjCtx = 0;

    for (let j = 0; j <= i; j++) {
      const c = CHUNKS[j % CHUNKS.length];
      const age = i - j;
      const raw = estimateTokens(c.raw);
      const tomb = estimateTokens(tombstoneText(`c${j}`, "tool", raw));

      if (age > PRUNE_AGE) {
        // Pruned — use compressed form
        tombCtx += tomb;
        skelCtx += c.skeleton ? estimateTokens(skeletonText(`c${j}`, c.skeleton)) : tomb;
        intCtx += c.interface_ ? estimateTokens(skeletonText(`c${j}`, c.interface_)) : tomb;
        adjCtx += c.adjacency ? estimateTokens(skeletonText(`c${j}`, c.adjacency)) : tomb;
      } else {
        // Active — full content
        tombCtx += raw;
        skelCtx += raw;
        intCtx += raw;
        adjCtx += raw;
      }
    }

    strats.tomb.push(tombCtx);
    strats.skel.push(skelCtx);
    strats.intf.push(intCtx);
    strats.adj.push(adjCtx);
  }

  // Sampled output
  console.log("");
  console.log("Step  │ Tombstone │ Skeleton │ Interface │ Adjacency │ Skel Δ  │ Intf Δ  │ Adjc Δ");
  console.log("──────┼───────────┼──────────┼───────────┼───────────┼─────────┼─────────┼─────────");

  for (let i = 9; i < SESSION_LENGTH; i += 10) {
    const ts = strats.tomb[i];
    const sk = strats.skel[i];
    const if_ = strats.intf[i];
    const ad = strats.adj[i];
    const skD = ts - sk;
    const ifD = ts - if_;
    const adD = ts - ad;
    const skP = ((skD / ts) * 100).toFixed(1);
    const ifP = ((ifD / ts) * 100).toFixed(1);
    const adP = ((adD / ts) * 100).toFixed(1);

    console.log(
      `${String(i + 1).padStart(5)} │ ${String(ts).padStart(9)} │ ${String(sk).padStart(8)} │ ${String(if_).padStart(9)} │ ${String(ad).padStart(9)} │ ${`+${skD}(${skP}%)`.padStart(7)} │ ${`+${ifD}(${ifP}%)`.padStart(7)} │ ${`+${adD}(${adP}%)`.padStart(7)}`,
    );
  }

  // Final comparison
  const last = SESSION_LENGTH - 1;
  const tsF = strats.tomb[last];
  const skF = strats.skel[last];
  const ifF = strats.intf[last];
  const adF = strats.adj[last];

  console.log("");
  console.log("FINAL CONTEXT (end of 60-step session):");
  console.log(`  Tombstone:    ${tsF}t`);
  console.log(`  Skeleton:     ${skF}t  (Δ ${tsF - skF}t, ${((tsF - skF) / tsF * 100).toFixed(1)}% less)`);
  console.log(`  Interface:    ${ifF}t  (Δ ${tsF - ifF}t, ${((tsF - ifF) / tsF * 100).toFixed(1)}% less)`);
  console.log(`  Adjacency:    ${adF}t  (Δ ${tsF - adF}t, ${((tsF - adF) / tsF * 100).toFixed(1)}% less)`);

  console.log("");
  console.log("=".repeat(80));
  console.log("VERDICT");
  console.log("=".repeat(80));
  console.log("");

  const skelVsTomb = ((t.skel - t.tomb) / t.tomb * 100);
  const intVsTomb = ((t.int - t.tomb) / t.tomb * 100);

  if (skelVsTomb > 0) {
    console.log(`Skeleton scratchpads are ${skelVsTomb.toFixed(0)}% LARGER than tombstones per chunk.`);
    console.log("BUT in session context, the savings come from skeleton being a USEFUL replacement");
    console.log("for raw code — the agent doesn't need to restore the chunk as often.");
    console.log("");
    console.log("Key question: does the skeleton reduce the agent's NEED to restore_chunks?");
    console.log("If yes → the session-level savings are multiplicative.");
    console.log("If no  → skeleton is counterproductive (larger than tombstone for no gain).");
  }

  console.log("");
  console.log("IMPLEMENTATION COMPLEXITY:");
  console.log("  Requires: language-aware skeleton extraction (AST parsing)");
  console.log("  Must handle: TS, Go, Python, Rust, Java, etc.");
  console.log("  Fallback: tombstone (current behavior) for unsupported languages");
  console.log("  Tools like rtk and distill already do this as CLI proxies");
  console.log("  ESTIMATED: ~300-400 LOC for AST skeletonizer, or integrate rtk");
  console.log("");
  console.log("ALTERNATIVE APPROACH:");
  console.log("  Instead of building skeletonization INTO prune-chunks, the agent");
  console.log("  could use rtk/distill as a SEPARATE tool to re-read files in skeleton");
  console.log("  form. This keeps prune-chunks simple (tombstone+restore) while giving");
  console.log("  the agent a cheap re-read option that costs ~5-10% of a full read.");
}

run();
