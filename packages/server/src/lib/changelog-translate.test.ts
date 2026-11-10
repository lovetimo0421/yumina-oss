import assert from "node:assert/strict";
import test from "node:test";
import { CHANGELOG_TRANSLATE_MODEL, ChangelogTranslateError, translateChangelogEntry } from "./changelog-translate.js";

const INPUT = { title: { zh: "标题", en: "Title" }, body: { zh: "· 内容", en: "· Body" } };
const ANSWER = { "zh-Hant": { title: "標題", body: "· 內容" }, es: { title: "Título", body: "· Cuerpo" }, ja: { title: "タイトル", body: "· 本文" } };

function fakeFetch(content: string, finish = "stop") {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ model: "google/gemini-2.5-flash-001", choices: [{ finish_reason: finish, message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }));
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("one call, JSON out, usage recorded as changelog-translate", async () => {
  const { impl, calls } = fakeFetch("```json\n" + JSON.stringify(ANSWER) + "\n```");
  const logged: Array<Record<string, unknown>> = [];
  const out = await translateChangelogEntry(INPUT, { userId: "admin", apiKey: "k", fetchImpl: impl, recordUsageLog: (async (row: Record<string, unknown>) => { logged.push(row); }) as never });
  assert.deepEqual(out, ANSWER);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /openrouter\.ai\/api\/v1\/chat\/completions$/);
  assert.equal(calls[0]!.body.model, CHANGELOG_TRANSLATE_MODEL);
  assert.equal(logged.length, 1);
  assert.equal(logged[0]!.endpoint, "changelog-translate");
  assert.equal(logged[0]!.apiKeyTier, "internal");
  assert.equal(logged[0]!.totalTokens, 150);
});

test("a missing language, unreadable JSON, a cut-off answer or no key are clear errors", async () => {
  const run = (content: string, finish = "stop", apiKey = "k") =>
    translateChangelogEntry(INPUT, { userId: "admin", apiKey, fetchImpl: fakeFetch(content, finish).impl, recordUsageLog: (async () => {}) as never });
  await assert.rejects(run(JSON.stringify({ ...ANSWER, ja: { title: "", body: "x" } })), (e: Error) => e instanceof ChangelogTranslateError && /ja/.test(e.message));
  await assert.rejects(run("not json"), /unreadable/);
  await assert.rejects(run(JSON.stringify(ANSWER), "length"), /cut off/);
  await assert.rejects(run(JSON.stringify(ANSWER), "stop", ""), (e: Error) => e instanceof ChangelogTranslateError && e.reason === "unavailable");
});
