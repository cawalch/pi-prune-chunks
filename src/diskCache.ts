import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gunzipSync, gzip } from "node:zlib";
import { hashText } from "./text";
import type { ChunkContentCache, ContentBlock, DiskCacheConfig } from "./types";

const gzipAsync = promisify(gzip);
const INDEX_VERSION = 2;
const CLEANUP_INTERVAL = 64;

interface DiskCacheIndexEntry {
  version: 2;
  id: string;
  hash: string;
  createdAt: number;
  updatedAt: number;
  rawBytes: number;
  storedBytes: number;
}

export type DiskCacheInstrumentation = {
  directoryScans: number;
  archives: number;
  cleanups: number;
};

export class DiskChunkContentCache implements ChunkContentCache {
  private readonly root: string;
  private readonly maxBytes: number;
  private readonly maxBlobBytes: number;
  private readonly maxAgeMs: number;
  private readonly entries = new Map<string, DiskCacheIndexEntry>();
  private readonly metrics: DiskCacheInstrumentation = {
    directoryScans: 0,
    archives: 0,
    cleanups: 0,
  };
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(config: DiskCacheConfig) {
    this.root = path.resolve(expandHome(config.directory ?? defaultDiskCacheDirectory()));
    this.maxBytes = Math.max(0, config.maxBytes);
    this.maxBlobBytes = Math.max(0, config.maxBlobBytes);
    this.maxAgeMs = Math.max(0, config.maxAgeDays) * 24 * 60 * 60 * 1_000;
    this.ensureDirectories();
    this.loadIndex();
    this.cleanup();
  }

  get(id: string, mode?: "memory" | "disk_cache"): ContentBlock[] | undefined {
    if (mode === "memory") return undefined;
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    try {
      const parsed = JSON.parse(
        gunzipSync(readFileSync(this.blobPath(entry.hash))).toString("utf8"),
      ) as unknown;
      if (!Array.isArray(parsed)) return undefined;
      return parsed.map((block) => ({ ...(block as ContentBlock) }));
    } catch {
      return undefined;
    }
  }

  /** Disk storage is archive-only; active results stay in memory. */
  set(_id: string, _content: ContentBlock[]): void {}

  async archive(id: string, content: ContentBlock[]): Promise<void> {
    const task = this.writeQueue.then(() => this.archiveNow(id, content));
    this.writeQueue = task.catch(() => undefined);
    return task;
  }

  private async archiveNow(id: string, content: ContentBlock[]): Promise<void> {
    const serialized = stableSerializeContent(content);
    const rawBytes = Buffer.byteLength(serialized, "utf8");
    if (this.maxBlobBytes > 0 && rawBytes > this.maxBlobBytes) return;

    const hash = hashText(serialized);
    const blobPath = this.blobPath(hash);
    if (!existsSync(blobPath)) {
      const compressed = await gzipAsync(serialized);
      await atomicWrite(blobPath, compressed);
    }
    const now = Date.now();
    const previous = this.entries.get(id);
    const entry: DiskCacheIndexEntry = {
      version: INDEX_VERSION,
      id,
      hash,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      rawBytes,
      storedBytes: statSync(blobPath).size,
    };
    await atomicWrite(this.indexPath(id), JSON.stringify(entry));
    this.entries.set(id, entry);
    this.metrics.archives += 1;

    if (
      this.metrics.archives % CLEANUP_INTERVAL === 0 ||
      (this.maxBytes > 0 && this.totalStoredBytes() > this.maxBytes)
    ) {
      this.cleanup();
    }
  }

  delete(id: string): void {
    this.entries.delete(id);
    rmSync(this.indexPath(id), { force: true });
  }

  has(id: string, mode?: "memory" | "disk_cache"): boolean {
    if (mode === "memory") return false;
    const entry = this.entries.get(id);
    return !!entry && existsSync(this.blobPath(entry.hash));
  }

  clear(): void {
    rmSync(this.root, { recursive: true, force: true });
    this.entries.clear();
    this.ensureDirectories();
  }

  location(): string {
    return this.root;
  }

  instrumentation(): DiskCacheInstrumentation {
    return { ...this.metrics };
  }

  private ensureDirectories(): void {
    mkdirSync(this.blobsDir(), { recursive: true });
    mkdirSync(this.indexDir(), { recursive: true });
  }

  private loadIndex(): void {
    this.metrics.directoryScans += 1;
    for (const name of listDirNames(this.indexDir())) {
      const entry = this.readIndexFile(path.join(this.indexDir(), name));
      if (entry) this.entries.set(entry.id, entry);
    }
  }

