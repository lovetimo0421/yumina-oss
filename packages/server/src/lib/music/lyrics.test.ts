import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLyrics } from "./lyrics.js";

test("lyrics: the title line comes off, in English or the creator's language", () => {
  assert.deepEqual(parseLyrics("TITLE: 雨夜\n[Verse]\n一\n二\n三\n[Chorus]\n四\n五\n六")?.title, "雨夜");
  assert.deepEqual(parseLyrics("标题：《烟火》\n[主歌]\n一\n二\n三\n[副歌]\n四\n五\n六")?.title, "烟火");
});

test("lyrics: untagged lines get a verse tag; a refusal or a reply is not lyrics", () => {
  assert.match(parseLyrics("一\n二\n三\n四\n五\n六")!.lyrics, /^\[Verse\]\n一/);
  assert.equal(parseLyrics("I'm sorry, but I can't help with that request."), null);
  const prose = Array.from({ length: 8 }, () => "This is a long explanation of what the song could be about, written as prose, not as lines.").join("\n");
  assert.equal(parseLyrics(prose), null);
});
