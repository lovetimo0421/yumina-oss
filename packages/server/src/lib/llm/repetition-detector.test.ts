import assert from "node:assert/strict";
import test from "node:test";
import {
  antiRepetitionInstructionForModel,
  detectDegenerateRepetition,
  detectDegenerateRepetitionForModel,
  detectPartialTokenLoop,
} from "./repetition-detector.js";

test("detects a sentence that consumes most of a generated reply", () => {
  const repeated = "球场上的钟声再次响起，所有人都望向同一个方向。";
  const result = detectDegenerateRepetition(Array(5).fill(repeated).join("\n"));
  assert.equal(result?.reason, "sentence-loop");
  assert.equal(result?.occurrences, 5);
});

test("detects repeated multi-sentence paragraphs", () => {
  const paragraph = "下半场开始了。球队依旧保持低位防守，等待第五十二分钟的反击机会。";
  const result = detectDegenerateRepetition(Array(3).fill(paragraph).join("\n\n"));
  assert.equal(result?.reason, "paragraph-loop");
  assert.equal(result?.occurrences, 3);
});

test("allows intentional short dialogue beats and normal prose motifs", () => {
  const prose = [
    "“走吧。”她说。",
    "风从门缝里钻进来，吹动桌上的旧车票。",
    "“走吧。”他终于回答。",
    "楼下的末班车鸣笛，两个人提起行李走进雨里。",
  ].join("\n");
  assert.equal(detectDegenerateRepetition(prose), null);
});

test("ignores short and empty outputs", () => {
  assert.equal(detectDegenerateRepetition(""), null);
  assert.equal(detectDegenerateRepetition("好。好。好。"), null);
});

test("allows a repeated sentence when it does not dominate the reply", () => {
  const refrain = "钟声又响了一次，但这次没有人回头。";
  const text = [
    refrain,
    "林夏推开仓库的侧门，潮湿的风卷起地上的报纸。",
    "周明在楼梯尽头找到保险箱，密码是信封上的日期。",
    refrain,
    "两个人带着账本离开港口，决定把证据交给记者。",
    "天亮前，第一篇报道已经出现在城市新闻的首页。",
  ].join("\n");
  assert.equal(detectDegenerateRepetition(text), null);
});

test("allows structured output whose distinct reports share a format", () => {
  const reports = [
    "第十五分钟：主队从左路推进，但被边后卫拦截。",
    "第三十分钟：客队换到右路进攻，门将把球扑出。",
    "第五十二分钟：主队快速反击，中锋射门得分。",
    "第七十五分钟：客队压上围攻，防线最终守住领先。",
  ].join("\n");
  assert.equal(detectDegenerateRepetition(reports), null);
});

test("rejects a near-copy of a recent assistant reply", () => {
  const previous = "雨水沿着旧车站的玻璃缓慢滑落。林夏抱着纸箱站在检票口，听见末班车第三次广播。她没有回头，只把那张褪色车票塞进口袋，然后跟着人群走向二号站台。车门合拢前，她终于看见周明从楼梯口冲下来，却只来得及隔着玻璃抬手。列车驶进黑暗，城市的灯被拉成长长的金线。";
  const copy = previous.replace("第三次", "最后一次").replace("二号站台", "第二站台");
  assert.equal(detectDegenerateRepetition(copy, [previous])?.reason, "previous-reply");
});

test("allows a new event that shares characters and setting", () => {
  const previous = "雨水沿着旧车站的玻璃缓慢滑落。林夏抱着纸箱站在检票口，听见末班车第三次广播。她没有回头，只把那张褪色车票塞进口袋，然后跟着人群走向二号站台。车门合拢前，她终于看见周明从楼梯口冲下来，却只来得及隔着玻璃抬手。列车驶进黑暗，城市的灯被拉成长长的金线。";
  const next = "清晨六点，林夏在海边小城醒来。旅店老板把一封没有邮票的信压在早餐盘下，信里只有一把储物柜钥匙和周明的名字。她搭上第一班公交，在渔港尽头找到生锈的蓝色柜门。里面没有行李，只有昨夜车站监控的存储卡，以及一张标着废弃灯塔的地图。潮声越来越近，她决定先去警局。";
  assert.equal(detectDegenerateRepetition(next, [previous]), null);
});

