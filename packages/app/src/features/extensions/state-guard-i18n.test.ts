import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createInstance } from "i18next";
import { getExtensionDefinition, type ExtensionDetail } from "@yumina/shared";
import { SUPPORTED_LANGUAGES } from "../../lib/language-clamp";
import { localizeExtensionDetail } from "./localize-extension";

const definition = getExtensionDefinition("state-update-guard")!;
const detail: ExtensionDetail = { ...definition, stats: { downloadCount: 0, reviewCount: 0, averageRating: 0 } };

for (const language of SUPPORTED_LANGUAGES) {
  test(`Guard catalog has complete ${language} translations without English fallback`, async () => {
    const resources = JSON.parse(readFileSync(new URL(`../../locales/${language}/extensions.json`, import.meta.url), "utf8"));
    const entry = resources.catalog[definition.key];
    assert.ok(entry, `${language}: missing Guard catalog entry`);
    const strings = [entry.name, entry.shortDescription, entry.longDescription,
      ...definition.tags.map((tag) => entry.tags[tag]),
      ...definition.explanations.flatMap((_, i) => [entry.explanations[i]?.title, entry.explanations[i]?.body])];
    assert.ok(strings.every((text) => typeof text === "string" && text.trim().length > 0));
    assert.equal(entry.explanations.length, definition.explanations.length);
    assert.deepEqual(Object.keys(entry.tags).sort(), [...definition.tags].sort());
    if (language !== "en") {
      for (const key of ["name", "shortDescription", "longDescription"] as const) assert.notEqual(entry[key], definition[key]);
      for (const [i, explanation] of definition.explanations.entries()) {
        assert.notEqual(entry.explanations[i].title, explanation.title);
        assert.notEqual(entry.explanations[i].body, explanation.body);
      }
    }
    const i18n = createInstance();
    await i18n.init({ lng: language, fallbackLng: false, defaultNS: "extensions", resources: { [language]: { extensions: resources } } });
    const localized = localizeExtensionDetail(detail, i18n.getFixedT(language, "extensions"));
    assert.equal(localized.name, entry.name);
    assert.equal(localized.shortDescription, entry.shortDescription);
    assert.equal(localized.longDescription, entry.longDescription);
    assert.deepEqual(localized.tags, definition.tags.map((tag) => entry.tags[tag]));
    assert.deepEqual(localized.explanations, entry.explanations);
    assert.equal(detail.name, definition.name, "localizing does not mutate server catalog data");
  });
}
