import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeSourceBytes, describeSources, listChapters, readText, searchText, splitSourceChapters,
  type SourceHit, type SourceMeta,
} from "./studio-sources.js";

const NOVEL = [
  "网站声明：本书来自网络。",
  "第一卷 序章 在地下城寻求邂逅",
  "贝尔被弥诺陶洛斯追到死角。",
  "",
  "金发金眼的女剑士救了他。艾丝·华伦斯坦问：「……你还好吗？」",
  "第一卷 第一章 世界、现实与憧憬",
  "埃伊娜说：「冒险者不可以冒险。」",
  "赫斯缇雅为他更新了能力值，技能栏是【憧憬一途】。",
  "第一卷 终章 眷族神话",
  "贝尔又见到了艾丝，脸红得像番茄。",
].join("\n");

const meta = (text: string): SourceMeta => ({
  id: "src_test", name: "test.txt", chars: text.length, chapters: splitSourceChapters(text), createdAt: "",
});

test("a txt in GB18030 — what most Chinese novel files are — decodes, and UTF-8 stays UTF-8", () => {
  const gbk = new Uint8Array([0xb5, 0xda, 0xd2, 0xbb, 0xbe, 0xed]); // 第一卷
  assert.equal(decodeSourceBytes(gbk), "第一卷");
  assert.equal(decodeSourceBytes(new TextEncoder().encode("第一卷\r\n序章")), "第一卷\n序章");
  assert.equal(decodeSourceBytes(new TextEncoder().encode("中&#12539;点")), "中・点");
});

test("chapters follow the book's own headings, with whatever came before them as 开头", () => {
  const chapters = splitSourceChapters(NOVEL);
  assert.deepEqual(chapters.map((c) => c.title), ["开头", "第一卷 序章 在地下城寻求邂逅", "第一卷 第一章 世界、现实与憧憬", "第一卷 终章 眷族神话"]);
  assert.equal(chapters.at(-1)!.end, NOVEL.length);
  for (let i = 1; i < chapters.length; i++) assert.equal(chapters[i]!.start, chapters[i - 1]!.end, "no gaps, no overlaps");
});

test("a chapter too long to read in one go, or a text with no headings, is cut into parts at line breaks", () => {
  const long = Array.from({ length: 4000 }, (_, i) => `第${i}行的内容，写得很长很长很长。`).join("\n");
  const chapters = splitSourceChapters(long);
  assert.ok(chapters.length > 1);
  assert.equal(chapters[1]!.title, "开头（2）");
  assert.ok(chapters.every((c) => c.end - c.start <= 30_000));
  assert.ok(chapters.slice(0, -1).every((c) => long[c.end - 1] === "\n"), "parts end on a line break");
});

test("search finds a phrase with its chapter, and several words only where they appear together", () => {
  const m = meta(NOVEL);
  const hits: SourceHit[] = [];
  assert.equal(searchText(m, NOVEL, ["憧憬一途"], { max: 10, around: 20 }, hits), 1);
  assert.equal(hits[0]!.chapter_title, "第一卷 第一章 世界、现实与憧憬");
  assert.ok(hits[0]!.snippet.includes("憧憬一途"));

  const spread = `第一章 起\n贝尔走进地下城。\n${"路很长。\n".repeat(200)}第二章 终\n贝尔脸红得像番茄。`;
  const near: SourceHit[] = [];
  assert.equal(searchText(meta(spread), spread, ["贝尔", "番茄"], { max: 10, around: 20 }, near), 1, "only where both are close");
  assert.equal(near[0]!.chapter_title, "第二章 终");
});

test("search counts every match but returns at most max", () => {
  const text = "艾丝\n".repeat(50);
  const hits: SourceHit[] = [];
  assert.equal(searchText(meta(text), text, ["艾丝"], { max: 5, around: 5 }, hits), 50);
  assert.equal(hits.length, 5);
});

test("read by chapter title or index, page through it, and follow to the next chapter", () => {
  const m = meta(NOVEL);
  const byTitle = readText(m, NOVEL, { chapter: "第一章" });
  assert.ok("text" in byTitle && byTitle.text.includes("冒险者不可以冒险"));
  assert.equal("next_chapter" in byTitle && byTitle.next_chapter, 3);

  const first = readText(m, NOVEL, { chapter: 2, length: 500 });
  assert.ok("text" in first && first.text.startsWith("第一卷 第一章"));

  const paged = readText(m, NOVEL, { chapter: "2", offset: 5 });
  assert.ok("text" in paged && paged.offset === m.chapters[2]!.start + 5);

  const missing = readText(m, NOVEL, { chapter: "第九卷" });
  assert.ok("error" in missing);
});

test("a long chapter is read 12000 characters at a time and says where to continue", () => {
  const long = `第一章 很长\n${"字".repeat(25_000)}`;
  const m: SourceMeta = { id: "s", name: "l", chars: long.length, chapters: [{ title: "第一章 很长", start: 0, end: long.length }], createdAt: "" };
  const part = readText(m, long, { chapter: 0 });
  assert.ok("text" in part && part.text.length === 12_000);
  assert.equal("more_in_chapter" in part && part.more_in_chapter, "read_source chapter 0 offset 12000");
});

test("the table of contents pages 300 at a time", () => {
  const m: SourceMeta = { id: "s", name: "n", chars: 0, createdAt: "",
    chapters: Array.from({ length: 450 }, (_, i) => ({ title: `第${i + 1}章`, start: i, end: i + 1 })) };
  const page1 = listChapters(m, {});
  assert.equal(page1.chapters.length, 300);
  assert.equal(page1.next, "list_chapters with offset 300");
  assert.equal(listChapters(m, { offset: 300 }).chapters.length, 150);
});

test("the assistant is told a card's sources exist by name and size, never given their text", () => {
  assert.equal(describeSources([]), "");
  const block = describeSources([meta(NOVEL)]);
  assert.ok(block.includes("src_test「test.txt」"));
  assert.ok(block.includes("search_source"));
  assert.ok(!block.includes("冒险者不可以冒险"));
});
