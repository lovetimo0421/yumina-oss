import test from "node:test";
import assert from "node:assert/strict";
import type { Reaction, Variable } from "@yumina/engine";
import { reactionSummary } from "./reaction-summary.js";

const VARS = new Map<string, Variable>([
  ["affection-1", { id: "affection-1", name: "好感度", type: "number", defaultValue: 0 } as Variable],
]);

const LABELS = { everyTurn: "每回合", ifMark: "有条件" };

const reaction = (over: Partial<Reaction>): Reaction =>
  ({
    id: "r1",
    name: "R",
    when: { eventType: "turn:complete" },
    conditions: [],
    conditionLogic: "all",
    then: [],
    priority: 0,
    enabled: true,
    ...over,
  }) as Reaction;

test("a set effect reads as the thing itself, by variable NAME", () => {
  const s = reactionSummary(
    reaction({ then: [{ type: "set", path: "affection-1", operation: "add", value: 5 }] }),
    VARS,
    LABELS,
  );
  assert.equal(s, "每回合 · 好感度+5");
});

test("extra effects fold into a +N, and emits read as arrows", () => {
  const s = reactionSummary(
    reaction({
      when: { eventType: "damage:taken" },
      then: [
        { type: "emit", event: { type: "scream" } },
        { type: "set", path: "affection-1", operation: "subtract", value: 1 },
      ],
    }),
    VARS,
    LABELS,
  );
  assert.equal(s, "damage:taken · →scream +1");
});

test("conditions surface as the if-marker", () => {
  const s = reactionSummary(
    reaction({
      conditions: [{ variableId: "affection-1", operator: "gte", value: 50 }],
      then: [{ type: "set", path: "affection-1", operation: "set", value: 0 }],
    }),
    VARS,
    LABELS,
  );
  assert.ok(s.includes("有条件"));
  assert.ok(s.includes("好感度=0"));
});

test("a dot-path keeps the variable's name and the rest of the path", () => {
  const s = reactionSummary(
    reaction({ then: [{ type: "set", path: "affection-1.history[0]", operation: "set", value: 1 }] }),
    VARS,
    LABELS,
  );
  assert.ok(s.includes("好感度.history[0]=1"));
});

test("random and ref values stay legible without dumping their spec", () => {
  const s = reactionSummary(
    reaction({
      then: [
        { type: "set", path: "affection-1", operation: "set", value: 0, valueRandom: { kind: "range", min: 1, max: 6 } },
      ],
    }),
    VARS,
    LABELS,
  );
  assert.ok(s.includes("好感度=🎲"));
});

test("an effectless behaviour still says when it fires", () => {
  assert.equal(reactionSummary(reaction({}), VARS, LABELS), "每回合");
});

test("an empty every-turn label omits the when-part entirely", () => {
  const s = reactionSummary(
    reaction({ then: [{ type: "set", path: "affection-1", operation: "add", value: 5 }] }),
    VARS,
    { everyTurn: "", ifMark: "有条件" },
  );
  assert.equal(s, "好感度+5");
});

test("engine paths read as words, and macros as names — never @prompt.context or {{interpolate(…", () => {
  const s = reactionSummary(
    reaction({ then: [{ type: "set", path: "@prompt.context", value: "{{hp}} 已经过半：{{interpolate(vars, \"hp\")}} 开始叫名字", operation: "set" }] }),
    VARS,
    { ...LABELS, tellAi: "告诉 AI", entryOn: "开启词条", entryOff: "关闭词条", varOn: "启用", varOff: "停用" },
  );
  assert.doesNotMatch(s, /@prompt|interpolate/);
  assert.match(s, /告诉 AI「/);
});
