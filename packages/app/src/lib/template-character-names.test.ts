import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isPlaceholderCharacterName } from "@yumina/engine";

// The engine's list of "not named yet" character names has to cover every
// name the stock templates hand out, or a renamed-never card's replies go back
// to showing 「角色」 over every line.
test("every template character name counts as unnamed", () => {
  for (const lang of ["zh", "zh-Hant", "en", "ja", "es"]) {
    const content = JSON.parse(readFileSync(new URL(`../locales/${lang}/templates-content.json`, import.meta.url), "utf8"));
    for (const name of [content.chat.entries.character.name, content.world.entries.npcA.name, content.world.entries.npcB.name]) {
      assert.equal(isPlaceholderCharacterName(name), true, `${lang}: ${name}`);
    }
  }
  assert.equal(isPlaceholderCharacterName("小雪"), false);
  assert.equal(isPlaceholderCharacterName("人物：Balder"), false);
});
