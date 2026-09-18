import assert from "node:assert/strict";
import test from "node:test";
import {
  antiRepetitionInstructionForModel,
  detectDegenerateRepetition,
  detectDegenerateRepetitionForModel,
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

test("Kimi receives a recency instruction without changing other models", () => {
  assert.match(antiRepetitionInstructionForModel("moonshotai/kimi-k2-0905") ?? "", /event order/);
  assert.equal(antiRepetitionInstructionForModel("deepseek/deepseek-v3.2"), null);
});

test("production repetition gate is strictly Kimi-only", () => {
  const loop = Array(5)
    .fill("The same substantial sentence repeats until it dominates the entire generated response.")
    .join("\n");

  assert.equal(
    detectDegenerateRepetitionForModel("moonshotai/kimi-k2-0905", loop)?.reason,
    "sentence-loop",
  );
  for (const model of [
    "deepseek/deepseek-v4-pro",
    "anthropic/claude-sonnet-4.6",
    "google/gemini-3-flash-preview",
    "openai/gpt-5.2",
  ]) {
    assert.equal(detectDegenerateRepetitionForModel(model, loop), null, model);
  }
});
