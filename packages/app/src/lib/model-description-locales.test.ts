import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { createInstance } from "i18next";
import { PLAY_MODELS } from "../../../shared/src/constants/models";
import { groupPlayModels } from "../../../shared/src/constants/model-families";
import { orderOfficialModels } from "./official-model-order";

const localeRoot = new URL("../locales/", import.meta.url);
const locales = readdirSync(localeRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);

for (const locale of locales) {
  test(`${locale}: every model and family version has its own translated review without fallback`, async () => {
    const profile = JSON.parse(readFileSync(new URL(`${locale}/profile.json`, localeRoot), "utf8"));
    const chat = JSON.parse(readFileSync(new URL(`${locale}/chat.json`, localeRoot), "utf8"));
    const instance = createInstance();
    await instance.init({ lng: locale, fallbackLng: false, resources: { [locale]: { profile } }, defaultNS: "profile" });
    const keys = PLAY_MODELS.map(model => model.descKey?.split(".").pop());
    assert.equal(new Set(keys).size, PLAY_MODELS.length, "model keys must not be shared between versions");
    assert.deepEqual(Object.keys(profile.aiProvider.models).sort(), [...keys].sort());
    assert.ok(chat.modelBrowser.supportsImages.trim());
    for (const group of groupPlayModels(PLAY_MODELS)) {
      for (const { model } of group.variants) {
        assert.ok(model.descKey, model.id);
        const description = instance.t(model.descKey, { defaultValue: "" });
        assert.ok(description.length >= 20, `${model.id}: empty or placeholder review`);
        assert.notEqual(description, model.descKey, model.id);
        assert.ok(!description.includes("�"), `${model.id}: invalid encoding`);
        const matches = orderOfficialModels(PLAY_MODELS, {
          tier: "all", query: description, sort: "popular", pinned: [], favoritesOnly: false, recent: [],
          description: entry => instance.t(entry.descKey!, { defaultValue: "" }),
        });
        assert.ok(matches.some(entry => entry.id === model.id), `${model.id}: review is not searchable`);
      }
    }
  });
}
