import assert from "node:assert/strict";
import test from "node:test";
import { canonTags, withCanon } from "./canon.js";

type Tag = { name: string; post_count: number; category: number };

/** A fake danbooru: tags by name, aliases antecedent → consequent. */
function danbooru(tags: Tag[], aliases: Record<string, string> = {}, fail = false) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    if (fail) throw new Error("network down");
    if (url.pathname === "/tags.json") {
      const name = url.searchParams.get("search[name]");
      return Response.json(tags.filter((t) => t.name === name));
    }
    const from = url.searchParams.get("search[antecedent_name]") ?? "";
    return Response.json(aliases[from] ? [{ consequent_name: aliases[from] }] : []);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("a confirmed name goes in right after the head count, brackets escaped", async () => {
  const fake = danbooru([
    { name: "makima_(chainsaw_man)", post_count: 11169, category: 4 },
    { name: "chainsaw_man", post_count: 46812, category: 3 },
  ]);
  try {
    const canon = await canonTags("makima (chainsaw man), chainsaw man");
    assert.equal(canon, "makima \\(chainsaw man\\), chainsaw man");
    assert.equal(withCanon("1girl, adult, red hair, braid", canon), "1girl, adult, makima \\(chainsaw man\\), chainsaw man, red hair, braid");
  } finally { fake.restore(); }
});

test("western name order and retired spellings are mapped to danbooru's own name", async () => {
  const fake = danbooru([
    { name: "satoru_gojo", post_count: 0, category: 4 },
    { name: "gojo_satoru", post_count: 6169, category: 4 },
    { name: "jujutsu_kaisen", post_count: 25136, category: 3 },
    { name: "kazuma_satou_(konosuba)", post_count: 0, category: 4 },
    { name: "satou_kazuma_(konosuba)", post_count: 3738, category: 4 },
  ], { satoru_gojo: "gojo_satoru" });
  try {
    assert.equal(await canonTags("satoru gojo, jujutsu kaisen"), "gojo satoru, jujutsu kaisen");
    assert.equal(await canonTags("kazuma satou (konosuba)"), "satou kazuma \\(konosuba\\)");
  } finally { fake.restore(); }
});

test("a name given without its work qualifier, and a work named like its hero, still resolve", async () => {
  const fake = danbooru([
    { name: "makima", post_count: 0, category: 0 },
    { name: "makima_(chainsaw_man)", post_count: 11169, category: 4 },
    { name: "chainsaw_man", post_count: 46812, category: 3 },
    { name: "uzumaki_naruto", post_count: 5911, category: 4 },
    { name: "naruto_(series)", post_count: 27414, category: 3 },
  ], { naruto: "uzumaki_naruto" });
  try {
    assert.equal(await canonTags("makima, chainsaw man"), "makima \\(chainsaw man\\), chainsaw man");
    assert.equal(await canonTags("naruto uzumaki, naruto"), "uzumaki naruto, naruto \\(series\\)");
  } finally { fake.restore(); }
});

test("an unknown, barely-posted or wrong-kind name draws from the look tags alone", async () => {
  const fake = danbooru([
    { name: "obscure_girl", post_count: 4, category: 4 },
    { name: "one_piece", post_count: 55945, category: 3 },
  ]);
  try {
    assert.equal(await canonTags("someone made up, one piece"), "");
    assert.equal(await canonTags("obscure girl, one piece"), "");
    // A copyright offered as the character is not a character.
    assert.equal(await canonTags("one piece"), "");
    assert.equal(await canonTags(""), "");
    assert.equal(withCanon("1girl, adult, black hair", ""), "1girl, adult, black hair");
  } finally { fake.restore(); }
});

test("danbooru being down costs this picture its name, not the turn", async () => {
  const fake = danbooru([], {}, true);
  try {
    assert.equal(await canonTags("power (chainsaw man), chainsaw man"), "");
  } finally { fake.restore(); }
  // Not remembered as unknown: the next picture asks again.
  const back = danbooru([{ name: "power_(chainsaw_man)", post_count: 6773, category: 4 }]);
  try {
    assert.equal(await canonTags("power (chainsaw man)"), "power \\(chainsaw man\\)");
  } finally { back.restore(); }
});
