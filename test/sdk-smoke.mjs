// Usage: node test/sdk-smoke.mjs /path/to/pi-coding-agent/dist/index.js [openai-completions.js]
// Loads the real SDK without credentials, provider requests, or user settings.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sdkPath = process.argv[2];
assert.ok(sdkPath, "Pass the installed Pi SDK's dist/index.js path");
const sdk = await import(pathToFileURL(path.resolve(sdkPath)).href);
const root = mkdtempSync(path.join(tmpdir(), "pi-prune-sdk-"));
const agentDir = path.join(root, "agent");
const cwd = path.join(root, "project");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const notifications = [];
const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));
const ctx = {
  cwd,
  hasUI: true,
  isProjectTrusted: () => true,
  sessionManager: { getBranch: () => [] },
  ui: { notify: (message) => notifications.push(message), setStatus() {} },
  getContextUsage: () => ({ tokens: 100, contextWindow: 100_000, percent: 0.1 }),
};
const settings = (value) =>
  writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ pruneChunks: value }));
async function load() {
  const result = await sdk.discoverAndLoadExtensions([extensionPath], cwd, agentDir);
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  result.runtime.appendEntry = () => {};
  return result.extensions[0];
}
async function emit(extension, name, event = {}) {
  let result;
  for (const handler of extension.handlers.get(name) ?? []) result = await handler(event, ctx);
  return result;
}
try {
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(path.join(cwd, sdk.CONFIG_DIR_NAME), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  settings({ restore: { diskCache: false } });
  let extension = await load();
  await emit(extension, "session_start");
  await extension.commands.get("prune-status").handler("", ctx);
  assert.match(notifications.pop(), /Effective settings: global/);
  await emit(extension, "session_shutdown");

  for (const invalid of [
    { pressure: { triggerPercent: 50, targetPercent: 60 } },
    { trackTools: { bad: true } },
  ]) {
    settings({ ...invalid, restore: { diskCache: false } });
    extension = await load();
    notifications.length = 0;
    await emit(extension, "session_start");
    assert.match(notifications[0], /prune-chunks disabled:/);
    await emit(extension, "tool_result", {
      toolCallId: "invalid-settings",
      toolName: "read",
      content: [{ type: "text", text: "x".repeat(2000) }],
    });
    await emit(extension, "session_shutdown");
  }

  const blocked = path.join(root, "ordinary-file");
  writeFileSync(blocked, "not a directory");
  settings({ restore: { diskCache: { directory: blocked } } });
  extension = await load();
  notifications.length = 0;
  await emit(extension, "session_start");
  assert.match(notifications[0], /Cannot initialize prune-chunks cache/);
  await emit(extension, "session_shutdown");

  writeFileSync(
    path.join(cwd, sdk.CONFIG_DIR_NAME, "settings.json"),
    JSON.stringify({ pruneChunks: { restore: { diskCache: false } } }),
  );
  extension = await load();
  notifications.length = 0;
  await emit(extension, "session_start");
  assert.deepEqual(notifications, []);
  await extension.commands.get("prune-status").handler("", ctx);
  assert.doesNotMatch(notifications.pop(), /Configuration error/);
  await emit(extension, "session_shutdown");
  if (process.argv[3]) {
    const { stream } = await import(pathToFileURL(path.resolve(process.argv[3])).href);
    const model = {
      id: "swift-qwen3.8",
      name: "local fixture",
      api: "openai-completions",
      provider: "local",
      baseUrl: "http://unused.invalid/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 164_000,
      maxTokens: 4096,
    };
    for (const marker of ["reasoning_content", "reasoning", "reasoning_text"]) {
      const chunks = [
        { delta: { role: "assistant", [marker]: "Plan" }, finish_reason: null },
        { delta: { content: "Done" }, finish_reason: "stop" },
      ];
      const sse = `${chunks
        .map(
          (choice) =>
            `data: ${JSON.stringify({
              id: "fixture",
              object: "chat.completion.chunk",
              created: 1,
              model: model.id,
              choices: [{ index: 0, ...choice }],
            })}\n\n`,
        )
        .join("")}data: [DONE]\n\n`;
      let requests = 0;
      const thinking = await stream(
        model,
        { messages: [{ role: "user", content: "test", timestamp: 1 }] },
        {
          apiKey: "fixture-only",
          fetch: async () => {
            requests++;
            return new Response(sse, { headers: { "content-type": "text/event-stream" } });
          },
        },
      ).result();
      assert.equal(requests, 1);
      assert.equal(thinking.stopReason, "stop", thinking.errorMessage);
      assert.equal(thinking.content[0].thinkingSignature, marker);
      settings({
        restore: { diskCache: false },
        track: { minChunkTokens: 1 },
        workingSet: { triggerTokens: 200, targetTokens: 100 },
        retention: { preserveRecentResults: 0, preserveRecentMinutes: 0 },
      });
      extension = await load();
      ctx.model = model;
      ctx.thinkingLevel = "high";
      await emit(extension, "session_start");
      await emit(extension, "message_end", { message: thinking });
      const output = [{ type: "text", text: "src/old.ts:1: hit\n".repeat(200) }];
      await emit(extension, "tool_result", { toolCallId: "old", toolName: "rg", content: output });
      const messages = [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "old", name: "rg", arguments: {} }],
        },
        { role: "toolResult", toolCallId: "old", toolName: "rg", content: output },
        thinking,
      ];
      await emit(extension, "context", { messages });
      const rewritten = await emit(extension, "context", { messages });
      assert.deepEqual(
        rewritten?.messages,
        [thinking],
        `adapter marker ${marker} must permit retirement`,
      );
      await emit(extension, "session_shutdown");
    }
    console.log(
      `Pi ${sdk.VERSION}: real OpenAI adapter reasoning markers permit pruning (mocked HTTP, no network)`,
    );
  }
  console.log(
    `Pi ${sdk.VERSION}: settings, warnings, nested validation, cache failure and project override smoke passed`,
  );
} finally {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
}
