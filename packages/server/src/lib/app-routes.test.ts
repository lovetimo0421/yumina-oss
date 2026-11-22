import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { APP_ROUTE_PATHS } from "./app-routes.gen.js";
import { isAppRoute, routePatternToRegex } from "./app-routes.js";
import { getMetaForPath, injectMeta } from "./seo.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const treeFile = path.resolve(here, "../../../app/src/routeTree.gen.ts");

/** Same reading as scripts/gen-app-routes.mjs: the router's own list of full paths. */
function routeTreePaths(): string[] {
  const source = fs.readFileSync(treeFile, "utf8");
  const block = /export interface FileRoutesByFullPath \{([\s\S]*?)\n\}/.exec(source);
  assert.ok(block, "FileRoutesByFullPath not found in routeTree.gen.ts");
  return [...block[1]!.matchAll(/^\s*'([^']+)':/gm)].map((m) => (m[1]!.length > 1 ? m[1]!.replace(/\/+$/, "") : m[1]!));
}

test("every route in the app's router is in the server's list (run `node scripts/gen-app-routes.mjs` when this fails)", () => {
  const known = new Set(APP_ROUTE_PATHS);
  const missing = routeTreePaths().filter((p) => !known.has(p));
  // A route the server does not know would answer 404 to crawlers while the
  // app renders it. The list may hold more than the tree (the open-source
  // export drops hosted routes from the tree), never less.
  assert.deepEqual(missing, [], `routes missing from app-routes.gen.ts: ${missing.join(", ")}`);
});

test("a real address matches a route; a made-up one does not", () => {
  for (const real of [
    "/", "/login", "/register", "/updates", "/krew", "/krew/room/ABCD", "/app", "/app/", "/app/library", "/app/worlds",
    "/app/worlds/create", "/app/chat/abc", "/app/hub/5c9c88e8-f8fa-4893-b967-61f8c34404ba", "/app/users/u1/followers",
    "/app/community", "/app/community/general", "/app/community/thread/t1", "/app/community/events/e1/submit",
    "/app/tag/romance", "/@mia", "/%40mia", "/@mia/sakura-season-5c9c88e8", "/invite/CODE", "/APP/Library",
  ]) {
    assert.equal(isAppRoute(real), true, real);
  }
  for (const fake of [
    "/plans-and-prices", "/gallery", "/wp-login.php", "/app/nope", "/app/library/extra", "/app/tag", "/app/tag/a/b",
    "/app/worlds/x/y/z", "/mia", "/mia/sakura", "/login/extra", "/foo/bar/baz", "/.env",
  ]) {
    assert.equal(isAppRoute(fake), false, fake);
  }
});

test("a pattern's parameters match one segment and a splat matches the rest", () => {
  assert.ok(routePatternToRegex("/app/users/$userId").test("/app/users/abc"));
  assert.ok(!routePatternToRegex("/app/users/$userId").test("/app/users/abc/def"));
  assert.ok(routePatternToRegex("/krew/$").test("/krew/a/b"));
  assert.ok(!routePatternToRegex("/a.b").test("/axb"), "a dot in a route is a dot");
});

const shell = `<!doctype html><html lang="en"><head>
    <title>Yumina</title>
    <meta name="description" content="x" />
    <link rel="canonical" href="https://yumina.io/" />
    <meta property="og:url" content="https://yumina.io/" />
  </head><body><div id="root"></div></body></html>`;

test("an address that is no page answers 404, noindex, with no canonical; the shell still carries the app", async () => {
  for (const fake of ["/plans-and-prices", "/gallery", "/app/nope", "/some/made/up/path", "/app/settings-typo/x"]) {
    const meta = await getMetaForPath(fake);
    assert.equal(meta.status, 404, fake);
    assert.equal(meta.noindex, true, fake);
    const html = injectMeta(shell, meta);
    assert.doesNotMatch(html, /rel="canonical"/, "a missing page names no canonical address");
    assert.match(html, /<meta name="robots" content="noindex, nofollow" \/>/);
    assert.match(html, /<div id="root"><\/div>/, "the app still boots and shows its own not-found screen");
  }
});

test("real routes keep answering as pages", async () => {
  for (const real of ["/", "/login", "/register", "/updates", "/krew", "/app/library", "/app/worlds", "/app/bundles", "/app/learn"]) {
    const meta = await getMetaForPath(real);
    assert.equal(meta.status, undefined, real);
    assert.match(injectMeta(shell, meta), /<link rel="canonical" href="[^"]+" \/>/, real);
  }
  // Signed-in pages stay 200 and out of search, as before.
  const settings = await getMetaForPath("/app/settings");
  assert.equal(settings.status, undefined);
  assert.equal(settings.noindex, true);
});
