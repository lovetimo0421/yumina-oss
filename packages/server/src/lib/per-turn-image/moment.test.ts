import assert from "node:assert/strict";
import test from "node:test";
import { buildTurnWorkflow, dedupeTags, momentText } from "./illustrate.js";
import { negativeFor, normalizeTags } from "./age.js";

test("the final moment is the reply's last paragraphs; menus and state blocks are not story", () => {
  const reply = [
    "她先是坐在沙发上，用丝袜脚踩着你。",
    "过了好一会儿，她收回长腿，站起身，给你倒了一杯温水。",
    "“晚饭还热着，你想在这吃吗？”",
    "【去向】",
    "- 留下吃饭",
    "- 回房睡觉",
    '[surroundings: {"地": "包厢", "人": []}]',
  ].join("\n");
  const { final } = momentText(reply);
  assert.match(final, /倒了一杯温水/);
  assert.doesNotMatch(final, /去向|留下吃饭|surroundings/);
});

test("one long paragraph: only its last sentences are the final moment", () => {
  const body = "他们在走廊里说了很久的话。".repeat(80);
  const { before, final } = momentText(`${body}她转身离开了教室。`);
  assert.ok(final.length < 900);
  assert.match(final, /她转身离开了教室。$/);
  assert.ok(before.length > 0);
});

test("choice lists and speaker tags are stripped, the dialogue kept", () => {
  const { final } = momentText('<speaker id="gojo">那么，告诉我吧。</speaker>\n<options><option>A</option></options>');
  assert.match(final, /gojo: 那么，告诉我吧。/);
  assert.doesNotMatch(final, /option/);
});

test("a status panel at the top of a reply doesn't cut the story after it", () => {
  const story = "她推开门走进来，把湿透的外套挂在椅背上，在你对面坐下。".repeat(20);
  const { before, final } = momentText(`【状态】体力 80\n${story}\n她抬头看着你笑了。`);
  assert.match(final, /她抬头看着你笑了。/);
  assert.ok((before + final).length > story.length / 2);
});

test("a reply that is only a menu is kept rather than emptied", () => {
  const { final } = momentText("【去向】\n- 留下\n- 离开");
  assert.ok(final.length > 0);
});

test("dedupeTags keeps each tag once and weighted groups whole", () => {
  assert.equal(dedupeTags("black hair, smile, Black_Hair, (footjob, cum:1.25), smile"), "black hair, smile, (footjob, cum:1.25)");
});

test("an adult never keeps teen tags; a minor does", () => {
  assert.doesNotMatch(normalizeTags("1girl, teenage, black hair", false), /teen/);
  assert.match(normalizeTags("1girl, teenage, black hair", true), /teenage/);
});

test("an ordinary adult moment pushes nudity away; an explicit one doesn't", () => {
  assert.match(negativeFor(false, true), /\bnude\b/);
  assert.doesNotMatch(negativeFor(false, false), /\bnude\b/);
  assert.match(negativeFor(false), /\bcollage\b/);
});

test("a full-step recipe keeps the negative prompt in play (cfg above 1)", () => {
  const g = buildTurnWorkflow({ scene: "1girl", bodies: [] }, 1, "bad", {
    checkpoint: "x.safetensors", loras: [], steps: 24, cfg: 5, sampler: "euler_ancestral", scheduler: "normal", styleReference: false,
  } as never) as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  const ks = Object.values(g).find((n) => n.class_type === "KSampler")!;
  assert.ok((ks.inputs.cfg as number) > 1);
});

test("an outfit the story established outlasts turns that don't mention clothes", async () => {
  const { outfitFor } = await import("./illustrate.js");
  // Nothing said this turn: the remembered sweater, not the card's guess.
  assert.equal(outfitFor("", false, "black oversized sweater", "t-shirt, shorts"), "black oversized sweater");
  // A passing state goes on top of what they wear.
  assert.equal(outfitFor("sleeves rolled up", false, "black oversized sweater", "t-shirt"), "black oversized sweater, sleeves rolled up");
  // Changed clothes replace it.
  assert.equal(outfitFor("red sundress", true, "black oversized sweater", "t-shirt"), "red sundress");
  // Undressed: no clothes underneath.
  assert.equal(outfitFor("nude", false, "black oversized sweater", "t-shirt"), "nude");
  // Nothing known yet: the card's usual clothes.
  assert.equal(outfitFor("", false, undefined, "t-shirt, shorts"), "t-shirt, shorts");
});