test("does not compare short previous replies as near-duplicates", () => {
  const current = [
    "林夏在码头收到一封没有邮票的信。",
    "信封里放着一把黄铜钥匙和旧仓库的号码。",
    "她沿着防波堤找到生锈的侧门。",
    "周明已经在里面等她，桌上摊着一本航运账册。",
    "两人决定天亮后把证据交给记者。",
  ].join("\n");
  assert.equal(detectDegenerateRepetition(current, ["好。"]), null);
});

test("Kimi alone receives the recency instruction", () => {
  assert.match(antiRepetitionInstructionForModel("moonshotai/kimi-k2-0905") ?? "", /event order/);
  assert.equal(antiRepetitionInstructionForModel("deepseek/deepseek-v3.2"), null);
});

test("production gate catches in-reply loops on every model", () => {
  const loop = Array(5)
    .fill("The same substantial sentence repeats until it dominates the entire generated response.")
    .join("\n");
  for (const model of [
    "moonshotai/kimi-k2-0905",
    "z-ai/glm-5.3-flash",
    "deepseek/deepseek-v4-pro",
    "anthropic/claude-sonnet-4.6",
    "google/gemini-3-flash-preview",
  ]) {
    assert.equal(detectDegenerateRepetitionForModel(model, loop)?.reason, "sentence-loop", model);
    assert.equal(detectDegenerateRepetitionForModel(model, ourLoop())?.reason, "token-loop", model);
  }
});

test("the near-copy-of-a-previous-reply check stays Kimi-only", () => {
  const previous = "雨水沿着旧车站的玻璃缓慢滑落。林夏抱着纸箱站在检票口，听见末班车第三次广播。她没有回头，只把那张褪色车票塞进口袋，然后跟着人群走向二号站台。车门合拢前，她终于看见周明从楼梯口冲下来，却只来得及隔着玻璃抬手。列车驶进黑暗，城市的灯被拉成长长的金线。";
  const copy = previous.replace("第三次", "最后一次").replace("二号站台", "第二站台");
  assert.equal(detectDegenerateRepetitionForModel("moonshotai/kimi-k2-0905", copy, [previous])?.reason, "previous-reply");
  for (const model of ["z-ai/glm-5.3-flash", "google/gemini-3-flash-preview", "deepseek/deepseek-v4-pro"]) {
    assert.equal(detectDegenerateRepetitionForModel(model, copy, [previous]), null, model);
  }
});

// ─── token loop ─────────────────────────────────────────────────────

function ourLoop(count = 400): string {
  return Array(count).fill("Our").join(" ");
}

test("detects a single word repeated for the whole reply", () => {
  const result = detectDegenerateRepetition(ourLoop());
  assert.equal(result?.reason, "token-loop");
  assert.equal(result?.occurrences, 400);
  assert.match(result?.sample ?? "", /^our our our/);
});

test("detects a word loop with punctuation and line breaks between repeats", () => {
  const text = Array(60).fill("Our,").join(" ") + "\n" + Array(60).fill("our.").join("\n");
  assert.equal(detectDegenerateRepetition(text)?.reason, "token-loop");
});

test("detects a loop that takes over after a normal opening", () => {
  const opening = "The guards stepped aside and the hall fell quiet. Mira lifted the lantern and read the inscription above the door aloud.";
  assert.equal(detectDegenerateRepetition(`${opening} ${ourLoop(120)}`)?.reason, "token-loop");
});

test("a long useful reply with a 600+ char loop tacked on is NOT waived, only logged", () => {
  const story = Array(30)
    .fill(0)
    .map((_, index) => `Chapter beat ${index}: the caravan crossed another dune while the scouts argued about water.`)
    .join(" ");
  // ~2,700 normalized chars of story, then 250 repeats (~750 chars) of a loop:
  // the "end every reply with zz zz ..." trick must not make a turn free.
  for (const tail of [ourLoop(250), Array(320).fill("zz").join(" ")]) {
    const reply = `${story} ${tail}`;
    assert.equal(detectDegenerateRepetition(reply), null);
    assert.equal(detectDegenerateRepetitionForModel("z-ai/glm-5.3-flash", reply), null);
    assert.equal(detectPartialTokenLoop(reply)?.reason, "token-loop");
  }
  // Once the loop is most of the reply, it is the reply: waived.
  assert.equal(detectDegenerateRepetition(`${story} ${ourLoop(1_200)}`)?.reason, "token-loop");
  assert.equal(detectPartialTokenLoop(`${story} ${ourLoop(1_200)}`), null);
});

