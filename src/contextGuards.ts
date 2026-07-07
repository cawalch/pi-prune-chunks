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
    const summary = contextGuardSummary(text, config);
    if (!summary) return message;

    modified = true;
    return {
      ...message,
      content: [summary],
    };
  });

  return { messages: mapped, modified };
}

function contextGuardSummary(text: string, config: PruneChunksConfig): ContentBlock | null {
  if (text.length <= config.contextGuards.maxFailedToolValidationChars) return null;
  if (shouldCompactFailedToolValidation(text)) return failedToolValidationSummary(text);
  if (shouldCompactToolInput(text)) return toolInputSummary(text);
  return null;
}

function shouldCompactFailedToolValidation(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    /^Validation failed for tool "[^"]+"/.test(trimmed) && /Received arguments:/i.test(trimmed)
  );
}

function shouldCompactToolInput(text: string): boolean {
  return /^Tool call arguments for "[^"]+":/i.test(text.trimStart());
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

function toolInputSummary(text: string): ContentBlock {
  const toolName = /^Tool call arguments for "([^"]+)":/i.exec(text.trimStart())?.[1] ?? "unknown";
  const paths = sourcePaths(text).slice(0, 4);
  const pathDetail = paths.length > 0 ? ` paths=${paths.map(escapeField).join(",")};` : "";
  return {
    type: "text",
    text:
      `[compacted-tool-input: tool="${escapeField(toolName)}" ` +
      `original~${estimateTokens(text)}t sha1=${hashText(text).slice(0, 10)};` +
      `${pathDetail} arguments omitted; restore from saved transcript]`,
  };
}

function sourcePaths(text: string): string[] {
  const matches = text.match(
    /(?:^|[\s"'`])((?:\.\/|\.\.\/|\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+)/gm,
  );
  if (!matches) return [];
  return [
    ...new Set(
      matches.map((match) => match.trim().replace(/^["'`]+|[),.;:"'`]+$/g, "")).filter(Boolean),
    ),
  ];
}

function escapeField(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\s+/g, " ").trim();
}
