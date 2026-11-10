import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { changelogDir, changelogFor, entryView, loadChangelog, parseChangelogEntry, renderChangelogMarkdown } from "./changelog.js";

const VALID = `---
date: 2026-10-11
audience: public   # or internal
areas: [聊天, image]
title:
  zh: 中文标题
  en: "English: title"
  ja: 日本語
---
## zh
· 第一条 **重点**
· 第二条 [链接](/app/community)

## en
· First
· Second

## ja
· 一つ目
`;

// The open-source export leaves changelog/ out; everywhere else it must be found.
const NO_FOLDER = changelogDir() ? false : "no changelog/ folder (open-source export)";

test("every real entry in changelog/ parses and validates", { skip: NO_FOLDER }, () => {
  const dir = changelogDir();
  assert.ok(dir, "changelog/ folder found from the server package");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md");
  assert.ok(files.length > 0, "at least one entry");
  const { entries, errors } = loadChangelog(dir);
  assert.deepEqual(errors.map((e) => e.message), [], "no malformed entries");
  assert.equal(entries.length, files.length);
  for (const entry of entries) {
    for (const lang of ["zh", "en"] as const) {
      assert.ok(entry.title[lang], `${entry.id}: title.${lang}`);
      assert.ok(entry.html[lang], `${entry.id}: ## ${lang}`);
    }
  }
  // Newest first.
  const dates = entries.map((e) => e.date);
  assert.deepEqual(dates, [...dates].sort().reverse());
});

test("the seed entry announces the update log", { skip: NO_FOLDER }, () => {
  const entry = loadChangelog().entries.find((e) => e.id === "2026-10-11-update-log");
  assert.ok(entry);
  assert.equal(entry.audience, "public");
  for (const lang of ["zh", "en", "zh-Hant", "es", "ja"] as const) assert.ok(entry.title[lang], lang);
});

test("a well-formed entry: areas by slug or zh label, · bullets become a list, comments ignored", () => {
  const entry = parseChangelogEntry("2026-10-11-sample.md", VALID);
  assert.equal(entry.id, "2026-10-11-sample");
  assert.equal(entry.audience, "public");
  assert.deepEqual(entry.areas, ["chat", "image"]);
  assert.equal(entry.title.en, "English: title");
  assert.match(entry.html.zh!, /^<ul>\s*<li>第一条 <strong>重点<\/strong><\/li>/);
  assert.match(entry.html.zh!, /<a href="\/app\/community">链接<\/a>/);
  assert.equal(entry.title["zh-Hant"], undefined);
});

test("block-list areas, CRLF and a BOM are tolerated", () => {
  const raw = "﻿" + VALID.replace("areas: [聊天, image]", "areas:\n  - chat\n  - 生图").replace(/\n/g, "\r\n");
  assert.deepEqual(parseChangelogEntry("2026-10-11-sample.md", raw).areas, ["chat", "image"]);
});