  private cleanup(): void {
    this.metrics.cleanups += 1;
    const cutoff = Date.now() - this.maxAgeMs;
    if (this.maxAgeMs > 0) {
      for (const entry of this.entries.values()) {
        if (entry.updatedAt < cutoff) this.delete(entry.id);
      }
    }
    if (this.maxBytes > 0) {
      const oldest = [...this.entries.values()].sort((a, b) => a.updatedAt - b.updatedAt);
      while (this.totalStoredBytes() > this.maxBytes && oldest.length > 0) {
        const entry = oldest.shift();
        if (entry) this.delete(entry.id);
      }
    }
    this.removeUnreferencedBlobs();
  }

  private removeUnreferencedBlobs(): void {
    this.metrics.directoryScans += 1;
    const referenced = new Set([...this.entries.values()].map((entry) => entry.hash));
    for (const name of listDirNames(this.blobsDir())) {
      if (name.endsWith(".tmp")) {
        rmSync(path.join(this.blobsDir(), name), { force: true });
        continue;
      }
      const hash = blobHashFromFileName(name);
      if (hash && !referenced.has(hash)) rmSync(path.join(this.blobsDir(), name), { force: true });
    }
  }

  private totalStoredBytes(): number {
    const hashes = new Set<string>();
    let total = 0;
    for (const entry of this.entries.values()) {
      if (hashes.has(entry.hash)) continue;
      hashes.add(entry.hash);
      total += entry.storedBytes;
    }
    return total;
  }

  private readIndexFile(filePath: string): DiskCacheIndexEntry | undefined {
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<DiskCacheIndexEntry>;
      if (
        parsed.version !== INDEX_VERSION ||
        typeof parsed.id !== "string" ||
        typeof parsed.hash !== "string" ||
        typeof parsed.createdAt !== "number" ||
        typeof parsed.updatedAt !== "number" ||
        typeof parsed.rawBytes !== "number" ||
        typeof parsed.storedBytes !== "number"
      ) {
        return undefined;
      }
      return parsed as DiskCacheIndexEntry;
    } catch {
      return undefined;
    }
  }

  private blobsDir(): string {
    return path.join(this.root, "blobs");
  }

  private indexDir(): string {
    return path.join(this.root, "ids");
  }

  private blobPath(hash: string): string {
    return path.join(this.blobsDir(), `${safePathPart(hash)}.json.gz`);
  }

  private indexPath(id: string): string {
    return path.join(this.indexDir(), `${safePathPart(id)}.json`);
  }
}

export class CompositeChunkContentCache implements ChunkContentCache {
  constructor(
    private readonly memory: ChunkContentCache,
    private readonly disk?: ChunkContentCache,
  ) {}

  get(id: string, mode?: "memory" | "disk_cache"): ContentBlock[] | undefined {
    if (mode === "memory") return this.memory.get(id, "memory");
    if (mode === "disk_cache") return this.disk?.get(id, "disk_cache");
    return this.memory.get(id, "memory") ?? this.disk?.get(id, "disk_cache");
  }

  set(id: string, content: ContentBlock[]): void {
    this.memory.set(id, content);
  }

  async archive(id: string, content: ContentBlock[]): Promise<void> {
    await this.disk?.archive(id, content);
  }

  delete(id: string): void {
    this.memory.delete(id);
    this.disk?.delete(id);
  }

  has(id: string, mode?: "memory" | "disk_cache"): boolean {
    if (mode === "memory") return this.memory.has(id, "memory");
    if (mode === "disk_cache") return this.disk?.has(id, "disk_cache") ?? false;
    return this.memory.has(id, "memory") || (this.disk?.has(id, "disk_cache") ?? false);
  }

  clear(): void {
    this.memory.clear();
  }
}

export function defaultDiskCacheDirectory(): string {
  return (
    process.env.PI_PRUNE_CHUNKS_CACHE_DIR ?? path.join(homedir(), ".pi", "prune-chunks", "cache-v2")
  );
}

async function atomicWrite(destination: string, data: string | Uint8Array): Promise<void> {
  const temporary = `${destination}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(temporary, data);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

function expandHome(directory: string): string {
  return directory === "~" || directory.startsWith("~/")
    ? path.join(homedir(), directory.slice(2))
    : directory;
}

function stableSerializeContent(content: ContentBlock[]): string {
  return JSON.stringify(content.map((block) => sortObject(block)));
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    output[key] = sortObject((value as Record<string, unknown>)[key]);
  }
  return output;
}

function blobHashFromFileName(name: string): string | undefined {
  return name.endsWith(".json.gz") ? name.slice(0, -".json.gz".length) : undefined;
}

function safePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function listDirNames(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}
