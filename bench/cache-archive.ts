#!/usr/bin/env node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DiskChunkContentCache } from "../src/diskCache";

async function main(): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-prune-cache-bench-"));
  try {
  const cache = new DiskChunkContentCache({
    enabled: true,
    directory,
    maxBytes: 250 * 1024 * 1024,
    maxAgeDays: 14,
    maxBlobBytes: 25 * 1024 * 1024,
  });
  const baseline = cache.instrumentation();
  const startedAt = performance.now();
  for (let index = 0; index < 100; index++) {
    await cache.archive(`fixture-${index}`, [
      {
        type: "text",
        text: `fixture ${index}\n${"tool output with repeated compressible detail\n".repeat(400)}`,
      },
    ]);
  }
  const durationMs = performance.now() - startedAt;
  const metrics = cache.instrumentation();
  const scheduledScans = metrics.directoryScans - baseline.directoryScans;

  console.log("v0.2 archive fixture");
  console.log(`  100 retired results: ${durationMs.toFixed(1)}ms`);
  console.log(`  cleanup scans during writes: ${scheduledScans}`);
  console.log(`  scheduled cleanups during writes: ${metrics.cleanups - baseline.cleanups}`);

  if (metrics.archives !== 100 || scheduledScans > 1) {
    throw new Error("cache maintenance regressed to per-write scanning");
  }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

void main();
