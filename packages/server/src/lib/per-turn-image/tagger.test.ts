import assert from "node:assert/strict";
import test from "node:test";
import { askJson } from "./illustrate.js";
import { env } from "../env.js";

test("tagging switches reasoning off instead of spending the JSON budget on thinking", async (t) => {
  const prior = env.PER_TURN_TAG_MODEL;
  env.PER_TURN_TAG_MODEL = "deepseek/deepseek-v4.1-flash";
  t.after(() => { env.PER_TURN_TAG_MODEL = prior; });
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response('data: {"choices":[{"delta":{"content":"{\\"tags\\":\\"telescope\\"}"}}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
  });
  assert.deepEqual(await askJson("Return JSON tags.", "An empty observatory.", { userId: "test", sessionId: "test" }, 1400), { tags: "telescope" });
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0]!.reasoning, { effort: "none" });
  assert.equal(bodies[0]!.max_tokens, 1400);
});

test("a character the card doesn't know is drawn with the caption's sex, not 1girl by default", async () => {
  const { headCountFor } = await import("./illustrate.js");
  assert.equal(headCountFor("陸遠", "A tall muscular man with long black hair thrusts into the viewer on a bed."), "1boy");
  assert.equal(headCountFor("修女", "A nun in a black habit kneels before the viewer, a woman with grey eyes."), "1girl");
  assert.equal(headCountFor("老闆", ""), "1boy");
  assert.equal(headCountFor("the stranger", "Two figures stand in the rain."), "1girl");
});

test("an endpoint that refuses to switch reasoning off is asked once more thinking low", async (t) => {
  const prior = env.PER_TURN_TAG_MODEL;
  env.PER_TURN_TAG_MODEL = "google/gemini-3.5-flash";
  t.after(() => { env.PER_TURN_TAG_MODEL = prior; });
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    if (body.reasoning?.effort === "none") {
      return new Response(JSON.stringify({ error: { message: "Reasoning is mandatory for this endpoint and cannot be disabled.", code: 400 } }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    return new Response('data: {"choices":[{"delta":{"content":"{\\"tags\\":\\"telescope\\"}"}}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
  });
  assert.deepEqual(await askJson("Return JSON tags.", "An empty observatory.", { userId: "test", sessionId: "test" }, 1400), { tags: "telescope" });
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0]!.reasoning, { effort: "none" });
  assert.deepEqual(bodies[1]!.reasoning, { effort: "low" });
});

test("a content block on the player's own key is not a key refusal: the key stays usable and the next tagger is asked", async (t) => {
  const { playerKeyDenied, resetPlayerKeyDenials } = await import("../side-call-key.js");
  const prior = env.PER_TURN_TAG_MODEL;
  env.PER_TURN_TAG_MODEL = "google/gemini-2.5-flash,x-ai/grok-4.3";
  resetPlayerKeyDenials();
  t.after(() => { env.PER_TURN_TAG_MODEL = prior; resetPlayerKeyDenials(); });
  const calls: { model: string; auth: string }[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ model: body.model, auth: String((init?.headers as Record<string, string>)?.Authorization ?? (init?.headers as Record<string, string>)?.authorization ?? "") });
    if (body.model === "google/gemini-2.5-flash") {
      return new Response(JSON.stringify({ error: { message: "Gemini blocked the request: PROHIBITED_CONTENT", code: 403 } }), { status: 403, headers: { "Content-Type": "application/json" } });
    }
    return new Response('data: {"choices":[{"delta":{"content":"{\\"tags\\":\\"telescope\\"}"}}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
  });
  const playerKey = { userId: "p1", apiKey: "sk-or-player-key" };
  assert.deepEqual(await askJson("Return JSON tags.", "An empty observatory.", { userId: "p1", sessionId: "s", playerKey }, 1400), { tags: "telescope" });
  assert.equal(playerKeyDenied(playerKey, "chat"), false, "a content block must not mark the player's key denied");
  // Gemini was asked once, on the player's key only (no platform-key retry of a content block); grok answered on the player's key.
  assert.deepEqual(calls.map((c) => c.model), ["google/gemini-2.5-flash", "x-ai/grok-4.3"]);
  assert.ok(calls.every((c) => c.auth.includes("sk-or-player-key")));
});
