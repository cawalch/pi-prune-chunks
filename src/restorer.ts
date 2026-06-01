import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { type ChunkRegistry, restoreUnavailableReason } from "./registry";
import type { ChunkActionResult, ContentBlock, PruneChunksConfig } from "./types";

export async function restoreChunks(
  registry: ChunkRegistry,
  ids: string[],
  config: PruneChunksConfig,
  options: { cwd?: string } = {},
): Promise<ChunkActionResult[]> {
  const results: ChunkActionResult[] = [];
  for (const id of ids) {
    const chunk = registry.get(id);
    if (!chunk) {
      results.push({ id, status: "not_found", tokens: 0 });
      continue;
    }
    if (!chunk.pruned) {
      results.push({ id, status: "not_pruned", tokens: 0 });
      continue;
    }

    if (config.restore.memory && registry.getContent(id)) {
      results.push(registry.restore(id, "memory"));
      continue;
    }

    const source = chunk.source;
    const canRehydrate = canSourceRehydrate(source);
    if (config.restore.sourceRehydrate && canRehydrate) {
      const rehydrated = await rehydrateFromSource(source, options.cwd);
      if (rehydrated.status === "ok") {
        registry.setContent(id, [{ type: "text", text: rehydrated.text }]);
        results.push(registry.restore(id, "source_rehydrate"));
        continue;
      }
      results.push({
        id,
        status: rehydrated.status === "changed" ? "source_changed" : "unavailable",
        tokens: 0,
        reason: rehydrated.reason,
        restoreMode: "source_rehydrate",
      });
      continue;
    }

    const reason = config.restore.sourceRehydrate
      ? restoreUnavailableReason(false, chunk.source)
      : canRehydrate
        ? "no memory content and source rehydrate is disabled"
        : restoreUnavailableReason(false, chunk.source);
    results.push({
      id,
      status: "unavailable",
      tokens: 0,
      reason: reason ?? "no memory content or restore source is available",
      restoreMode: "unavailable",
    });
  }
  return results;
}

function canSourceRehydrate(
  source: { path?: string; startLine?: number; endLine?: number; mtimeMs?: number } | undefined,
): source is { path: string; startLine: number; endLine: number; mtimeMs?: number } {
  return !!source?.path && source.startLine != null && source.endLine != null;
}

async function rehydrateFromSource(
  source: { path: string; startLine: number; endLine: number; mtimeMs?: number },
  cwd = process.cwd(),
): Promise<{ status: "ok"; text: string } | { status: "missing" | "changed"; reason: string }> {
  const absolutePath = path.isAbsolute(source.path) ? source.path : path.join(cwd, source.path);
  try {
    const fileStat = await stat(absolutePath);
    if (source.mtimeMs != null && Math.abs(fileStat.mtimeMs - source.mtimeMs) > 1) {
      return { status: "changed", reason: "source file changed since the chunk was tracked" };
    }
    const text = await readFile(absolutePath, "utf8");
    const lines = text.split(/\r?\n/);
    const start = Math.max(0, source.startLine - 1);
    const end = Math.max(start, source.endLine);
    return { status: "ok", text: lines.slice(start, end).join("\n") };
  } catch (error) {
    return {
      status: "missing",
      reason: error instanceof Error ? error.message : "source file could not be read",
    };
  }
}

export function contentFromText(text: string): ContentBlock[] {
  return [{ type: "text", text }];
}
