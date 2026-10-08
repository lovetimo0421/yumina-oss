import assert from "node:assert/strict";
import test from "node:test";
import type { WorldEntry } from "@yumina/engine";
import { entryTokens, summarizeLoreTokens } from "./lore-tokens";

const entry = (id: string, over: Partial<WorldEntry>): WorldEntry => ({
  id, name: id, content: "雾苔镇尽头的小酒馆，老板娘是一朵会说话的蘑菇。", keywords: [], enabled: true,
  ...over,
} as WorldEntry);

test("each piece of lore lands in the bucket that says when it is sent", () => {
  const entries = [
    entry("open", { role: "greeting" }),
    entry("open2", { role: "greeting", alwaysSend: true }),
    entry("world", { alwaysSend: true }),
    entry("cellar", { keywords: ["地窖"] }),
    entry("night", { conditions: [{ variableId: "time", operator: "eq", value: "夜里" }] as WorldEntry["conditions"] }),
    entry("standby", {}),
    entry("off", { enabled: false, alwaysSend: true }),
  ];
  const one = entryTokens(entries[0]!);
  const s = summarizeLoreTokens(entries);
  assert.equal(s.greeting, 2 * one, "an opening is sent once, whatever its switch says");
  assert.equal(s.greetingCount, 2);
  assert.equal(s.alwaysSent, one);
  assert.equal(s.perTurn, s.alwaysSent, "per turn is only what goes out every turn");
  assert.equal(s.keywordTriggered, 2 * one, "a condition waits like a keyword does");
  assert.equal(s.dormant, one, "standby lore: no switch, no keyword, no condition");
  assert.equal(s.disabled, one);
  assert.equal(s.total, 7 * one);
  assert.equal(s.health, "healthy");
});

test("the dot turns yellow past 30k and red past 60k", () => {
  const big = (n: number) => summarizeLoreTokens([entry("x", { alwaysSend: true, content: "酒".repeat(n) })]).health;
  assert.equal(big(10), "healthy");
  const per = entryTokens(entry("probe", { content: "酒".repeat(1000) })) / 1000;
  assert.equal(big(Math.ceil(40_000 / per)), "caution");
  assert.equal(big(Math.ceil(70_000 / per)), "heavy");
});
