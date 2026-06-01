import { contentText, estimateTokens, hashText } from "./text";
import type { ContentBlock, PruneChunksConfig } from "./types";

export function compactFailedToolValidationMessages<
  T extends { role: string; content?: ContentBlock[] },
>(messages: T[], config: PruneChunksConfig): { messages: T[]; modified: boolean } {
  if (!config.contextGuards.compactFailedToolValidation) {
    return { messages, modified: false };
  }

  let modified = false;
  const mapped = messages.map((message) => {
    const text = contentText(message.content ?? []);
    if (!shouldCompactFailedToolValidation(text, config)) return message;

    modified = true;
    return {
      ...message,
      content: [failedToolValidationSummary(text)],
    };
  });

  return { messages: mapped, modified };
}

function shouldCompactFailedToolValidation(text: string, config: PruneChunksConfig): boolean {
  return (
    text.length > config.contextGuards.maxFailedToolValidationChars &&
    /Validation failed for tool "[^"]+"/.test(text) &&
    /Received arguments:/i.test(text)
  );
}

function failedToolValidationSummary(text: string): ContentBlock {
  const toolName = /Validation failed for tool "([^"]+)"/.exec(text)?.[1] ?? "unknown";
  const validationLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .slice(0, 6);
  const requestError = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^Error:\s*\d+\s+request\s+\([^)]+\)\s+exceeds/i.test(line));
  const detail = validationLines.length > 0 ? ` ${validationLines.join("; ")}` : "";
  const error = requestError ? ` ${requestError}` : "";

  return {
    type: "text",
    text:
      `[compacted-tool-validation-error: tool="${escapeField(toolName)}" ` +
      `original~${estimateTokens(text)}t sha1=${hashText(text).slice(0, 10)};` +
      `${detail}${error} Received arguments omitted; retry with schema-valid minimal arguments]`,
  };
}

function escapeField(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\s+/g, " ").trim();
}
