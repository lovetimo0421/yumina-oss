/**
 * GET /api/public-page?path=/pricing
 *
 * The public intro pages (pricing, the Atelier and its model and style pages,
 * one page per update-log entry, the genre pages such as /ai-rpg) are written once, on the server, and sent in
 * the HTML for crawlers (lib/prerender.ts). The app shows the same words to a
 * person who opens one of those addresses: it reads the fragment from here
 * and puts it on the page, so what a visitor sees and what a search engine
 * indexed are one text, and the copy lives in one place.
 *
 * Only those pages: this is not a way to read any other page's fragment.
 */
import { Hono } from "hono";
import { ATELIER_PATH } from "../lib/atelier-public.js";
import { findLandingPage } from "../lib/landing-public.js";
import { renderPublicContent } from "../lib/prerender.js";
import { PRICING_PATH } from "../lib/pricing-public.js";
import { getMetaForPath } from "../lib/seo.js";
import { parseUpdatePath } from "../lib/updates-public.js";

/** The addresses this endpoint serves. */
export function isPublicIntroPath(path: string): boolean {
  return (
    path === PRICING_PATH ||
    path === ATELIER_PATH ||
    path.startsWith(`${ATELIER_PATH}/`) ||
    parseUpdatePath(path) !== null ||
    findLandingPage(path.toLowerCase()) !== undefined
  );
}

export const publicPageRoutes = new Hono();

publicPageRoutes.get("/", async (c) => {
  const raw = c.req.query("path") ?? "";
  const path = raw.length > 1 ? raw.replace(/\/+$/, "") : raw;
  if (path.length > 200 || !isPublicIntroPath(path)) return c.json({ error: "Not found" }, 404);
  const meta = await getMetaForPath(path);
  const html = meta.status || meta.noindex ? null : await renderPublicContent(path);
  if (!html) {
    c.header("Cache-Control", "no-store");
    return c.json({ error: "Not found" }, 404);
  }
  // The same five minutes the fragment itself is cached for.
  c.header("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
  return c.json({ data: { title: meta.title, description: meta.description, lang: meta.lang ?? "en", html } });
});
