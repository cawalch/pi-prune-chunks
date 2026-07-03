import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { hashText } from "./text";
import type { ChunkContentCache, ContentBlock, DiskCacheConfig } from "./types";

const INDEX_VERSION = 1;

interface DiskCacheIndexEntry {
  version: 1;
  id: string;
  hash: string;
  createdAt: number;
  updatedAt: number;
  rawBytes: number;
  storedBytes: number;
}

export class DiskChunkContentCache implements ChunkContentCache {
  private readonly root: string;
  private readonly maxBytes: number;
  private readonly maxBlobBytes: number;
  private readonly maxAgeMs: number;

  constructor(config: DiskCacheConfig) {
    this.root = path.resolve(expandHome(config.directory ?? defaultDiskCacheDirectory()));
    this.maxBytes = Math.max(0, config.maxBytes);
    this.maxBlobBytes = Math.max(0, config.maxBlobBytes);
    this.maxAgeMs = Math.max(0, config.maxAgeDays) * 24 * 60 * 60 * 1000;
    this.ensureDirectories();
  }

  get(id: string, mode?: "memory" | "disk_cache"): ContentBlock[] | undefined {
    if (mode === "memory") return undefined;
    const entry = this.readIndex(id);
    if (!entry) return undefined;
    try {
      const compressed = readFileSync(this.blobPath(entry.hash));
      const parsed = JSON.parse(gunzipSync(compressed).toString("utf8")) as unknown;
      if (!Array.isArray(parsed)) return undefined;
      return parsed.map((block) => ({ ...(block as ContentBlock) }));
    } catch {
      return undefined;
    }
  }

  set(id: string, content: ContentBlock[]): void {
    const serialized = stableSerializeContent(content);
    const rawBytes = Buffer.byteLength(serialized, "utf8");
    if (this.maxBlobBytes > 0 && rawBytes > this.maxBlobBytes) return;

    this.ensureDirectories();
    const hash = hashText(serialized);
    const blobPath = this.blobPath(hash);
    if (!existsSync(blobPath)) {
      writeFileSync(blobPath, gzipSync(serialized));
    }
    const storedBytes = statSync(blobPath).size;
    const now = Date.now();
    const previous = this.readIndex(id);
    const entry: DiskCacheIndexEntry = {
      version: INDEX_VERSION,
      id,
      hash,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      rawBytes,
      storedBytes,
    };
    writeFileSync(this.indexPath(id), JSON.stringify(entry, null, 2));
    this.enforceLimits();
  }

  delete(id: string): void {
    rmSync(this.indexPath(id), { force: true });
  }

  has(id: string, mode?: "memory" | "disk_cache"): boolean {
    if (mode === "memory") return false;
    const entry = this.readIndex(id);
    return !!entry && existsSync(this.blobPath(entry.hash));
  }

  clear(): void {
    rmSync(this.root, { recursive: true, force: true });
    this.ensureDirectories();
  }

  location(): string {
    return this.root;
  }

  private ensureDirectories(): void {
    mkdirSync(this.blobsDir(), { recursive: true });
    mkdirSync(this.indexDir(), { recursive: true });
  }

  private enforceLimits(): void {
    if (this.maxAgeMs > 0) this.removeExpiredEntries();
    if (this.maxBytes > 0) this.trimToMaxBytes();
    this.removeUnreferencedBlobs();
  }

  private removeExpiredEntries(): void {
    const cutoff = Date.now() - this.maxAgeMs;
    for (const entry of this.indexEntries()) {
      if (entry.updatedAt < cutoff) this.delete(entry.id);
    }
  }

  private trimToMaxBytes(): void {
    const entries = this.indexEntries().sort((a, b) => a.updatedAt - b.updatedAt);
    let total = totalStoredBytes(entries);
    while (total > this.maxBytes && entries.length > 0) {
      const oldest = entries.shift();
      if (!oldest) break;
      this.delete(oldest.id);
      total = totalStoredBytes(entries);
    }
  }

  private removeUnreferencedBlobs(): void {
    const referenced = new Set(this.indexEntries().map((entry) => entry.hash));
    for (const name of listDirNames(this.blobsDir())) {
      const hash = blobHashFromFileName(name);
      if (hash && !referenced.has(hash)) rmSync(path.join(this.blobsDir(), name), { force: true });
    }
  }

  private indexEntries(): DiskCacheIndexEntry[] {
    return listDirNames(this.indexDir())
      .map((name) => this.readIndexFile(path.join(this.indexDir(), name)))
      .filter((entry): entry is DiskCacheIndexEntry => !!entry);
  }

  private readIndex(id: string): DiskCacheIndexEntry | undefined {
    return this.readIndexFile(this.indexPath(id));
  }

  private readIndexFile(filePath: string): DiskCacheIndexEntry | undefined {
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<DiskCacheIndexEntry>;
      if (
        parsed.version !== INDEX_VERSION ||
        typeof parsed.id !== "string" ||
        typeof parsed.hash !== "string" ||
        typeof parsed.updatedAt !== "number" ||
        typeof parsed.rawBytes !== "number" ||
        typeof parsed.storedBytes !== "number"
      ) {
        return undefined;
      }
      return {
        version: INDEX_VERSION,
        id: parsed.id,
        hash: parsed.hash,
        createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : parsed.updatedAt,
        updatedAt: parsed.updatedAt,
        rawBytes: parsed.rawBytes,
        storedBytes: parsed.storedBytes,
      };
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
    this.disk?.set(id, content);
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
    process.env.PI_PRUNE_CHUNKS_CACHE_DIR ?? path.join(homedir(), ".pi", "prune-chunks", "cache")
  );
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
    return mkdirAndList(directory);
  } catch {
    return [];
  }
}

function mkdirAndList(directory: string): string[] {
  mkdirSync(directory, { recursive: true });
  return readdirSync(directory);
}

function totalStoredBytes(entries: DiskCacheIndexEntry[]): number {
  const hashes = new Set<string>();
  let total = 0;
  for (const entry of entries) {
    if (hashes.has(entry.hash)) continue;
    hashes.add(entry.hash);
    total += entry.storedBytes;
  }
  return total;
}
