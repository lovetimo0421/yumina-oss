import assert from "node:assert/strict";
import test from "node:test";
import { cardLiterals, lostMarkers, lostPatterns, restoreMarkers, riskyPattern } from "../card-translate-literals.js";
import { translateCard, type ChatFn } from "../card-translate.js";
import { CardPatternRunner } from "./runner.js";

// Exponential on a long unclosed bracket ((\w|\w)* tries 2^n splits), and not a shape riskyPattern catches, so
// only the worker's clock stands between it and the server.
const CATASTROPHIC = String.raw`^【(\w|\w)*】$`;
const unclosed = (n: number) => "【" + "a".repeat(n);

test("riskyPattern: nested repetition and repeated backreferences are rejected; delimited repeats and formats are not", () => {
  for (const p of [String.raw`(a+)+$`, String.raw`^(\w+\s?)*:$`, String.raw`(?:x*y?)*z`, String.raw`(a{1,30}){2,}`, String.raw`(\w)\1+`, "x".repeat(1001)]) assert.equal(riskyPattern(p), true, p);
  for (const p of [String.raw`^(?:【Bella】|\[Bella\])\s*([\s\S]*)$`, String.raw`(?:\[[^\]]+\]\s*)+`, String.raw`<(\w+)>([^<]*)<\/\1>`, String.raw`^【(Bella|Luna)】`, String.raw`\b(near|close|bedside)\b`, String.raw`(?<![\p{L}])'([^'\n]{2,40})'`, CATASTROPHIC]) assert.equal(riskyPattern(p), false, p);
  // A rejected pattern is simply not a format the translator checks.
  const lit = cardLiterals({ rootComponent: { files: { "a.tsx": "const S = /^【(\\w+\\s?)+】$/; export const f = (t) => S.test(t);" } } });
  assert.deepEqual(lit.patterns, []);
});

test("a runaway card pattern is stopped within the time limit and dropped; the other patterns give the plain results", async () => {
  const code = `const SPEAKER = /^【(Bella|Luna)】/; const BAD = /${CATASTROPHIC}/; export const f = (t) => SPEAKER.test(t) || BAD.test(t);`;
  const lit = cardLiterals({ rootComponent: { files: { "a.tsx": code } } });
  assert.equal(lit.patterns.length, 2, "both are formats the plain reader keeps");
  const rx = new CardPatternRunner({ patternMs: 200 });
  try {
    const viaWorker = await rx.literals({ rootComponent: { files: { "a.tsx": code } } });
    assert.deepEqual(viaWorker.patterns.map((p) => p.src), lit.patterns.map((p) => p.src), "reading the code runs nothing catastrophic");
    const src = "【Bella】Oh my, the hero is awake.\n" + unclosed(60);
    const out = "【贝拉】哎呀，勇者醒了。\n" + unclosed(60);
    const started = Date.now();
    const check = await rx.check(src, out, lit.patterns, true);
    assert.ok(Date.now() - started < 3_000, `stopped in ${Date.now() - started}ms`);
    assert.deepEqual(rx.skipped, [new RegExp(CATASTROPHIC).source]);
    assert.match(rx.notes.join(), /too slow/);
    const good = lit.patterns.filter((p) => p.src.includes("Bella|Luna"));
    assert.deepEqual(check, { lost: lostPatterns(src, out, good, true).map((p) => ({ src: p.src, sample: "【Bella】" })), markers: lostMarkers(src, out, good) });
    assert.equal(check.lost.length, 1, "the speaker tag the translation lost is still caught");
    // Later steps leave the dropped pattern out without stopping again, and match the plain function.
    const t2 = Date.now();
    assert.deepEqual(await rx.restore(src, out, lit, true), restoreMarkers(src, out, { ...lit, patterns: good }, true));
    assert.ok(Date.now() - t2 < 1_000);
  } finally {
    rx.close();
  }
});

