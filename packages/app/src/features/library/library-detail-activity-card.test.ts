import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { JSDOM } from "jsdom";
import { LibraryDetailActivityCard } from "./library-detail-activity-card";
import type { ActivityStats } from "../../lib/library-detail-stats";

const stats: ActivityStats = { worldId: "test", downloadCount: 62, messageCount: 8889, favoriteCount: 35, uniquePlayerCount: 45, averagePlaytimePerPlayerSeconds: 6420, reviewCount: 0, totalPlaytimeSeconds: 643320 };
async function render(showCreatorMetrics: boolean, overrides: Partial<ActivityStats> = {}) {
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { library: JSON.parse(readFileSync(new URL("../../locales/en/library.json", import.meta.url), "utf8")) } } });
  return new JSDOM(renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(LibraryDetailActivityCard, { layout: "preview", showCreatorMetrics, stats: { ...stats, ...overrides }, onViewReviews: () => {} }))));
}

test("activity shows all seven metrics together and explains zero reviews", async () => {
  const dom = await render(true);
  try {
    const document = dom.window.document;
    const primary = document.querySelector("section > dl")!;
    assert.equal(primary.querySelectorAll("dd").length, 7);
    assert.equal(primary.querySelector("dd")?.textContent, "45");
    assert.match(primary.textContent!, /8,889/);
    assert.match(primary.textContent!, /62/);
    assert.match(primary.textContent!, /35/);
    assert.match(primary.textContent!, /1h 47m/);
    assert.match(primary.textContent!, /178h/);
    assert.equal(document.querySelector("details"), null);
    assert.match(primary.textContent!, /No reviews yet/);
  } finally { dom.window.close(); }
});

test("community never reveals restricted metrics and does not call an unknown review count zero", async () => {
  const dom = await render(false, { reviewCount: undefined, totalPlaytimeSeconds: undefined });
  try {
    const text = dom.window.document.body.textContent!;
    assert.match(text, /62/);
    assert.doesNotMatch(text, /45|1h 47m|No reviews yet/);
    assert.equal(dom.window.document.querySelector("details"), null);
  } finally { dom.window.close(); }
});
