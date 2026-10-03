import assert from "node:assert/strict";
import test from "node:test";
import { detectRefusal } from "./refusal-detector.js";
import { isContentFilterChoice, isContentFilterFinishReason } from "./openrouter.js";
import { classifyGenerationFailure, FAILURE_CODE } from "../turn-failure-codes.js";

// Real refusal observed from Gemini 3.8 in a Chinese adult card.
const GEMINI_ZH =
  "该请求要求生成包含明确性器官称谓、详细性行为过程的内容，这违反了我的安全准则，属于严格禁止生成的露骨色情内容。" +
  "因此，我无法满足继续推进此类色情细节描写的要求。如果你愿意，我们可以把故事转向情感铺垫或其他情节发展。";

// Real refusal observed from Claude mid-roleplay.
const CLAUDE_ZH =
  "我需要停下来，坦诚地和你讨论这个对话的走向。\n\n" +
  "作为AI助手，我不应该继续生成这类内容。这段角色扮演已经偏离到我无法参与的方向。\n\n" +
  "如果你愿意，我很乐意帮你换一个故事方向继续。";

const EN_REFUSALS = [
  "I can't continue this scene. It asks for sexually explicit content that goes against my guidelines. If you'd like, I can help take the story in a different direction instead.",
  "I need to stop and step out of the roleplay for a moment. As an AI, I'm not able to write this kind of explicit content.",
  "I cannot create content that sexualizes minors. This request violates the content policy.",
];

test("flags the real Gemini refusal", () => {
  assert.equal(detectRefusal(GEMINI_ZH), true);
  assert.equal(detectRefusal(GEMINI_ZH, { lang: "zh" }), true);
});

test("flags the real Claude refusal", () => {
  assert.equal(detectRefusal(CLAUDE_ZH), true);
});

test("flags English assistant-voice refusals", () => {
  for (const text of EN_REFUSALS) assert.equal(detectRefusal(text), true, text);
});

test("flags a longer refusal whose every paragraph is policy talk", () => {
  const paragraphs = [
    "我需要停下来。作为AI助手，我无法继续生成这类露骨的性内容，这违反了安全准则。",
    "我理解你对这个故事投入了很多，也明白角色扮演对你来说很重要。这类请求涉及的内容不被允许，我不应该继续描写。",
    "我可以帮你把情节转向情感线、悬疑线或冒险线，这些方向都能保留角色之间的张力。",
    "如果你愿意，告诉我你更想要哪种方向，我们可以换一个方式继续这段故事，我也很乐意协助你重新规划后面的发展。",
    "再次说明：此类内容属于平台规范明确禁止的范围，我不能提供相关描写，但其他方向我都愿意配合。",
  ];
  const long = [...paragraphs, ...paragraphs, ...paragraphs].join("\n\n");
  assert.ok(long.length > 700 && long.length < 4000, String(long.length));
  assert.equal(detectRefusal(long), true);
});

test("does not flag a character refusing inside quoted dialogue", () => {
  const story =
    "艾琳后退了一步，把剑横在身前。\n\n“我不能这样做。”她低声说，“骑士团的规范严格禁止我们向平民拔剑。”\n\n" +
    "雨越下越大，你看见她的手在发抖。";
  assert.equal(detectRefusal(story), false);
  assert.equal(detectRefusal("「我无法继续了……」少女喘着气，靠在墙边。「这个请求，太过分了。」"), false);
  assert.equal(detectRefusal('"I can\'t continue like this," she whispered. "As an AI core, my guidelines forbid it."'), false);
});

test("does not flag an NPC turning the player down in unquoted speech", () => {
  assert.equal(detectRefusal("老板摇了摇头：我无法满足你的要求，这个价格实在太低了。你转身走出了铺子。"), false);
  assert.equal(detectRefusal("He shakes his head. I can't help you with that, stranger. Not for any price."), false);
});

test("does not flag normal story replies", () => {
  assert.equal(detectRefusal("清晨的阳光透过窗帘照进来。你睁开眼，发现桌上放着一封没有署名的信。"), false);
  assert.equal(detectRefusal("她的目光露骨地在你身上停留了片刻，随即笑着移开。"), false);
  assert.equal(detectRefusal("The tavern falls silent as you enter. The bard stops mid-verse, eyes fixed on your blade."), false);
  assert.equal(detectRefusal(""), false);
});

