import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeSettingsSearchAliases,
  searchSettingsItems,
  type SettingsSearchItem,
} from "./settings-search";
import { SETTINGS_SEARCH_TRANSLATORS } from "./settings-search-translations";

const items: SettingsSearchItem<"account" | "display" | "privacy">[] = [
  {
    id: "language",
    sectionId: "display",
    targetId: "settings-target-display-language",
    title: "Language",
    description: "Choose the language used throughout Yumina.",
    category: "Display / Language",
    keywords: ["English", "简体中文", "日本語"],
  },
  {
    id: "profile-visibility",
    sectionId: "privacy",
    targetId: "settings-target-privacy-visibility",
    title: "Profile Visibility",
    description: "Choose who can see your profile details.",
    category: "Privacy",
  },
  {
    id: "password",
    sectionId: "account",
    targetId: "settings-target-account-password",
    title: "Change Password",
    description: "Update your password.",
    category: "Account",
  },
  {
    id: "configuration",
    sectionId: "account",
    targetId: "settings-target-account-configuration",
    title: "Configuración",
    description: "Preferencias de la cuenta.",
    category: "Cuenta",
  },
];

test("returns no results for an empty query", () => {
  assert.deepEqual(searchSettingsItems(items, "   "), []);
});

test("ranks a title match above a description match", () => {
  const results = searchSettingsItems(items, "language");
  assert.equal(results[0]?.id, "language");
});

test("requires every query token to match the same setting", () => {
  const results = searchSettingsItems(items, "profile visibility");
  assert.deepEqual(results.map((item) => item.id), ["profile-visibility"]);
});

test("matches diacritic-free queries", () => {
  const results = searchSettingsItems(items, "configuracion");
  assert.equal(results[0]?.id, "configuration");
});

test("matches non-Latin setting titles", () => {
  const localizedItems: SettingsSearchItem<"display">[] = [
    {
      id: "language-zh",
      sectionId: "display",
      targetId: "settings-target-display-language",
      title: "语言",
      description: "选择梦坞的显示语言。",
      category: "显示",
    },
  ];

  assert.equal(searchSettingsItems(localizedItems, "显示语言")[0]?.id, "language-zh");
});

test("matches alternate language names stored as keywords", () => {
  assert.equal(searchSettingsItems(items, "日本語")[0]?.id, "language");
});

test("matches setting terminology from another supported UI language", () => {
  const localizedItemSets = SETTINGS_SEARCH_TRANSLATORS.map((translate) => [
    {
      ...items[0],
      title: translate("display.language.title"),
      category: translate("nav.display"),
    },
  ]);
  const englishIndex = mergeSettingsSearchAliases(localizedItemSets[0], localizedItemSets);
  const chineseIndex = mergeSettingsSearchAliases(localizedItemSets[1], localizedItemSets);

  assert.equal(searchSettingsItems(englishIndex, "语言")[0]?.id, "language");
  assert.equal(searchSettingsItems(chineseIndex, "language")[0]?.id, "language");
  assert.equal(localizedItemSets.length, 5);
  assert.ok(
    localizedItemSets.every(
      ([item]) => item.title !== "display.language.title" && item.category !== "nav.display"
    )
  );
});
