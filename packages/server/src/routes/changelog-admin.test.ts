import "../test/database-fixture.js";
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { ChangelogResponse } from "@yumina/shared";
import { db } from "../db/index.js";
import { auth } from "../lib/auth.js";
import { changelogEntries, changelogEntryRevisions, user } from "../db/schema.js";
import { parseChangelogEntry } from "../lib/changelog.js";
import { createChangelogStore, mergeChangelog } from "../lib/changelog-store.js";
import { createChangelogRoutes } from "./changelog.js";

const fileEntry = (id: string, audience: "public" | "internal" = "public") =>
  parseChangelogEntry(
    `${id}.md`,
    `---\ndate: ${id.slice(0, 10)}\naudience: ${audience}\nareas: [chat]\ntitle:\n  zh: 文件 ${id}\n  en: File ${id}\n---\n## zh\n· 文件内容\n\n## en\n· File body\n`,
  );
const FILES = [fileEntry("2026-10-11-from-file"), fileEntry("2026-10-10-team-file", "internal")];

const translated = { "zh-Hant": { title: "繁", body: "· 繁" }, es: { title: "ES", body: "· es" }, ja: { title: "JA", body: "· ja" } };
const store = createChangelogStore({ files: () => FILES, readDatabase: () => db });
const app = new Hono().route("/api/changelog", createChangelogRoutes({ store, translate: async () => translated }));

