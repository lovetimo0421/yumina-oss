import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PLAY_MODELS } from "../../../shared/src/constants/models";

const uiLocales = ["en", "es", "ja", "zh", "zh-Hant"] as const;
const playableModelDescriptionKeys = PLAY_MODELS.map((model) =>
  model.descKey.replace("aiProvider.models.", ""),
);

for (const locale of uiLocales) {
  test(`every playable model has a localized description in ${locale}`, () => {
    const localeFile = new URL(`../locales/${locale}/profile.json`, import.meta.url);
    const messages = JSON.parse(readFileSync(localeFile, "utf8")) as {
      aiProvider?: { models?: Record<string, unknown> };
    };
    const localizedModels = messages.aiProvider?.models ?? {};
    const missingOrEmptyKeys = playableModelDescriptionKeys.filter(
      (key) =>
        typeof localizedModels[key] !== "string" ||
        localizedModels[key].trim().length === 0,
    );

    assert.deepEqual(missingOrEmptyKeys, []);
  });
}
