/**
 * The update log.
 *
 * GET /api/changelog?lang=xx — public. changelog/ files merged with web edits
 * (lib/changelog-store.ts), in the reader's language. Logged-out visitors and
 * ordinary users get public, visible entries. An admin (role re-checked
 * against the database, like adminMiddleware) also gets internal and hidden
 * entries with their source flags; that response is never cacheable.
 *
 * /api/changelog/admin/* — admins only (authMiddleware + adminMiddleware):
 * read one entry with every language, create, edit, hide/unhide, delete a
 * web-only entry, restore the repo version, list revisions, preview markdown,
 * and auto-translate zh + en into zh-Hant / es / ja.
 */
import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { ChangelogEditable, ChangelogLatestResponse, ChangelogResponse, ChangelogRevisionView } from "@yumina/shared";
import type { AppEnv } from "../lib/types.js";
import { authMiddleware, optionalAuthMiddleware } from "../middleware/auth.js";
import { adminMiddleware } from "../middleware/admin.js";
import { db } from "../db/index.js";
import { user as userTable } from "../db/schema.js";
import { entryView, renderChangelogMarkdown, type ChangelogEntry } from "../lib/changelog.js";
import { allLanguages, ChangelogStoreError, createChangelogStore, type ChangelogStore, type MergedChangelogEntry } from "../lib/changelog-store.js";
import { ChangelogTranslateError, translateChangelogEntry } from "../lib/changelog-translate.js";
import { getUnrestrictEligibility } from "../lib/unrestrict.js";

/** 解除限制 eligibility decides who sees `audience: unrestricted` entries. */
async function viewerIsUnrestricted(c: Context<AppEnv>): Promise<boolean> {
  const viewer = c.get("user");
  if (!viewer) return false;
  return (await getUnrestrictEligibility(viewer.id)).eligible;
}

async function viewerIsAdmin(c: Context<AppEnv>): Promise<boolean> {
  const viewer = c.get("user");
  // Cheap gate first: only a session that already claims admin costs a query.
  if (!viewer || viewer.role !== "admin") return false;
  const [row] = await db
    .select({ role: userTable.role, isBanned: userTable.isBanned, isSuspended: userTable.isSuspended })
    .from(userTable)
    .where(eq(userTable.id, viewer.id));
  return row?.role === "admin" && !row.isBanned && !row.isSuspended;
}

export interface ChangelogRouteDeps {
  store?: ChangelogStore;
  /** Shortcut for tests: serve these as the file entries. */
  entries?: () => ChangelogEntry[];
  isAdmin?: (c: Context<AppEnv>) => Promise<boolean>;
  isUnrestricted?: (c: Context<AppEnv>) => Promise<boolean>;
  authenticate?: boolean;
  translate?: typeof translateChangelogEntry;
}

/** What one viewer may see. Hidden and internal entries reach admins only;
 *  unrestricted entries also reach 解除限制-eligible accounts. */
export function visibleEntries(entries: MergedChangelogEntry[], viewer: { isAdmin: boolean; unrestricted?: boolean }, lang: string | null | undefined) {
  return entries
    .filter((e) => viewer.isAdmin || (!e.hidden && (e.audience === "public" || (e.audience === "unrestricted" && viewer.unrestricted === true))))
    .map((e) => {
      const view = entryView(e, lang);
      return viewer.isAdmin ? { ...view, admin: { hasFile: e.hasFile, fromWeb: e.fromWeb, hidden: e.hidden, revision: e.revision } } : view;
    });
}

function editable(e: MergedChangelogEntry): ChangelogEditable {
  return {
    id: e.id, date: e.date, audience: e.audience, areas: e.areas,
    title: allLanguages(e.title), body: allLanguages(e.body),
    highlight: e.highlight, kind: e.kind,
    hasFile: e.hasFile, fromWeb: e.fromWeb, hidden: e.hidden, revision: e.revision,
  };
}

const text = (max: number) => z.string().max(max);
const fieldsSchema = z.object({
  date: text(20),
  audience: text(20),
  areas: z.array(text(40)).max(20),
  title: z.record(text(1_000)),
  body: z.record(text(40_000)),
  highlight: z.boolean().optional(),
  kind: text(20).optional(),
});
const createSchema = fieldsSchema.extend({ slug: text(80) });
const updateSchema = fieldsSchema.extend({ revision: z.string().max(64).nullable().optional() });
const translateSchema = z.object({
  title: z.object({ zh: text(1_000).min(1), en: text(1_000).min(1) }),
  body: z.object({ zh: text(40_000).min(1), en: text(40_000).min(1) }),
});

async function jsonBody<T>(c: Context<AppEnv>, schema: z.ZodType<T>): Promise<T | Response> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid request", details: parsed.error.flatten() }, 400);
  return parsed.data;
}

