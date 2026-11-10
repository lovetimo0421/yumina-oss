import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { ChangelogResponse } from "@yumina/shared";
import { parseChangelogEntry } from "../lib/changelog.js";
import { createChangelogRoutes } from "./changelog.js";

const entry = (file: string, audience: "public" | "internal" | "unrestricted") =>
  parseChangelogEntry(
    file,
    `---\ndate: ${file.slice(0, 10)}\naudience: ${audience}\nareas: [chat]\ntitle:\n  zh: 标题 ${file}\n  en: Title ${file}\n---\n## zh\n· 内容\n\n## en\n· Body\n`,
  );
const ENTRIES = [entry("2026-10-12-team-only.md", "internal"), entry("2026-10-11-hello.md", "public")];

function app(isAdmin?: boolean) {
  const root = new Hono();
  root.route(
    "/api/changelog",
    createChangelogRoutes({
      entries: () => ENTRIES,
      authenticate: false,
      ...(isAdmin === undefined ? {} : { isAdmin: async () => isAdmin }),
    }),
  );
  return root;
}

test("a logged-out request never receives internal entries", async () => {
  // Default admin check with no session user: no DB query, not an admin.
  const res = await app().request("/api/changelog?lang=zh");
  assert.equal(res.status, 200);
  const body = (await res.json()) as ChangelogResponse;
  assert.equal(body.includesInternal, false);
  assert.deepEqual(body.entries.map((e) => e.id), ["2026-10-11-hello"]);
  assert.equal(body.entries[0]!.lang, "zh");
  assert.equal(body.entries[0]!.title, "标题 2026-10-11-hello.md");
  assert.doesNotMatch(JSON.stringify(body), /team-only/);
  assert.equal(res.headers.get("cache-control"), "private, max-age=60");
});

test("a signed-in non-admin gets the same public list", async () => {
  const body = (await (await app(false).request("/api/changelog?lang=en")).json()) as ChangelogResponse;
  assert.deepEqual(body.entries.map((e) => e.id), ["2026-10-11-hello"]);
});

test("an admin also gets internal entries, uncacheable", async () => {
  const res = await app(true).request("/api/changelog?lang=en");
  const body = (await res.json()) as ChangelogResponse;
  assert.equal(body.includesInternal, true);
  assert.deepEqual(body.entries.map((e) => [e.id, e.audience]), [["2026-10-12-team-only", "internal"], ["2026-10-11-hello", "public"]]);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
});

test("a failing admin check falls back to the public list", async () => {
  const root = new Hono();
  root.route("/api/changelog", createChangelogRoutes({ entries: () => ENTRIES, authenticate: false, isAdmin: async () => { throw new Error("db down"); } }));
  const body = (await (await root.request("/api/changelog")).json()) as ChangelogResponse;
  assert.deepEqual(body.entries.map((e) => e.id), ["2026-10-11-hello"]);
  assert.equal(body.entries[0]!.lang, "en");
});

test("unrestricted entries reach 解除限制-eligible accounts and admins, never anyone else", async () => {
  const entries = [entry("2026-10-13-adults.md", "unrestricted"), ...ENTRIES];
  const serve = (opts: { isAdmin: boolean; isUnrestricted: () => Promise<boolean> }) => {
    const root = new Hono();
    root.route("/api/changelog", createChangelogRoutes({ entries: () => entries, authenticate: false, isAdmin: async () => opts.isAdmin, isUnrestricted: opts.isUnrestricted }));
    return root;
  };
  const ids = async (root: Hono) => ((await (await root.request("/api/changelog")).json()) as ChangelogResponse).entries.map((e) => e.id);
  assert.deepEqual(await ids(serve({ isAdmin: false, isUnrestricted: async () => true })), ["2026-10-13-adults", "2026-10-11-hello"]);
  assert.deepEqual(await ids(serve({ isAdmin: false, isUnrestricted: async () => false })), ["2026-10-11-hello"]);
  assert.deepEqual(await ids(serve({ isAdmin: false, isUnrestricted: async () => { throw new Error("db down"); } })), ["2026-10-11-hello"]);
  assert.deepEqual(await ids(serve({ isAdmin: true, isUnrestricted: async () => false })), ["2026-10-13-adults", "2026-10-12-team-only", "2026-10-11-hello"]);
  // Logged out (default check, no session user): public only.
  const root = new Hono();
  root.route("/api/changelog", createChangelogRoutes({ entries: () => entries, authenticate: false }));
  assert.deepEqual(await ids(root), ["2026-10-11-hello"]);
});
