import { createHash } from "node:crypto";
import type { ContentBlock } from "./types";

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function contentText(content: ContentBlock[] | string | undefined | null): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content);
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string" && block.text)
    .map((block) => block.text ?? "")
    .join("\n");
}

export function hashText(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

export function compactWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 1)}...`;
}

export function firstMeaningfulLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0)
      ?.trim() ?? ""
  );
}

export function summarizeText(text: string, maxChars: number): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => compactWhitespace(line))
    .filter(Boolean)
    .slice(0, 2);
  if (lines.length === 0) return undefined;
  return truncateText(lines.join(" | "), maxChars);
}
