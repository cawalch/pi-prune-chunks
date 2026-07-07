import type { ContextChunk } from "./types";

const MAX_ANCHORS = 32;
const MAX_ANCHOR_CHARS = 120;

const ANCHOR_PATTERNS: RegExp[] = [
  /(?:^|[\s(])(#\d{1,8})\b/g,
  /\b(?:GH|gh|issue|Issue|PR|pr)[ -]?(#?\d{1,8})\b/g,
  /\b(?:npm|pnpm|yarn|node|npx|pytest|go test|cargo test|deno test)\b[^\n]{0,100}/g,
  /\b(?:FAIL(?:ED)?|AssertionError|TypeError|ReferenceError|SyntaxError|Traceback|panic:|Error:)\b[^\n]{0,100}/g,
  /\btest\/[A-Za-z0-9_./-]+\.test\.[A-Za-z0-9]+\b/g,
  /\b[A-Za-z0-9_./-]+\.test\.[A-Za-z0-9]+\b/g,
];

export function extractReasoningAnchors(text: string, limit = MAX_ANCHORS): string[] {
  const anchors: string[] = [];
  for (const pattern of ANCHOR_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const raw =
        match[1] && /^#?\d+$/.test(match[1])
          ? `#${match[1].replace(/^#/, "")}`
          : (match[1] ?? match[0]);
      const anchor = normalizeAnchor(raw);
      if (anchor) anchors.push(anchor);
      if (anchors.length >= limit * 2) break;
    }
    if (anchors.length >= limit * 2) break;
  }
  return uniqueAnchors(anchors).slice(0, limit);
}

export function chunkReasoningAnchors(chunk: ContextChunk): string[] {
  return extractReasoningAnchors(
    [
      chunk.label,
      chunk.summary,
      chunk.source?.command,
      chunk.decisionCard?.gist,
      ...(chunk.decisionCard?.evidence ?? []),
      ...(chunk.decisionCard?.sourceAnchors ?? []),
      ...(chunk.decisionCard?.hazards ?? []),
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

export function matchingReasoningAnchor(
  chunk: ContextChunk,
  preservedAnchors: Set<string> | undefined,
): string | null {
  if (!preservedAnchors || preservedAnchors.size === 0) return null;
  const chunkAnchors = new Set(chunkReasoningAnchors(chunk));
  for (const anchor of preservedAnchors) {
    const normalized = normalizeAnchor(anchor);
    if (normalized && chunkAnchors.has(normalized)) return normalized;
  }
  return null;
}

export function normalizeAnchor(value: string): string | null {
  const compact = value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s:;,.()]+|[\s:;,.()]+$/g, "");
  if (compact.length < 2) return null;
  return compact.slice(0, MAX_ANCHOR_CHARS).toLowerCase();
}

function uniqueAnchors(anchors: string[]): string[] {
  return [...new Set(anchors)];
}