test("a runaway keyword scan in the card's code is stopped while the code is read; the other literals survive", async () => {
  // Not a format (no brackets, no anchor): a keyword scan, run against the values the variable lists.
  const scan = String.raw`(?:near|close|\w|\w)*$`;
  const code = `const NEAR = /${scan}/i; const MOODS = { Smug: "@asset:s", Shy: "@asset:h" }; export const f = (d) => NEAR.test(d) && d === "duel";`;
  const schema = {
    rootComponent: { files: { "a.tsx": code } },
    variables: [{ id: "distance", type: "string", behaviorRules: `One of: ${"x".repeat(30)} near / close / far` }],
  };
  const rx = new CardPatternRunner({ patternMs: 200 });
  try {
    const started = Date.now();
    const lit = await rx.literals(schema);
    assert.ok(Date.now() - started < 5_000, `read in ${Date.now() - started}ms`);
    assert.equal(rx.skipped.length, 1);
    assert.match(rx.skipped[0]!, /near\|close/);
    assert.ok(lit.keys.has("Smug") && lit.values.has("duel"), "lookup keys and compared values are still protected");
    assert.deepEqual(lit.scans, []);
  } finally {
    rx.close();
  }
});

test("translateCard on a card with a catastrophic format pattern finishes quickly and keeps the server responsive", async () => {
  const schema = {
    entries: [{ id: "g", name: "Opening", role: "greeting", content: "【Bella】She waits for you at the door.\n" + unclosed(40) + "\nThe rain keeps falling on the roof.", keywords: [] }],
    variables: [], rules: [], settings: {},
    rootComponent: { entryFile: "index.tsx", files: { "index.tsx": `const SPEAKER = /^【(Bella|Luna)】/; const BAD = /${CATASTROPHIC}/; export default function R(p){ return <div>{SPEAKER.test(p.t) || BAD.test(p.t) ? "A" : "B"}</div>; }` } },
  };
  let rules = "";
  const chat: ChatFn = async (messages) => {
    await new Promise((r) => setTimeout(r, 1));
    const sys = messages[0]!.content, user = messages[messages.length - 1]!.content;
    if (sys.startsWith("You build a translation glossary")) return { text: '{"terms":{}}', costUsd: 0, model: "m" };
    if (user.startsWith("File ")) return { text: "```tsx\n" + schema.rootComponent.files["index.tsx"] + "\n```", costUsd: 0, model: "m" };
    if (sys.startsWith("You translate an interactive-fiction card")) rules = sys;
    const obj = JSON.parse(user.slice(user.indexOf("{")));
    return { text: JSON.stringify(Object.fromEntries(Object.keys(obj).map((k) => [k, k === "entry.0.content" ? "【贝拉】她在门口等你。\n" + unclosed(40) + "\n雨一直下。" : "门"]))), costUsd: 0, model: "m" };
  };
  // The event loop must keep turning while the pattern runs: a timer that fires late shows a blocked thread.
  let worstLag = 0, last = Date.now();
  const ticker = setInterval(() => { const now = Date.now(); worstLag = Math.max(worstLag, now - last - 20); last = now; }, 20);
  const started = Date.now();
  try {
    const r = await translateCard({ name: "Door", description: "A quiet door and a rainy night.", schema, sourceLang: "en", targetLang: "zh" }, chat);
    const took = Date.now() - started;
    assert.ok(took < 10_000, `finished in ${took}ms`);
    assert.ok(worstLag < 300, `event loop blocked for ${worstLag}ms`);
    assert.ok(r.report.warnings.some((w) => w.includes("too slow") && w.includes("(\\w|\\w)")), r.report.warnings.join("; "));
    assert.match(rules, /【Bella】/, "the good pattern still names its marker for the translator");
    assert.equal(r.schema.entries[0].content.split("\n")[0], "【贝拉】她在门口等你。".replace("贝拉", "Bella"), "and its marker is still restored");
  } finally {
    clearInterval(ticker);
  }
});
