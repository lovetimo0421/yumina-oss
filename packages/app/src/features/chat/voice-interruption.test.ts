import test from "node:test";
import assert from "node:assert/strict";
import { VoiceActivityWindow, VoiceQuietWindow, meaningfulVoiceText, overlapsVoiceReference } from "./voice-interruption";

const official = "You said your mother lived here and tapped twice. This return concerns today: one resident, no dependants. A knock was heard.";
for (const [name, text, reference] of [
  ["observed first correction", "I said she used to live here.", official],
  ["observed second correction", "I did not say she is here now.", official],
  ["practical shared-word reply", "That knock is coming from upstairs.", official],
  ["shared two-word reply", "My mother lived abroad before moving away.", official],
  ["scattered matching words", "Today my mother asked about the return.", official],
  ["single token inside another word", "art", "The cart is ready."],
  ["reference token inside an input word", "Cart wheels need repair.", "art"],
  ["three-token substring boundary", "Noted, the cart is ready now.", "The art is ready later."],
  ["Unicode shared two-word reply", "Ma mère vivait ailleurs autrefois.", "Votre MÈRE vivait ici pendant longtemps."],
] as const) test(`lexical echo: retains ${name}`, () => {
  assert.equal(overlapsVoiceReference(text, reference), false);
});

for (const [name, text, reference] of [
  ["first-word echo", "You", official],
  ["full echo", official, official],
  ["contained output phrase", "your mother lived here", official],
  ["entire reference embedded in input", "No, explain the page, because I was asleep.", "Explain the page."],
  ["embedded three-word echo", "No, your mother lived abroad before moving away.", official],
  ["Unicode case and punctuation", "Non, MÈRE vivait ici, auparavant.", "Votre mère vivait ici pendant longtemps."],
  ["NFKC normalization", "Well, ＯＮＥ ＲＥＳＩＤＥＮＴ ＮＯ other people.", official],
  ["empty input", "", official],
  ["empty reference", "Actual words", ""],
  ["punctuation-only reference", "Actual words", "...?!"],
] as const) test(`lexical echo: rejects ${name}`, () => {
  assert.equal(overlapsVoiceReference(text, reference), true);
});

test("activity uses a full rolling600ms window and fresh bounded sample coverage", () => {
  const sustained = new VoiceActivityWindow(0);
  for (let at = 0; at < 600; at += 50) assert.equal(sustained.sample(at, 0.06), false);
  assert.equal(sustained.sample(599, 0.06), false); assert.equal(sustained.sample(600, 0.06), true);
  assert.equal(sustained.sample(600, 1), false, "A duplicated frame cannot reconfirm");
  assert.equal(sustained.sample(599, 1), false, "A stale frame cannot count");
  const impulse = new VoiceActivityWindow(0);
  for (let at = 0; at <= 2000; at += 50) assert.equal(impulse.sample(at, at < 100 ? 1 : 0), false);
  const stalled = new VoiceActivityWindow(0);
  assert.equal(stalled.sample(0, 1), false); assert.equal(stalled.sample(600, 1), false);
  for (let at = 650; at <= 900; at += 50) assert.equal(stalled.sample(at, 1), false);
  const gap = new VoiceActivityWindow(0);
  for (let at = 0; at <= 600; at += 50) assert.equal(gap.sample(at, at >= 200 && at <= 350 ? 0 : 1), false);
  for (const text of ["No", "不", "نعم", "4", "oui"]) assert.equal(meaningfulVoiceText(text), true);
  for (const text of ["", " ... ", "?!", "🎙️"]) assert.equal(meaningfulVoiceText(text), false);
});

test("quiet recovery gives pending semantic input 8000ms of fresh quiet", () => {
  const quiet = new VoiceQuietWindow();
  for (let at = 0; at <= 7950; at += 50) assert.equal(quiet.sample(at, 0), false);
  assert.equal(quiet.sample(7999, 0), false);
  assert.equal(quiet.sample(8000, 0), true);
});

test("active capture restarts the full quiet recovery grace", () => {
  const quiet = new VoiceQuietWindow();
  for (let at = 0; at <= 7950; at += 50) assert.equal(quiet.sample(at, 0), false);
  assert.equal(quiet.sample(8000, .06), false);
  for (let at = 8050; at <= 16000; at += 50) assert.equal(quiet.sample(at, 0), false);
  assert.equal(quiet.sample(16049, 0), false);
  assert.equal(quiet.sample(16050, 0), true);
});

for (const invalid of [NaN, Infinity, -Infinity, undefined]) {
  for (const field of ["time", "level"] as const) test(`quiet recovery cannot bridge missing or nonfinite ${field} (${invalid})`, () => {
    const quiet = new VoiceQuietWindow();
    for (let at = 0; at <= 7950; at += 50) assert.equal(quiet.sample(at, 0), false);
    assert.equal(quiet.sample(field === "time" ? invalid as number : 8000, field === "level" ? invalid as number : 0), false);
    for (let at = 8050; at <= 16000; at += 50) assert.equal(quiet.sample(at, 0), false);
    assert.equal(quiet.sample(16049, 0), false);
    assert.equal(quiet.sample(16050, 0), true);
  });
}

for (const interruption of [
  { name: "duplicate frame", at: 7950 },
  { name: "stale frame", at: 7900 },
  { name: "gap in capture", at: 8151 },
]) test(`quiet recovery cannot accumulate a prior grace across a ${interruption.name}`, () => {
  const quiet = new VoiceQuietWindow();
  for (let at = 0; at <= 7950; at += 50) assert.equal(quiet.sample(at, 0), false);
  assert.equal(quiet.sample(interruption.at, 0), false);
  for (let elapsed = 50; elapsed <= 7950; elapsed += 50) assert.equal(quiet.sample(interruption.at + elapsed, 0), false);
  assert.equal(quiet.sample(interruption.at + 7999, 0), false);
  assert.equal(quiet.sample(interruption.at + 8000, 0), true);
});
