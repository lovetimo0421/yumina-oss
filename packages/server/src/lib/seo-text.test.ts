import assert from "node:assert/strict";
import test from "node:test";
import { cleanMarkdown, stripLeadingTitle, summarizeText } from "./seo-text.js";

test("markdown symbols are removed, the words stay", () => {
  assert.equal(
    cleanMarkdown("# Oncin, the Weaver\n**Weave a world.** Live *inside* it. [Watch](https://x.y) it remember."),
    "Oncin, the Weaver Weave a world. Live inside it. Watch it remember.",
  );
  assert.equal(cleanMarkdown("- one\n- two\n\n> quoted"), "one two quoted");
  assert.equal(cleanMarkdown("A & B <b>bold</b> ~~gone~~ kept"), "A & B bold gone kept");
  assert.equal(cleanMarkdown("snake_case stays, 2 * 3 stays"), "snake_case stays, 2 * 3 stays");
});

test("a heading that repeats the name is dropped", () => {
  const raw = "# Oncin, the Weaver\n**Weave a world. Live inside it. Watch it remember.**\n\nOncin is a persistent AI world sandbox.";
  assert.equal(
    cleanMarkdown(stripLeadingTitle(raw, "Oncin, the Weaver")),
    "Weave a world. Live inside it. Watch it remember. Oncin is a persistent AI world sandbox.",
  );
  assert.equal(stripLeadingTitle("Plain start.\nMore.", "Other"), "Plain start.\nMore.");
});

test("short text is returned whole", () => {
  assert.equal(summarizeText("Your gothic girlfriend. "), "Your gothic girlfriend.");
});

test("whole sentences are kept while they fit", () => {
  const text =
    "Your high school bully's delinquent act was fake, and she has no survival skills. In the nuclear wastes, do you forgive her or get revenge? The panel keeps what the two of you are carrying, both your radiation doses, and more.";
  assert.equal(
    summarizeText(text),
    "Your high school bully's delinquent act was fake, and she has no survival skills. In the nuclear wastes, do you forgive her or get revenge?",
  );
});

test("a short first sentence runs on to a word boundary with an ellipsis", () => {
  const text =
    "The new professor and the quiet student who keeps staying after class. Every office hour you stay for is logged: what Professor Julien let slip, and how close the rest of the faculty is to noticing.";
  const out = summarizeText(text);
  assert.ok(out.endsWith("…"));
  assert.ok(out.length <= 155, `too long: ${out.length}`);
  assert.ok(out.startsWith("The new professor and the quiet student who keeps staying after class. Every office hour"));
  assert.doesNotMatch(out, /\s…$/);
});

test("Chinese text without spaces is cut cleanly", () => {
  const text = "嗨嗨大家好呀。最近好多小伙伴在各个版块发邀请码，帖子有点散散的。为了让大家更容易互相找到、版面也更清爽，官方开了这个互助专楼。分享自己的邀请码、找人互填、讨论邀请奖励，都欢迎直接在本楼留言，我们也会不定期整理置顶方便大家查找，谢谢配合。";
  const out = summarizeText(text, { max: 60 });
  assert.ok(out.length <= 60);
  assert.ok(out.endsWith("。") || out.endsWith("…"));
});
