#!/usr/bin/env node

import extension from "../index";

async function main(): Promise<void> {
const handlers: Record<string, (event: any, ctx: any) => Promise<any>> = {};
const modelTools: unknown[] = [];
const stateEntries: unknown[] = [];
const notifications: string[] = [];
let compactCalls = 0;

extension({
  settings: {
    pruneChunks: {
      track: { minChunkTokens: 1 },
      restore: { diskCache: false },
    },
  },
  on(name: string, handler: (event: any, ctx: any) => Promise<any>) {
    handlers[name] = handler;
  },
  registerTool(tool: unknown) {
    modelTools.push(tool);
  },
  registerCommand() {},
  appendEntry(customType: string, data: unknown) {
    stateEntries.push({ customType, data });
  },
} as any);

const messages: any[] = [];
for (let index = 0; index < 12; index++) {
  const id = `churn-${index}`;
  const output = `src/file-${index}.ts:1: unique hit ${index}\n`.repeat(20);
  await handlers.tool_result(
    { toolCallId: id, toolName: "rg", content: [{ type: "text", text: output }] },
    {},
  );
  messages.push({
    role: "assistant",
    content: [{ type: "toolCall", id, name: "rg", arguments: { query: `unique-${index}` } }],
  });
  messages.push({
    role: "toolResult",
    toolCallId: id,
    toolName: "rg",
    content: [{ type: "text", text: output }],
  });
}

const ctx = {
  hasUI: true,
  getContextUsage: () => ({ tokens: 22_400, contextWindow: 32_000, percent: 70 }),
  compact() {
    compactCalls += 1;
  },
  ui: {
    notify(message: string) {
      notifications.push(message);
    },
    setStatus() {},
  },
};

const startedAt = performance.now();
let rewrites = 0;
for (let pass = 0; pass < 1_000; pass++) {
  if (await handlers.context({ messages }, ctx)) rewrites += 1;
}
const durationMs = performance.now() - startedAt;

console.log("70% unchanged-context churn replay");
console.log(`  passes: 1,000 in ${durationMs.toFixed(1)}ms`);
console.log(`  provider rewrites: ${rewrites}`);
console.log(`  state entries: ${stateEntries.length}`);
console.log(`  notifications: ${notifications.length}`);
console.log(`  model management tools: ${modelTools.length}`);
console.log(`  compact calls: ${compactCalls}`);

if (
  rewrites !== 0 ||
  stateEntries.length !== 0 ||
  notifications.length !== 0 ||
  modelTools.length !== 0 ||
  compactCalls !== 0
) {
  throw new Error("70% pressure alone caused context-management churn");
}
}

void main();
