import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { GameStateManager, type WorldDefinition } from "@yumina/engine";
import { appendJudgeImages, applyJudgeSceneImages, runContinuityTurn } from "./run.js";
import { env } from "../env.js";

// The judge runs inside every turn for every key mode (official, BYOK, custom
// endpoint, local model) after the reply has already been generated — and, on
// a player's own key, already paid for. Whatever goes wrong on the judge's
// side must leave the turn exactly as if the judge were off.

const originalFetch = globalThis.fetch;
const originalKey = env.YUMINA_OPENROUTER_KEY;
beforeEach(() => { (env as { YUMINA_OPENROUTER_KEY: string }).YUMINA_OPENROUTER_KEY = "platform-key"; });
afterEach(() => { globalThis.fetch = originalFetch; (env as { YUMINA_OPENROUTER_KEY: string }).YUMINA_OPENROUTER_KEY = originalKey; });

function world(variables: unknown[]): WorldDefinition {
  return { id: "w", name: "w", description: "", version: "1", language: "zh", variables, rules: [], components: [], audioTracks: [], entries: [], settings: {} } as unknown as WorldDefinition;
}

function args(w: WorldDefinition) {
  return {
    world: w, stateManager: new GameStateManager(w), playerText: "hi", replyText: "她笑了。",
    hasAudioDirective: false, userId: "u", sessionId: "s", path: "send" as const,
  };
}

test("card data the plan builder can't read skips the judge instead of throwing", async () => {
  let called = false;
  globalThis.fetch = (async () => { called = true; return new Response("{}"); }) as typeof fetch;
  // A precise string variable whose options were saved as numbers by an old import.
  const w = world([{ id: "mood", name: "mood", type: "string", precise: true, defaultValue: "a", options: [1, 2] }]);
  const out = await runContinuityTurn(args(w));
  assert.equal(out.ran, false);
  assert.deepEqual(out.effects, []);
  assert.deepEqual(out.audioEffects, []);
  assert.equal(called, false);
});

test("a failing decision endpoint leaves the turn untouched", async () => {
  globalThis.fetch = (async () => new Response("upstream down", { status: 502 })) as typeof fetch;
  const w = world([{ id: "hp", name: "hp", type: "number", precise: true, defaultValue: 5, deltaUp: 1, deltaDown: 1 }]);
  const out = await runContinuityTurn(args(w));
  assert.equal(out.ran, false);
  assert.deepEqual(out.effects, []);
});

test("a turn on the player's OpenRouter key runs the judge on it; a lookup failure keeps the platform key", async () => {
  const keys: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    keys.push(String((init?.headers as Record<string, string>).Authorization).replace(/^Bearer /, ""));
    return new Response(JSON.stringify({ answers: {}, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
  }) as typeof fetch;
  const w = world([{ id: "hp", name: "hp", type: "number", precise: true, defaultValue: 5, deltaUp: 1, deltaDown: 1 }]);
  const byok = await runContinuityTurn({ ...args(w), userId: `u-${crypto.randomUUID()}`, playerOpenRouterKey: async () => "sk-or-v1-turn" });
  assert.equal(byok.ran, true);
  assert.deepEqual(keys, ["sk-or-v1-turn"]);

  keys.length = 0;
  const failed = await runContinuityTurn({ ...args(w), playerOpenRouterKey: async () => { throw new Error("db down"); } });
  assert.equal(failed.ran, true);
  assert.deepEqual(keys, ["platform-key"]);

  keys.length = 0;
  await runContinuityTurn(args(w));
  assert.deepEqual(keys, ["platform-key"]);
});

test("judge-picked scene images append one [image: id] line each and expand to embeds", async () => {
  const { resolveSceneImageDirectives } = await import("@yumina/engine");
  assert.equal(appendJudgeImages("她笑了。", []), "她笑了。");
  const text = appendJudgeImages("她笑了。\n", ["cup", "cafe"]);
  assert.equal(text, "她笑了。\n\n[image: cup]\n\n[image: cafe]");
  const images = [
    { id: "cup", name: "Cup", url: "https://x/cup.png", scene: "任何情况下，每次回复后，发送这个图片" },
    { id: "cafe", name: "Cafe", url: "https://x/cafe.png", scene: "两人在咖啡店对坐时" },
  ];
  const out = resolveSceneImageDirectives(text, images);
  assert.deepEqual(out.shown.map((i) => i.id), ["cup", "cafe"]);
  assert.match(out.text, /\[image:https:\/\/x\/cup\.png\|alt=Cup\|scene=cup\]/);
});

test("copied scene image embeds are dropped when the judge decides, kept as directives otherwise", async () => {
  const { sceneImageEmbed, resolveSceneImageDirectives } = await import("@yumina/engine");
  const img = { id: "cafe", name: "Cafe", url: "https://x/cafe.png", scene: "两人在咖啡店对坐时" };
  const copied = `她笑了。\n\n${sceneImageEmbed(img)}\n\n雨还在下。`;
  const judged = { ...world([]), sceneImages: [img] } as WorldDefinition;
  assert.equal(applyJudgeSceneImages(judged, copied, { ran: true, imageIds: [] }), "她笑了。\n\n雨还在下。");
  assert.equal(applyJudgeSceneImages(judged, copied, { ran: true, imageIds: ["cafe"] }), "她笑了。\n\n雨还在下。\n\n[image: cafe]");
  const narrator = { ...judged, continuity: { enabled: false } } as WorldDefinition;
  const kept = applyJudgeSceneImages(narrator, copied, { ran: false, imageIds: [] });
  assert.equal(kept, "她笑了。\n\n[image: cafe]\n\n雨还在下。");
  assert.deepEqual(resolveSceneImageDirectives(kept, [img]).shown.map((i) => i.id), ["cafe"]);
});
