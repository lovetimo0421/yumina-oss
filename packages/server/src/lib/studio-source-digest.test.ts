import test from "node:test";
import assert from "node:assert/strict";
import { applyCorrections, approxTokens, asSection, bookSpelling, checkQuotes, groupNotes, personNames, parseSearches, parseCorrections, personKey, planParts, rankPeople, trimRepeats } from "./studio-source-digest.js";
import type { SourceMeta } from "./studio-sources.js";

const meta = (sizes: number[]): SourceMeta => {
  let at = 0;
  return {
    id: "s", name: "book.txt", chars: sizes.reduce((a, b) => a + b, 0), createdAt: "",
    chapters: sizes.map((n, i) => { const c = { title: `第${i + 1}章`, start: at, end: at + n }; at += n; return c; }),
  };
};

test("parts are whole chapters packed up to the size, in order, with no gaps", () => {
  const parts = planParts(meta([20_000, 25_000, 30_000, 10_000, 5_000]), 60_000);
  assert.deepEqual(parts.map((p) => [p.first, p.last]), [["第1章", "第2章"], ["第3章", "第5章"]]);
  assert.equal(parts[0]!.end, parts[1]!.start);
  assert.equal(parts.at(-1)!.end, 90_000);
});

test("token estimate tells Chinese from English", () => {
  assert.ok(approxTokens("一二三四五六七八九十") >= 8);
  assert.ok(approxTokens("abcdefghijklmnopqrstuvwxyzabcdefghijklmn") <= 10);
});

test("quotes that are in the book stay; ones that are not are marked, however they were quoted", () => {
  const book = "贝尔握紧了刀。「我想变强。」他对赫斯缇雅说道。";
  const notes = [
    "> 「我想变强。」他对赫斯缇雅说道。 —— 贝尔，第一章",
    "> 我会成为英雄，一定会的，绝对会的。 —— 贝尔",
    "- **贝尔** | 说话：「他对赫斯缇雅说道贝尔握紧」",
    "- **贝尔** | 说话：「这句话原文里根本没有出现过」",
  ].join("\n");
  const out = checkQuotes(notes, book);
  const lines = out.notes.split("\n");
  assert.ok(!lines[0]!.includes("〔未核实〕"));
  assert.ok(lines[1]!.endsWith("〔未核实〕"));
  assert.ok(lines[3]!.includes("〔未核实〕"));
  assert.equal(out.missing, 3, "the third line's words are in the book, but not in that order");
});

test("one person under every spelling: given name before the dot, no brackets", () => {
  assert.equal(personKey("贝尔·克朗尼"), "贝尔");
  assert.equal(personKey("贝尔•克朗尼（主角）"), "贝尔");
  assert.equal(personKey("Bell Cranel"), "Bell Cranel");
});

test("notes regroup by topic with their part, and people across parts", () => {
  const part = (index: number) => ({ index, start: 0, end: 1, first: `第${index}章`, last: `第${index}章` });
  const g = groupNotes([
    { part: part(0), text: "## PLOT\n### 第0章\n贝尔遇见艾丝。\n## PEOPLE\n- **贝尔·克朗尼** | Lv.1\n  继续一行\n- **艾丝** | Lv.5\n## TERMS\n- 神之恩惠 | 定义" },
    { part: part(1), text: "## PEOPLE\n- **贝尔** | Lv.2\n## QUOTES\n> 「…」 —— 贝尔" },
  ]);
  assert.ok(g.plot.join("\n").includes("[P00]"));
  assert.ok(g.terms.some((l) => l.includes("神之恩惠")));
  const bell = g.people.get("贝尔")!;
  assert.equal(bell.filter((l) => l.startsWith("[P")).length, 2);
  assert.ok(bell.includes("  继续一行"));
  assert.equal(rankPeople(g.people)[0]!.name, "贝尔");
});

test("search requests come back as data even when the model wraps them in prose", () => {
  assert.deepEqual(parseSearches('好的：\n[{"q":1,"search":["劳尔","星爆"]},{"q":2,"search":[]}]'), [{ q: 1, search: ["劳尔", "星爆"] }]);
  assert.deepEqual(parseSearches("no json here"), []);
});

