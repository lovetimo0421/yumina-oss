import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cardReadiness } from "./card-readiness";

type Entry = { id: string; role: string; content: string };

const world = (over: Partial<{
  name: string;
  entries: Entry[];
  variables: unknown[];
  reactions: unknown[];
  rules: unknown[];
  avatar: string;
}> = {}) => ({
  name: "A rainy port",
  entries: [] as never[],
  variables: [] as never[],
  ...over,
} as Parameters<typeof cardReadiness>[0]);

const greeting = (content: string): Entry => ({ id: "g", role: "greeting", content });
const lore = (content: string): Entry => ({ id: "l", role: "lore", content });

describe("cardReadiness", () => {
  it("counts a blank card as nothing done", () => {
    const r = cardReadiness(world({ name: "Character Chat" }));
    assert.equal(r.doneRequired, 0);
    assert.equal(r.totalRequired, 4);
    assert.deepEqual(r.missing.map((m) => m.id), ["name", "cover", "opening", "setting"]);
  });

  it("does not count a template placeholder as written", () => {
    // The thing a new card actually ships with: bracketed guidance the
    // template wrote. Treating it as content is how a card reaches publish
    // still saying "[the first thing players see]".
    const r = cardReadiness(world({
      entries: [greeting("[玩家进入你世界的第一刻——这段开场白决定 AI 之后的写作。]"), lore("[这是什么世界？]")],
    }));
    assert.equal(r.items.find((i) => i.id === "opening")!.done, false);
    assert.equal(r.items.find((i) => i.id === "setting")!.done, false);
  });

  it("counts real writing, in brackets or not", () => {
    const r = cardReadiness(world({
      entries: [greeting("雨把整座城压得很低。"), lore("这座港口靠走私活着。")],
    }));
    assert.equal(r.items.find((i) => i.id === "opening")!.count, 1);
    assert.equal(r.items.find((i) => i.id === "setting")!.count, 1);
  });

  it("keeps a card that opens with a bracketed aside", () => {
    // "[She is already gone.] The door swings." starts with a bracket but is
    // not a placeholder — only a body that is ENTIRELY one bracketed block is.
    const r = cardReadiness(world({ entries: [greeting("[她已经走了] 门还在晃。")] }));
    assert.equal(r.items.find((i) => i.id === "opening")!.done, true);
  });

  it("treats the template's own name as unset", () => {
    assert.equal(cardReadiness(world({ name: "World Simulation" })).items[0]!.done, false);
    assert.equal(cardReadiness(world({ name: "雨港茶馆" })).items[0]!.done, true);
  });

  it("never makes mechanics a requirement", () => {
    // A pure-prose card is a finished card.
    const r = cardReadiness(world({
      name: "Named",
      avatar: "@asset:1",
      entries: [greeting("Real words."), lore("Real lore.")],
    }));
    assert.equal(r.doneRequired, r.totalRequired);
    assert.deepEqual(r.missing, []);
    assert.equal(r.items.find((i) => i.id === "mechanics")!.required, false);
    // …but it still shows as an unticked line in the full count.
    assert.equal(r.done, 4);
    assert.equal(r.total, 5);
  });

  it("counts variables and behaviours together as mechanics", () => {
    const r = cardReadiness(world({ variables: [{}, {}], reactions: [{}, {}, {}, {}] }));
    const mechanics = r.items.find((i) => i.id === "mechanics")!;
    assert.equal(mechanics.done, true);
    assert.equal(mechanics.count, 6);
  });

  it("still counts legacy rule-based behaviours", () => {
    const r = cardReadiness(world({ rules: [{}] }));
    assert.equal(r.items.find((i) => i.id === "mechanics")!.done, true);
  });
});
