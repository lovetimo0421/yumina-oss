import assert from "node:assert/strict";
import test from "node:test";
import { resolveHeroSlots, resolveHeroWorlds, type HeroSlotRow } from "./hero-worlds.js";

const now = new Date("2026-09-13T00:00:00Z");
const slot = (language: string, id: string, position = 0, dates: Partial<HeroSlotRow> = {}): HeroSlotRow => ({
  language, slot: position, kind: "group", worldId: null, languageGroupId: id, startsAt: null, endsAt: null, ...dates,
});
const world = (id: string, language: string, group = "pvz", primary = true) => ({
  id, language, languageGroupId: group, isPrimaryVariant: primary, createdAt: now, name: `${language} title`, description: `${language} overview`,
});

test("Spanish, Japanese and unsupported locales inherit the English lineup; both Chinese scripts keep their custom lineup", () => {
  const rows = [slot("en", "second", 1), slot("zh", "chinese"), slot("en", "pvz")];
  for (const language of ["en", "es", "ja", "fr"]) {
    assert.deepEqual(resolveHeroSlots(rows, language, now).map(s => s.id), ["pvz", "second"]);
  }
  for (const language of ["zh", "zh-Hant", "zh-TW"]) assert.equal(resolveHeroSlots(rows, language, now)[0]?.id, "chinese");
});

test("only an active local lineup replaces English, and clearing it restores inheritance", () => {
  const base = slot("en", "english");
  const future = slot("ja", "japanese", 0, { startsAt: new Date(now.getTime() + 1) });
  const expired = slot("ja", "expired", 1, { endsAt: now });
  assert.equal(resolveHeroSlots([base, future, expired], "ja", now)[0]?.id, "english");
  const active = { ...future, startsAt: now };
  assert.deepEqual(resolveHeroSlots([base, active], "ja", now).map(s => s.id), ["japanese"]);
  assert.equal(resolveHeroSlots([base], "ja", now)[0]?.id, "english");
  assert.deepEqual(resolveHeroSlots([], "ja", now), []);
});

test("an inherited lineup returns the real translated world row, with English fallback", () => {
  const slots = resolveHeroSlots([slot("en", "pvz")], "es", now);
  const english = world("en-id", "en"), spanish = world("es-id", "es"), chinese = world("zh-id", "zh");
  assert.strictEqual(resolveHeroWorlds(slots, [english, spanish, chinese], "es")[0], spanish);
  assert.strictEqual(resolveHeroWorlds(slots, [chinese, english], "ja")[0], english);
  assert.strictEqual(resolveHeroWorlds(slots, [english, chinese], "zh-Hant")[0], chinese);
});

test("primary variants win inside the chosen language and ordering is deterministic", () => {
  const slots = resolveHeroSlots([slot("en", "pvz")], "es", now);
  const secondary = world("es-secondary", "es", "pvz", false);
  const primary = world("es-primary", "es"), english = world("en-primary", "en");
  assert.strictEqual(resolveHeroWorlds(slots, [secondary, primary, english], "es")[0], primary);
  assert.strictEqual(resolveHeroWorlds(slots, [english, secondary], "es")[0], secondary);
});

test("exact-world pins stay exact, duplicate groups are removed, and missing or filtered-out worlds cannot reappear", () => {
  const english = world("en-id", "en"), spanish = world("es-id", "es");
  const slots = [
    { slot: 0, kind: "world" as const, id: english.id },
    { slot: 1, kind: "group" as const, id: "pvz" },
    { slot: 2, kind: "world" as const, id: "private-or-unpublished-id" },
  ];
  assert.deepEqual(resolveHeroWorlds(slots, [english, spanish], "es"), [english]);
  assert.deepEqual(resolveHeroWorlds(slots, [], "es"), []);
});