const call = (path: string, actor: string | null, method = "GET", body?: unknown) =>
  app.request(`/api/changelog${path}`, {
    method,
    headers: { ...(actor ? { "x-test-user": actor } : {}), "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const list = async (actor: string | null, lang = "en") => (await (await call(`?lang=${lang}`, actor)).json()) as ChangelogResponse;
const ids = (r: ChangelogResponse) => r.entries.map((e) => e.id);

const valid = {
  date: "2026-10-12",
  audience: "public",
  areas: ["community"],
  title: { zh: "网页新条目", en: "Web entry" },
  body: { zh: "· 网页内容", en: "· Web body" },
};

before(async () => {
  await db.insert(user).values([
    { id: "boss", name: "Boss", email: "boss@test.invalid", role: "admin", birthYear: 1990 },
    { id: "reader", name: "Reader", email: "reader@test.invalid", birthYear: 1990 },
  ]);
});

test("update log: admin web layer, merge rules, access and revisions", async (t) => {
  t.mock.method(auth.api, "getSession", async ({ headers }: { headers: Headers }) => {
    const id = headers.get("x-test-user");
    return id ? { user: { id }, session: { id: `${id}-session`, userId: id, expiresAt: new Date(Date.now() + 60_000), token: "fixture" } } : null;
  });

  // Every write route refuses guests (401) and non-admins (403), and nothing is written.
  const writes: Array<[string, string, unknown?]> = [
    ["/admin/entries", "POST", { ...valid, slug: "nope" }],
    ["/admin/entries/2026-10-11-from-file", "PUT", valid],
    ["/admin/entries/2026-10-11-from-file/hide", "POST"],
    ["/admin/entries/2026-10-11-from-file/unhide", "POST"],
    ["/admin/entries/2026-10-11-from-file/restore", "POST"],
    ["/admin/entries/2026-10-11-from-file", "DELETE"],
    ["/admin/entries/2026-10-11-from-file", "GET"],
    ["/admin/entries/2026-10-11-from-file/revisions", "GET"],
    ["/admin/preview", "POST", { markdown: "x" }],
    ["/admin/translate", "POST", { title: { zh: "a", en: "b" }, body: { zh: "a", en: "b" } }],
  ];
  for (const [path, method, body] of writes) {
    assert.equal((await call(path, null, method, body)).status, 401, `${method} ${path} guest`);
    assert.equal((await call(path, "reader", method, body)).status, 403, `${method} ${path} non-admin`);
  }
  assert.equal((await db.select().from(changelogEntries)).length, 0);
  assert.equal((await db.select().from(changelogEntryRevisions)).length, 0);

  // Public list: files only, internal hidden from everyone but admins.
  assert.deepEqual(ids(await list(null)), ["2026-10-11-from-file"]);
  assert.deepEqual(ids(await list("reader")), ["2026-10-11-from-file"]);
  const adminList = await list("boss");
  assert.deepEqual(ids(adminList), ["2026-10-11-from-file", "2026-10-10-team-file"]);
  assert.deepEqual(adminList.entries[0]!.admin, { hasFile: true, fromWeb: false, hidden: false, revision: null });
  assert.equal((await list(null)).entries[0]!.admin, undefined, "no admin metadata for guests");

  // Validation: same rules as files, clear message + field.
  const bad = await call("/admin/entries", "boss", "POST", { ...valid, slug: "bad", areas: ["magic"] });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: 'unknown area "magic" (see the list in changelog/README.md)', field: "areas" });
  const noEn = await call("/admin/entries", "boss", "POST", { ...valid, slug: "bad", title: { zh: "只有中文" } });
  assert.equal(((await noEn.json()) as { field: string }).field, "title.en");
  assert.equal((await call("/admin/entries", "boss", "POST", { ...valid, slug: "Bad Slug" })).status, 400);
  assert.equal((await call("/admin/entries", "boss", "POST", { ...valid, date: "2026-02-30", slug: "x" })).status, 400);
  assert.equal((await call("/admin/entries", "boss", "POST", { ...valid, audience: "team", slug: "x" })).status, 400);
  assert.equal((await call("/admin/entries", "boss", "POST", { ...valid, date: "2026-10-11", slug: "from-file" })).status, 409, "can't shadow a file id by creating");

  // Create a web-only entry: shows to everyone, flagged fromWeb for admins.
  const created = await call("/admin/entries", "boss", "POST", { ...valid, slug: "web-news" });
  assert.equal(created.status, 201, await created.clone().text());
  assert.deepEqual(ids(await list(null)), ["2026-10-12-web-news", "2026-10-11-from-file"]);
  assert.equal((await list("boss")).entries[0]!.admin!.fromWeb, true);
  assert.equal((await call("/admin/entries", "boss", "POST", { ...valid, slug: "web-news" })).status, 409);

  // Edit a file entry → web override wins; revision guards concurrent edits.
  const raw = (await (await call("/admin/entries/2026-10-11-from-file", "boss")).json()) as { data: { title: Record<string, string>; revision: string | null } };
  assert.equal(raw.data.title.en, "File 2026-10-11-from-file");
  assert.equal(raw.data.title.ja, "", "every language present for the editor");
  const edit = { date: "2026-10-11", audience: "public", areas: ["chat", "image"], title: { zh: "改过的", en: "Edited on the web" }, body: { zh: "· 新", en: "· New" } };
  const saved = await call("/admin/entries/2026-10-11-from-file", "boss", "PUT", { ...edit, revision: raw.data.revision });
  assert.equal(saved.status, 200, await saved.clone().text());
  const afterEdit = await list(null);
  assert.equal(afterEdit.entries.find((e) => e.id === "2026-10-11-from-file")!.title, "Edited on the web");
  assert.equal((await list("boss")).entries.find((e) => e.id === "2026-10-11-from-file")!.admin!.fromWeb, true);
  assert.equal((await call("/admin/entries/2026-10-11-from-file", "boss", "PUT", { ...edit, revision: null })).status, 409, "stale revision");

  // Hide: gone for guests, still listed (flagged) for admins. Delete is refused for file entries.
  assert.equal((await call("/admin/entries/2026-10-11-from-file/hide", "boss", "POST")).status, 200);
  assert.deepEqual(ids(await list(null)), ["2026-10-12-web-news"]);
  assert.equal((await list("boss")).entries.find((e) => e.id === "2026-10-11-from-file")!.admin!.hidden, true);
  assert.equal((await call("/admin/entries/2026-10-11-from-file", "boss", "DELETE")).status, 409);

  // Restore the repo version: override and hide flag both gone.
  assert.equal((await call("/admin/entries/2026-10-11-from-file/restore", "boss", "POST")).status, 200);
  const restored = (await list(null)).entries.find((e) => e.id === "2026-10-11-from-file")!;
  assert.equal(restored.title, "File 2026-10-11-from-file");
  assert.equal((await db.select().from(changelogEntries).where(eq(changelogEntries.id, "2026-10-11-from-file"))).length, 0);
  assert.equal((await call("/admin/entries/2026-10-11-from-file/restore", "boss", "POST")).status, 409, "nothing left to restore");
  assert.equal((await call("/admin/entries/2026-10-12-web-news/restore", "boss", "POST")).status, 409, "web-only has no file");

  // Hide a file entry without editing it, then show it again: the hide-only row disappears.
  await call("/admin/entries/2026-10-11-from-file/hide", "boss", "POST");
  assert.deepEqual(ids(await list(null)), ["2026-10-12-web-news"]);
  await call("/admin/entries/2026-10-11-from-file/unhide", "boss", "POST");
  assert.deepEqual(ids(await list(null)), ["2026-10-12-web-news", "2026-10-11-from-file"]);
  assert.equal((await db.select().from(changelogEntries).where(eq(changelogEntries.id, "2026-10-11-from-file"))).length, 0);

  // A web entry turned internal never reaches non-admins; hidden web entries neither.
  const web = (await (await call("/admin/entries/2026-10-12-web-news", "boss")).json()) as { data: { revision: string } };
  await call("/admin/entries/2026-10-12-web-news", "boss", "PUT", { ...valid, audience: "internal", revision: web.data.revision });
  assert.deepEqual(ids(await list(null)), ["2026-10-11-from-file"]);
  assert.deepEqual(ids(await list("reader")), ["2026-10-11-from-file"]);
  assert.doesNotMatch(JSON.stringify(await list(null)), /web-news|team-file/);

  // Revisions: every action recorded with who did it.
  const revisions = (await (await call("/admin/entries/2026-10-11-from-file/revisions", "boss")).json()) as { data: Array<{ action: string; by: { name: string } }> };
  assert.deepEqual(revisions.data.map((r) => r.action), ["unhide", "hide", "restore", "hide", "edit"]);
  assert.equal(revisions.data[0]!.by.name, "Boss");

  // Hard delete a web-only entry; the delete itself is archived.
  assert.equal((await call("/admin/entries/2026-10-12-web-news", "boss", "DELETE")).status, 200);
  assert.equal((await call("/admin/entries/2026-10-12-web-news", "boss")).status, 404);
  const webRevisions = (await (await call("/admin/entries/2026-10-12-web-news/revisions", "boss")).json()) as { data: Array<{ action: string }> };
  assert.deepEqual(webRevisions.data.map((r) => r.action), ["delete", "edit", "create"]);

  // Presentation fields round-trip through the web editor and reach the public list.
  const shiny = await call("/admin/entries", "boss", "POST", { ...valid, slug: "shiny", highlight: true, kind: "roundup" });
  assert.equal(shiny.status, 201, await shiny.clone().text());
  const shinyView = (await list(null, "ja")).entries.find((e) => e.id === "2026-10-12-shiny")!;
  assert.deepEqual([shinyView.highlight, shinyView.kind], [true, "roundup"]);
  const latest = (await (await call("/latest", null)).json()) as { latest: { id: string }; highlight: { id: string; title: string } };
  assert.equal(latest.latest.id, "2026-10-12-shiny");
  assert.equal(latest.highlight.id, "2026-10-12-shiny");
  await call("/admin/entries/2026-10-12-shiny/hide", "boss", "POST");
  const afterHide = (await (await call("/latest", null)).json()) as { latest: { id: string }; highlight: unknown };
  assert.equal(afterHide.latest.id, "2026-10-11-from-file", "hidden entries never reach /latest");
  assert.equal(afterHide.highlight, null);
  await call("/admin/entries/2026-10-12-shiny", "boss", "DELETE");

  // Preview and translate (stubbed provider).
  const preview = (await (await call("/admin/preview", "boss", "POST", { markdown: "· **hi** <b>x</b>" })).json()) as { data: { html: string } };
  assert.match(preview.data.html, /<li><strong>hi<\/strong> &lt;b&gt;x&lt;\/b&gt;<\/li>/);
  const tr = await call("/admin/translate", "boss", "POST", { title: { zh: "标题", en: "Title" }, body: { zh: "· 内容", en: "· Body" } });
  assert.deepEqual(((await tr.json()) as { data: unknown }).data, translated);
});

test("merge rules: override, hide-only, web-only, orphan rows", () => {
  const row = (id: string, patch: Partial<typeof changelogEntries.$inferSelect> = {}) => ({
    id, date: null, audience: null, areas: null, titles: null, bodies: null, hidden: false,
    highlight: false, kind: null, cover: null, coverAlts: null,
    createdBy: null, updatedBy: null, createdAt: new Date("2026-10-11T00:00:00Z"), updatedAt: new Date("2026-10-11T00:00:00Z"), ...patch,
  });
  const content = { date: "2026-10-13", audience: "public", areas: ["other"], titles: { zh: "网", en: "Web" }, bodies: { zh: "· 网", en: "· Web" } };
  const merged = mergeChangelog(FILES, [
    row("2026-10-11-from-file", { hidden: true }),
    row("2026-10-10-team-file", content),
    row("2026-10-13-web-only", content),
    row("2026-09-01-file-removed", { hidden: true }),
    row("2026-09-02-bad-row", { ...content, areas: ["nope"] }),
  ]);
  // Newest first by date; the edited file entry moved to 10-13 but keeps its id.
  assert.deepEqual(merged.map((e) => [e.id, e.hasFile, e.fromWeb, e.hidden, e.title.en]), [
    ["2026-10-13-web-only", false, true, false, "Web"],
    ["2026-10-10-team-file", true, true, false, "Web"],
    ["2026-10-11-from-file", true, false, true, "File 2026-10-11-from-file"],
  ]);
  const byId = Object.fromEntries(merged.map((e) => [e.id, e]));
  assert.equal(byId["2026-10-10-team-file"]!.audience, "public", "override replaces audience too");
  assert.equal(byId["2026-10-10-team-file"]!.date, "2026-10-13");
  assert.equal(byId["2026-10-11-from-file"]!.hidden, true);
  assert.equal(byId["2026-10-13-web-only"]!.hasFile, false);
  assert.equal(byId["2026-09-01-file-removed"], undefined, "a hide row without its file shows nothing");
  assert.equal(byId["2026-09-02-bad-row"], undefined, "an invalid web-only row is skipped");
  assert.equal(merged.length, 3);
});