test("strict validation names the file and the problem", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["2026-10-11-x.md", VALID.replace("[聊天, image]", "[聊天, 魔法]"), /unknown area "魔法"/],
    ["2026-10-11-x.md", VALID.replace("areas: [聊天, image]\n", ""), /areas must list/],
    ["2026-10-11-x.md", VALID.replace("  zh: 中文标题\n", ""), /missing title\.zh/],
    ["2026-10-11-x.md", VALID.replace('  en: "English: title"\n', ""), /missing title\.en|has a "## en" section but no title\.en/],
    ["2026-10-11-x.md", VALID.replace(/## en\n· First\n· Second\n/, ""), /missing "## en" section/],
    ["2026-10-11-x.md", VALID.replace("## ja\n· 一つ目\n", ""), /has title\.ja but no "## ja" section/],
    ["2026-10-11-x.md", VALID.replace("audience: public   # or internal", "audience: team"), /audience must be "public", "internal" or "unrestricted"/],
    ["2026-10-11-x.md", VALID.replace("audience: public   # or internal\n", ""), /audience must be/],
    ["2026-02-30-x.md", VALID.replace("2026-10-11", "2026-02-30"), /not a real YYYY-MM-DD date/],
    ["2026-10-12-x.md", VALID, /doesn't match the file name/],
    ["2026-10-11-x.md", VALID.replace("date: 2026-10-11", "date: Oct 11"), /not a real/],
    ["notes.md", VALID, /file name must be/],
    ["2026-10-11-x.md", VALID.replace("title:", "summary: x\ntitle:"), /unknown front matter key "summary"/],
    ["2026-10-11-x.md", VALID.replace("  ja: 日本語", "  fr: Français"), /unknown language "fr"/],
    ["2026-10-11-x.md", VALID.replace("## en", "## Highlights"), /not a language section/],
    ["2026-10-11-x.md", VALID.replace("## ja\n· 一つ目", "## ja\n"), /"## ja" section is empty/],
    ["2026-10-11-x.md", VALID.replace(/^---\n/, ""), /front matter block/],
  ];
  for (const [file, raw, problem] of cases) {
    assert.throws(() => parseChangelogEntry(file, raw), (error: Error) => {
      assert.match(error.message, new RegExp(`^changelog/${file.replace(/\./g, "\\.")}: `));
      assert.match(error.message, problem);
      return true;
    }, `${file}: ${problem}`);
  }
});

test("highlight and kind: parsed, validated; covers are no longer part of the format", () => {
  const extra = (lines: string) => VALID.replace("title:", `${lines}\ntitle:`);
  const entry = parseChangelogEntry("2026-10-11-sample.md", extra("highlight: true\nkind: roundup"));
  assert.deepEqual([entry.highlight, entry.kind], [true, "roundup"]);
  const plain = parseChangelogEntry("2026-10-11-sample.md", VALID);
  assert.deepEqual([plain.highlight, plain.kind], [false, "standard"]);
  const bad: Array<[string, RegExp]> = [
    [extra("highlight: yes"), /highlight must be true or false/],
    [extra("kind: digest"), /kind must be "standard" or "roundup"/],
    [extra("cover: /updates/pic.webp"), /unknown front matter key "cover"/],
  ];
  for (const [text, problem] of bad) assert.throws(() => parseChangelogEntry("2026-10-11-sample.md", text), problem);
});

test("raw HTML is escaped and unsafe links lose their href", () => {
  const html = renderChangelogMarkdown('· <img src=x onerror=alert(1)>\n· [bad](javascript:alert(1)) and [ok](https://yumina.io)');
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /&lt;img/);
  assert.match(html, /<a href="https:\/\/yumina\.io" target="_blank" rel="noopener noreferrer">ok<\/a>/);
});

test("language fallback: missing → en → zh; zh-Hant prefers zh; unknown → en", () => {
  const entry = parseChangelogEntry("2026-10-11-sample.md", VALID);
  assert.equal(entryView(entry, "ja").lang, "ja");
  assert.equal(entryView(entry, "es").lang, "en");
  assert.equal(entryView(entry, "zh-TW").lang, "zh");
  assert.equal(entryView(entry, "zh-Hant").title, "中文标题");
  assert.equal(entryView(entry, "fr").lang, "en");
  assert.equal(entryView(entry, undefined).lang, "en");
});

test("internal entries reach admins only", () => {
  const pub = parseChangelogEntry("2026-10-11-sample.md", VALID);
  const internal = parseChangelogEntry("2026-10-12-ops.md", VALID.replace(/2026-10-11/, "2026-10-12").replace("audience: public   # or internal", "audience: internal"));
  assert.deepEqual(changelogFor([internal, pub], { isAdmin: false }, "en").map((e) => e.id), ["2026-10-11-sample"]);
  assert.deepEqual(changelogFor([internal, pub], { isAdmin: true }, "en").map((e) => e.id), ["2026-10-12-ops", "2026-10-11-sample"]);
});

test("a malformed file is reported and skipped, README is ignored", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "changelog-"));
  try {
    fs.writeFileSync(path.join(dir, "README.md"), "# docs");
    fs.writeFileSync(path.join(dir, "2026-10-11-good.md"), VALID);
    fs.writeFileSync(path.join(dir, "2026-10-11-bad.md"), VALID.replace("[聊天, image]", "[nope]"));
    const { entries, errors } = loadChangelog(dir);
    assert.deepEqual(entries.map((e) => e.id), ["2026-10-11-good"]);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.message, /2026-10-11-bad\.md: unknown area "nope"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
