import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { edition } from "../edition/index.js";
import { renderPricing } from "../lib/pricing-public.js";
import { isPublicIntroPath, publicPageRoutes } from "./public-page.js";

const app = new Hono().route("/api/public-page", publicPageRoutes);
const get = (path: string) => app.request(`http://x/api/public-page?path=${encodeURIComponent(path)}`);

test("only the public intro pages are served: pricing, the Atelier, one update entry", () => {
  for (const yes of ["/pricing", "/atelier", "/atelier/image/seedream", "/atelier/styles/anime", "/updates/2026-10-11-hello", "/updates/2026-10-11-hello/zh"]) {
    assert.equal(isPublicIntroPath(yes), true, yes);
  }
  for (const no of ["/", "/updates", "/updates/feed.xml", "/app/plans", "/app/settings", "/@mia/world-1a2b3c4d", "/app/community/thread/x", "/pricing2", "/atelierx"]) {
    assert.equal(isPublicIntroPath(no), false, no);
  }
});

test("the app gets the same fragment the crawler was sent; anything else is a 404", { skip: edition.info().features.billing ? false : "this edition has no plans" }, async () => {
  const res = await get("/pricing");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "public, max-age=300, stale-while-revalidate=3600");
  const { data } = (await res.json()) as { data: { title: string; lang: string; html: string } };
  assert.equal(data.html, renderPricing());
  assert.match(data.title, /^Yumina Pricing/);
  assert.equal(data.lang, "en");
  assert.equal((await get("/pricing/")).status, 200, "a trailing slash is the same page");

  for (const missing of ["/app/plans", "/app/settings", "/", "/atelier/image/no-such-model", "/updates/2020-01-01-nothing", "", `/${"x".repeat(300)}`]) {
    assert.equal((await get(missing)).status, 404, missing);
  }
});