test("a person is keyed by the spelling the book uses, whatever the reader wrote", () => {
  const book = "赫斯缇雅说。赫斯缇雅笑了。贝尔·克朗尼握刀。贝尔跑。贝尔跳。";
  const canon = bookSpelling(book);
  assert.deepEqual(personNames("- **Hestia** | aliases: 赫斯缇雅、女神 | 神"), ["Hestia", "赫斯缇雅", "女神"]);
  assert.equal(canon(personNames("- **Hestia** | aliases: 赫斯缇雅 | 神")), "赫斯缇雅");
  assert.equal(canon(personNames("- **贝尔·克朗尼尔** | aliases: Bell Cranel | 人类")), "贝尔");
  assert.equal(canon(["Nobody"]), null);
  const part = { index: 0, start: 0, end: 1, first: "a", last: "a" };
  const g = groupNotes([{ part, text: "## PEOPLE\n- **Bell Cranel** | aliases: 贝尔\n- **贝尔·克朗尼** | Lv.1" }], canon);
  assert.deepEqual([...g.people.keys()], ["贝尔"]);
});

test("spellings link across parts through aliases, but a shared title links nobody", () => {
  const book = "莉莉露卡来了。莉莉说。莉莉笑。莉莉跑。赫斯缇雅。赫斯缇雅。芙蕾雅。女神。女神。女神。女神。女神。女神。";
  const notes = [
    "## PEOPLE\n- **莉莉露卡** | aliases: 莉莉 | 小人族\n- **赫斯缇雅** | aliases: 女神 | 神",
    "## PEOPLE\n- **莉莉** | 支援者\n- **芙蕾雅** | aliases: 女神 | 神",
  ];
  const canon = bookSpelling(book, notes);
  const part = (index: number) => ({ index, start: 0, end: 1, first: "a", last: "a" });
  const g = groupNotes(notes.map((text, i) => ({ part: part(i), text })), canon);
  assert.deepEqual([...g.people.keys()].sort(), ["芙蕾雅", "莉莉", "赫斯缇雅"].sort());
  assert.equal(g.people.get("莉莉")!.length, 2);
});

test("a reply that loops is cut back; short repeats and tables are not", () => {
  assert.equal(trimRepeats("开头。" + "抱怨公会罚则，".repeat(30) + "结尾"), "开头。抱怨公会罚则，结尾");
  assert.equal(trimRepeats("- a\n* 抱怨 [P27]\n* 抱怨 [P27]\n* 抱怨 [P27]\n- b"), "- a\n* 抱怨 [P27]\n- b");
  assert.equal(trimRepeats("「啊啊啊啊啊啊啊啊」"), "「啊啊啊啊啊啊啊啊」");
  assert.equal(trimRepeats("|---|---|---|---|---|---|---|"), "|---|---|---|---|---|---|---|");
});

test("a section takes the code's heading, the model's headings go one level down", () => {
  assert.equal(asSection("人物：贝尔", "## 贝尔\n### 外貌\n文"), "## 人物：贝尔\n\n### 外貌\n文");
  assert.equal(asSection("剧情 1/3", "## 剧情\n## 第一卷\n### 转折\n文"), "## 剧情 1/3\n\n### 第一卷\n#### 转折\n文");
});

test("a line written again hundreds of lines later goes; headings and table rules stay", () => {
  const loop = ["- 五年前：艾丝击败乌代俄斯，升上Lv.6 (P97)", "- 三年前：别的事情发生了，写得很长 (P12)"];
  const text = ["#### 时间线", ...loop, ...loop, ...loop, "|---|---|", "#### 时间线", "|---|---|", "短行", "短行"].join("\n");
  assert.equal(trimRepeats(text), ["#### 时间线", ...loop, "|---|---|", "#### 时间线", "|---|---|", "短行"].join("\n"));
});

test("only the open lines are rewritten, keeping their list marker, and the outcome is recorded", () => {
  const section = "## 人物\n- 命是人类 [P79]\n- 存疑：命是犬人 [P113] / 人类 [P79]\n- 其他";
  const doubts = ["- 存疑：命是犬人 [P113] / 人类 [P79]"];
  const out = applyCorrections(section, doubts, parseCorrections('好：[{"q":1,"line":"- 命是人类（极东出身）[P79,113]","note":"P113 的犬人指另一人"},{"q":9,"line":"x","note":""}]'));
  assert.equal(out.settled, 1);
  assert.ok(out.text.includes("\n- 命是人类（极东出身）[P79,113]\n- 其他"));
  assert.ok(!out.text.split("### 核对记录")[0]!.includes("存疑"));
  assert.ok(out.text.endsWith("### 核对记录\n- 存疑：命是犬人 [P113] / 人类 [P79] → P113 的犬人指另一人"));
  assert.deepEqual(applyCorrections(section, doubts, []), { text: section, settled: 0 });
});
