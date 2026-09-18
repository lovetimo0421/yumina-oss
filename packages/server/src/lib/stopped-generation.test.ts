import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchOpenRouterGenerationCost } from "./stopped-generation.js";

const noSleep = async () => {};

function response(status: number, body?: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

describe("fetchOpenRouterGenerationCost", () => {
  it("returns the billed cost and native token counts once the record exists", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      calls.push(String((init?.headers as Record<string, string>).Authorization));
      if (calls.length === 1) return response(404);
      return response(200, {
        data: { total_cost: 0.0421, native_tokens_prompt: 91234, native_tokens_completion: 512, tokens_prompt: 80000 },
      });
    }) as unknown as typeof fetch;
    const got = await fetchOpenRouterGenerationCost("gen-1", ["k1"], { delaysMs: [0, 0, 0], fetchImpl, sleep: noSleep });
    assert.deepEqual(got, { costUsd: 0.0421, promptTokens: 91234, completionTokens: 512 });
    assert.deepEqual(calls, ["Bearer k1", "Bearer k1"]);
  });

  it("tries the next key on 404 and gives up after the retry budget", async () => {
    let n = 0;
    const fetchImpl = (async () => { n++; return response(404); }) as unknown as typeof fetch;
    const got = await fetchOpenRouterGenerationCost("gen-2", ["k1", "k2"], { delaysMs: [0, 0], fetchImpl, sleep: noSleep });
    assert.equal(got, null);
    assert.equal(n, 4);
  });

  it("ignores records without a numeric total_cost", async () => {
    const fetchImpl = (async () => response(200, { data: { total_cost: null } })) as unknown as typeof fetch;
    const got = await fetchOpenRouterGenerationCost("gen-3", ["k1"], { delaysMs: [0], fetchImpl, sleep: noSleep });
    assert.equal(got, null);
  });

  it("returns null with no request id or no keys", async () => {
    assert.equal(await fetchOpenRouterGenerationCost("", ["k1"], { delaysMs: [0], sleep: noSleep }), null);
    assert.equal(await fetchOpenRouterGenerationCost("gen-4", [], { delaysMs: [0], sleep: noSleep }), null);
  });
});