export function createChangelogRoutes(deps: ChangelogRouteDeps = {}) {
  const store = deps.store ?? createChangelogStore(deps.entries ? { files: deps.entries } : {});
  const isAdmin = deps.isAdmin ?? viewerIsAdmin;
  const isUnrestricted = deps.isUnrestricted ?? viewerIsUnrestricted;
  const translate = deps.translate ?? translateChangelogEntry;
  const routes = new Hono<AppEnv>();

  if (deps.authenticate !== false) routes.use("/", optionalAuthMiddleware);
  routes.get("/", async (c) => {
    const admin = await isAdmin(c).catch(() => false);
    const unrestricted = admin ? false : await isUnrestricted(c).catch(() => false);
    const body: ChangelogResponse = {
      entries: visibleEntries(await store.list(admin), { isAdmin: admin, unrestricted }, c.req.query("lang")),
      includesInternal: admin,
    };
    c.header("Vary", "Cookie");
    c.header("Cache-Control", admin ? "private, no-store" : "private, max-age=60");
    if (admin) c.header("CDN-Cache-Control", "no-store");
    return c.json(body);
  });

  // The "something new" dot and the Discover banner: the newest public entry and
  // the newest public highlight. Same for everyone, so it skips auth and caches.
  routes.get("/latest", async (c) => {
    const shown = visibleEntries(await store.list(false), { isAdmin: false }, c.req.query("lang"));
    const top = shown[0];
    const highlight = shown.find((e) => e.highlight);
    const body: ChangelogLatestResponse = {
      latest: top ? { id: top.id, date: top.date } : null,
      highlight: highlight ? { id: highlight.id, date: highlight.date, title: highlight.title } : null,
    };
    c.header("Cache-Control", "public, max-age=300");
    return c.json(body);
  });

  const admin = new Hono<AppEnv>();
  admin.use("*", authMiddleware, adminMiddleware, async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    c.header("CDN-Cache-Control", "no-store");
    await next();
  });
  admin.onError((error, c) => {
    if (error instanceof ChangelogStoreError) return c.json({ error: error.message, field: error.field ?? null }, error.status);
    if (error instanceof ChangelogTranslateError) return c.json({ error: error.message }, error.reason === "unavailable" ? 503 : 502);
    throw error;
  });

  admin.get("/entries/:id", async (c) => c.json({ data: editable(await store.get(c.req.param("id"))) }));

  admin.post("/entries", async (c) => {
    const input = await jsonBody(c, createSchema);
    if (input instanceof Response) return input;
    const id = `${input.date.trim()}-${input.slug.trim().toLowerCase()}`;
    return c.json({ data: editable(await store.create(c.get("user").id, id, input)) }, 201);
  });

  admin.put("/entries/:id", async (c) => {
    const input = await jsonBody(c, updateSchema);
    if (input instanceof Response) return input;
    return c.json({ data: editable(await store.update(c.get("user").id, c.req.param("id"), input, input.revision)) });
  });

  admin.post("/entries/:id/hide", async (c) => c.json({ data: editable(await store.setHidden(c.get("user").id, c.req.param("id"), true)) }));
  admin.post("/entries/:id/unhide", async (c) => c.json({ data: editable(await store.setHidden(c.get("user").id, c.req.param("id"), false)) }));
  admin.post("/entries/:id/restore", async (c) => c.json({ data: editable(await store.restoreFile(c.get("user").id, c.req.param("id"))) }));
  admin.delete("/entries/:id", async (c) => {
    await store.remove(c.get("user").id, c.req.param("id"));
    return c.json({ ok: true });
  });

  admin.get("/entries/:id/revisions", async (c) => {
    const rows = await store.revisions(c.req.param("id"));
    const data: ChangelogRevisionView[] = rows.map((r) => ({
      id: r.id,
      action: r.action as ChangelogRevisionView["action"],
      createdAt: r.createdAt.toISOString(),
      by: { id: r.byId, name: r.byName },
      snapshot: r.snapshot as ChangelogRevisionView["snapshot"],
    }));
    return c.json({ data });
  });

  admin.post("/preview", async (c) => {
    const input = await jsonBody(c, z.object({ markdown: text(40_000) }));
    if (input instanceof Response) return input;
    return c.json({ data: { html: renderChangelogMarkdown(input.markdown) } });
  });

  admin.post("/translate", async (c) => {
    const input = await jsonBody(c, translateSchema);
    if (input instanceof Response) return input;
    return c.json({ data: await translate(input, { userId: c.get("user").id }) });
  });

  routes.route("/admin", admin);
  return routes;
}

export const changelogRoutes = createChangelogRoutes();
