import { contentText, estimateTokens } from "./text";
import type { ChunkKind, ContentBlock, ContextChunk } from "./types";

export type ChunkPartRole = "kept_summary" | "bulk" | "failure" | "source" | "metadata";

export interface ChunkPartPlan {
  idSuffix: string;
  label: string;
  role: ChunkPartRole;
  lineStart: number;
  lineEnd: number;
  content: ContentBlock[];
  tokenEstimate: number;
}

const MIN_PARTIAL_TOKENS = 2_000;
const MIN_BULK_TOKENS = 1_000;
const MIN_BULK_LINES = 20;
const KEEP_LINES_BY_KIND: Partial<Record<ChunkKind, number>> = {
  test_output: 30,
  search: 16,
  context_pack: 28,
  flow_trace: 24,
  shell: 24,
  file_read: 32,
  diff: 24,
};

export function planChunkParts(input: {
  kind: ChunkKind;
  content: ContentBlock[];
  tokenEstimate: number;
}): ChunkPartPlan[] {
  if (input.tokenEstimate < MIN_PARTIAL_TOKENS) return [];
  const text = contentText(input.content);
  const lines = text.split(/\r?\n/);
  const keepLines = keepLineCount(input.kind, lines);
  if (lines.length <= keepLines + MIN_BULK_LINES) return [];

  const bulkLines = lines.slice(keepLines);
  const bulkText = bulkLines.join("\n");
  const tokenEstimate = estimateTokens(bulkText);
  if (tokenEstimate < MIN_BULK_TOKENS) return [];

  return [
    {
      idSuffix: "bulk",
      label: `bulk lines ${keepLines + 1}-${lines.length}`,
      role: "bulk",
      lineStart: keepLines + 1,
      lineEnd: lines.length,
      content: [{ type: "text", text: bulkText }],
      tokenEstimate,
    },
  ];
}

export function applyPartTombstonesToContent(
  content: ContentBlock[],
  parts: ContextChunk[],
  tombstoneText: (chunk: ContextChunk) => string,
): ContentBlock[] {
  const text = contentText(content);
  if (!text || parts.length === 0) return content;

  const lines = text.split(/\r?\n/);
  const sorted = [...parts]
    .filter((chunk) => chunk.part?.lineStart != null && chunk.part.lineEnd != null)
    .sort((a, b) => (b.part?.lineStart ?? 0) - (a.part?.lineStart ?? 0));

  for (const chunk of sorted) {
    const start = Math.max(0, (chunk.part?.lineStart ?? 1) - 1);
    const end = Math.max(start, chunk.part?.lineEnd ?? start + 1);
    lines.splice(start, end - start + 1, tombstoneText(chunk));
  }

  return [{ type: "text", text: lines.join("\n") }];
}

export function parentTokenEstimate(totalTokens: number, parts: ChunkPartPlan[]): number {
  const partTokens = parts.reduce((sum, part) => sum + part.tokenEstimate, 0);
  return Math.max(1, totalTokens - partTokens);
}

function keepLineCount(kind: ChunkKind, lines: string[]): number {
  if (kind === "test_output") {
    const firstFailure = lines.findIndex((line) =>
      /\b(FAIL|FAILED|AssertionError|Error:|✖|panic:)\b/.test(line),
    );
    if (firstFailure >= 0) return Math.max(KEEP_LINES_BY_KIND.test_output ?? 30, firstFailure + 6);
  }
  return KEEP_LINES_BY_KIND[kind] ?? 20;
}