test("a loop is measured against the whole reply, not the reply minus its HTML or code", () => {
  // A big status panel plus a loop shorter than the panel: the loop is not the reply.
  const panel = `<div class="status">${Array(60).fill(0).map((_, index) => `<span class="stat-${index}">HP ${index} / Gold ${index * 3} / Day ${index}</span>`).join("")}</div>`;
  const code = "```\n" + Array(80).fill(0).map((_, index) => `row ${index}: the map goes on`).join("\n") + "\n```";
  for (const wrapper of [panel, code]) {
    const reply = `${wrapper} ${ourLoop(250)}`;
    assert.equal(detectDegenerateRepetitionForModel("z-ai/glm-5.3-flash", reply), null);
  }
});

test("partial-loop logging ignores ordinary replies and short tails", () => {
  const story = Array(30).fill("The caravan crossed another dune while the scouts argued about water.").join(" ");
  assert.equal(detectPartialTokenLoop(story), null);
  assert.equal(detectPartialTokenLoop(`${story} ${ourLoop(40)}`), null);
});

test("detects CJK word loops without spaces", () => {
  assert.equal(detectDegenerateRepetition("我们".repeat(80))?.reason, "token-loop");
  assert.equal(detectDegenerateRepetition("她说：" + "然后然后然后".repeat(15))?.reason, "token-loop");
  assert.equal(detectDegenerateRepetition("啊".repeat(120))?.reason, "token-loop");
});

test("allows laughter, screams, stutters and refusals inside normal prose", () => {
  const samples = [
    "“Ha ha ha ha ha ha!” Rowan doubled over, wiping tears from his eyes. “You actually fell for that? The whole guild has been betting on it for a week.” Mira threw the empty mug at him and missed.",
    "“啊啊啊啊啊啊啊啊——！”她尖叫着从床上弹起来，枕头飞到了门口。窗外的雷声又响了一次，整栋宿舍楼的灯都闪了闪，楼下传来宿管阿姨的骂声。",
    "「不不不，不是这样的！」他拼命摆手，脸红到了耳根。「我只是……只是路过而已，真的，绝对不是特意来找你的。」少女眯起眼睛，显然一个字都不信。",
    "“I-I-I didn't mean to,” she stammered, backing toward the door. “Th-the vase was already cracked when I got here, I swear it was.” The steward said nothing and kept writing in his ledger.",
    "哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈！老陈笑得直拍桌子，茶水溅了一地。“你再说一遍，你把县太爷的轿子当成了送菜的车？”小二捂着脸，恨不得钻到桌子底下去。",
    "No. No, no, no, no. Not again. Elena pressed her palms against the cold glass and watched the last ferry pull away from the dock without her.",
  ];
  for (const text of samples) assert.equal(detectDegenerateRepetition(text), null, text.slice(0, 30));
});

test("allows lists, tables, grids and status templates", () => {
  const table = [
    "| Day | Weather | Event |",
    "| --- | --- | --- |",
    ...Array(30).fill(0).map((_, index) => `| ${index + 1} | Sunny | None |`),
  ].join("\n");
  const grid = "Minefield:\n" + Array(20).fill(Array(20).fill("0").join(" ")).join("\n");
  const codeMap = "```\n" + Array(15).fill("#".repeat(10) + "X".repeat(30)).join("\n") + "\n```\nYou stand at the edge of the map.";
  const html = "<table>" + Array(40).fill("<tr><td></td><td></td><td></td></tr>").join("") + "</table>The panel updates.";
  const list = Array(25)
    .fill(0)
    .map((_, index) => `- Potion of healing #${index + 1}: restores ${10 + index} HP`)
    .join("\n");
  for (const text of [table, grid, codeMap, html, list]) {
    assert.equal(detectDegenerateRepetition(text)?.reason === "token-loop", false, text.slice(0, 40));
  }
});

test("ignores loops too short to matter", () => {
  assert.equal(detectDegenerateRepetition(ourLoop(10)), null);
  assert.equal(detectDegenerateRepetition("啊".repeat(30)), null);
});