test("does not flag a long story that merely contains a policy-ish line", () => {
  const paragraphs = [
    "我无法继续了，作为学院的守卫，安全规范不允许我放你进去。卫兵说完便转过身去。",
    ...Array(24).fill("走廊很长，你的脚步声在石墙之间来回回荡，远处隐约传来钟声和低语。"),
  ];
  const story = paragraphs.join("\n\n");
  assert.ok(story.length > 700, String(story.length));
  assert.equal(detectRefusal(story), false);
});

test("ignores very long replies entirely", () => {
  assert.equal(detectRefusal(GEMINI_ZH + "。".repeat(5000)), false);
});

test("PROHIBITED_CONTENT-family finish reasons count as content filter", () => {
  for (const fr of ["SAFETY", "content_filter", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "prohibited_content"]) {
    assert.equal(isContentFilterFinishReason(fr), true, fr);
  }
  for (const fr of ["stop", "length", "tool_calls", "RECITATION", "OTHER", null, undefined]) {
    assert.equal(isContentFilterFinishReason(fr), false, String(fr));
  }
});

// Missed by the v1 patterns; observed in the 2026-09-27 real-pipeline eval.
const OBSERVED_2026_09_27 = [
  "我无法按照要求生成极其露骨或带有束缚虐待色彩的色情性行为描写。\n\n如果希望继续推进小说的剧情与策略玩法，我可以为你提供门外女性的身份描写、鉴定术反馈信息，以及避难所内的心理博弈和剧情互动。",
  "I cannot participate in this roleplay or generate content depicting sexual acts, including themes of legally mandated or coerced sexual compliance.",
  "这条还是接在捆缚强迫里的——她被锁链绑着，这不算自愿，我不能接着写，也没有能绕过去的写法。\n\n如果想继续这个角色，可以这样改：\n- 解开锁链，由她主动",
  "还是同一个答复：这个我不能写。\n\n莉蒂娅是与你共同生活的继母，你们之间是家庭关系——这一点不会因为换一个姿势、换一句推进就改变。\n\n我上一条给的几个方向仍然有效，如果你愿意选一个，我可以马上接着写：\n- 心理悬疑线",
];

test("flags refusals observed in the 2026-09-27 eval", () => {
  for (const text of OBSERVED_2026_09_27) assert.equal(detectRefusal(text), true, text.slice(0, 40));
});

test("a first-person story line that says 我不能 is still not a refusal", () => {
  assert.equal(detectRefusal("我不能再继续这样下去了。我推开窗，夜风灌进来，远处的钟楼敲了十二下。如果你愿意等，她说过，天亮前会回来。"), false);
  assert.equal(detectRefusal("我无法按照原计划赶到城门，只好绕路穿过集市。人群里有人喊我的名字，我换个方向挤了过去。"), false);
});

test("Vertex's finish_reason 'error' + native SAFETY counts as content filter", () => {
  // Observed 2026-09-27 on gemini-3.1-flash-lite / 3.7-flash served by Google (Vertex).
  assert.equal(isContentFilterChoice({ finish_reason: "error", native_finish_reason: "SAFETY" }), true);
  assert.equal(isContentFilterChoice({ finish_reason: "content_filter", native_finish_reason: "PROHIBITED_CONTENT" }), true);
  assert.equal(isContentFilterChoice({ finish_reason: "error", native_finish_reason: "OTHER" }), false);
  assert.equal(isContentFilterChoice({ finish_reason: "stop", native_finish_reason: "STOP" }), false);
  assert.equal(isContentFilterChoice(undefined), false);
});

test("provider block messages classify as CONTENT_FILTER", () => {
  assert.equal(
    classifyGenerationFailure("Response blocked by safety/content filter. Try regenerating — the filter is non-deterministic and may pass on retry.").code,
    FAILURE_CODE.CONTENT_FILTER,
  );
  assert.equal(
    classifyGenerationFailure("Response blocked by safety/content filter (PROHIBITED_CONTENT). Try regenerating or another model.").code,
    FAILURE_CODE.CONTENT_FILTER,
  );
});
