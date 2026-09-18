import assert from "node:assert/strict";
import { test } from "node:test";
import type { GenerateParams, LLMProvider, StreamChunk } from "../llm/types.js";
import { generateStreamWithRetry } from "./generate-stream-with-retry.js";

const params: GenerateParams = { model: "test-model", messages: [] };

function mockProvider(generateStream: LLMProvider["generateStream"]): LLMProvider {
  return { generateStream, listModels: async () => [] };
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

const partialChunks: StreamChunk[] = [
  { type: "text", content: "I will update" },
  { type: "reasoning", content: "Checking the component" },
  { type: "tool_call_start", content: "", toolCallId: "write-1", toolCallName: "write_custom_ui", toolCallIndex: 0 },
  { type: "tool_call_delta", content: '{"id":"index.tsx"', toolCallIndex: 0 },
  { type: "tool_call_end", content: "", toolCallIndex: 0, toolCall: {
    id: "write-1", type: "function", function: { name: "write_custom_ui", arguments: '{"id":"index.tsx","code":"export default () => null"}' },
  } },
];

for (const partial of partialChunks) {
  test(`does not resend a generation after a ${partial.type} chunk and network exception`, async () => {
    let calls = 0;
    const failure = new Error("ECONNRESET network connection");
    const provider = mockProvider(async function* () {
      calls++;
      yield partial;
      if (calls === 1) throw failure;
      yield { type: "done", content: "" };
    });
    const observed: StreamChunk[] = [];
    await assert.rejects(async () => {
      for await (const chunk of generateStreamWithRetry(provider, params, 1)) observed.push(chunk);
    }, failure);
    assert.equal(calls, 1, "retrying would mix separate generations and may duplicate writes");
    assert.deepEqual(observed, [partial]);
  });
}

for (const failureMode of ["throw", "error-chunk"] as const) {
  test(`retries a transient ${failureMode} before the first chunk`, async () => {
    let calls = 0;
    const provider = mockProvider(async function* () {
      calls++;
      if (calls === 1) {
        if (failureMode === "throw") throw new Error("503 upstream unavailable");
        yield { type: "error", content: "503 upstream unavailable" };
        return;
      }
      yield { type: "text", content: "Finished" };
      yield { type: "done", content: "" };
    });
    assert.deepEqual(await collect(generateStreamWithRetry(provider, params, 1)), [
      { type: "text", content: "Finished" }, { type: "done", content: "" },
    ]);
    assert.equal(calls, 2);
  });
}

test("surfaces a mid-stream error chunk without retrying", async () => {
  let calls = 0;
  const provider = mockProvider(async function* () {
    calls++;
    yield { type: "text", content: "Partial" };
    yield { type: "error", content: "503 upstream unavailable" };
  });
  const chunks = await collect(generateStreamWithRetry(provider, params, 1));
  assert.equal(calls, 1);
  assert.equal(chunks.at(-1)?.type, "error");
});

test("does not retry a non-transient failure before any output", async () => {
  let calls = 0;
  const failure = new Error("Invalid API key (401)");
  const provider = mockProvider(async function* () {
    calls++;
    throw failure;
  });
  await assert.rejects(collect(generateStreamWithRetry(provider, params, 1)), failure);
  assert.equal(calls, 1);
});

test("does not call the provider for a cancelled run", async () => {
  let calls = 0;
  const provider = mockProvider(async function* () {
    calls++;
    yield { type: "done", content: "" };
  });
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await collect(generateStreamWithRetry(provider, { ...params, signal: controller.signal })), []);
  assert.equal(calls, 0);
});
