/**
 * The update log's web layer. changelog/ files are the base; a row in
 * changelog_entries wins over the file with the same id:
 *
 *   - content columns set  → the entry reads from the row ("edited on the web")
 *   - hidden = true        → the entry is gone for everyone but admins
 *   - no file with that id → a web-only entry
 *
 * "Restore the repo version" deletes the row. Every web change writes a
 * revision with the entry as it stood afterwards. Rows obey the same rules as
 * files (validateChangelogFields).
 */
import { desc, eq } from "drizzle-orm";
import { CHANGELOG_LANGS, type ChangelogLang } from "@yumina/shared";
import { db as primaryDb, readPublic, type DrizzleDB } from "../db/index.js";
import { changelogEntries, changelogEntryRevisions, user } from "../db/schema.js";
import {
  CHANGELOG_ID_RE,
  ChangelogFormatError,
  compareEntries,
  getChangelogEntries,
  validateChangelogFields,
  type ChangelogEntry,
  type ChangelogFields,
} from "./changelog.js";

export type ChangelogRow = typeof changelogEntries.$inferSelect;
export type ChangelogRevisionAction = "create" | "edit" | "hide" | "unhide" | "restore" | "delete";

export interface MergedChangelogEntry extends ChangelogEntry {
  /** A changelog/ file with this id exists. */
  hasFile: boolean;
  /** The content comes from the web (a file entry edited on the page, or a web-only entry). */
  fromWeb: boolean;
  hidden: boolean;
  /** The row's updated_at (ISO), for edit conflicts; null for an untouched file entry. */
  revision: string | null;
}

function hasContent(row: ChangelogRow): boolean {
  return row.titles !== null && row.bodies !== null;
}

function rowEntry(row: ChangelogRow): ChangelogEntry | null {
  if (!hasContent(row)) return null;
  try {
    return {
      id: row.id,
      ...validateChangelogFields(row.id, {
        date: row.date, audience: row.audience, areas: row.areas, title: row.titles, body: row.bodies,
        highlight: row.highlight, kind: row.kind,
      }),
    };
  } catch (error) {
    // Writes are validated, so this means the rules tightened since; keep the file version.
    console.error(`[changelog] stored row ${row.id} no longer validates: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

/** Files + rows → what the page shows (hidden entries included, flagged), newest first. */
export function mergeChangelog(files: ChangelogEntry[], rows: ChangelogRow[]): MergedChangelogEntry[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: MergedChangelogEntry[] = [];
  for (const file of files) {
    const row = byId.get(file.id);
    byId.delete(file.id);
    const web = row ? rowEntry(row) : null;
    out.push({ ...(web ?? file), hasFile: true, fromWeb: Boolean(web), hidden: row?.hidden ?? false, revision: row ? row.updatedAt.toISOString() : null });
  }
  for (const row of byId.values()) {
    const web = rowEntry(row);
    if (!web) continue; // a hide/override row whose file was removed from the repo
    out.push({ ...web, hasFile: false, fromWeb: true, hidden: row.hidden, revision: row.updatedAt.toISOString() });
  }
  return out.sort(compareEntries);
}

export class ChangelogStoreError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string, readonly field?: string) {
    super(message);
    this.name = "ChangelogStoreError";
  }
}

export interface ChangelogInput {
  date?: string | null;
  audience?: string | null;
  areas?: string[] | null;
  title?: Partial<Record<string, string>> | null;
  body?: Partial<Record<string, string>> | null;
  highlight?: boolean | null;
  kind?: string | null;
}

function validate(id: string, input: ChangelogInput) {
  try {
    return validateChangelogFields(id, input as ChangelogFields);
  } catch (error) {
    if (error instanceof ChangelogFormatError) throw new ChangelogStoreError(400, error.problem, error.field);
    throw error;
  }
}

type Snapshotable = Pick<ChangelogEntry, "date" | "audience" | "areas" | "title" | "body" | "highlight" | "kind">;
function snapshot(entry: Snapshotable | null, extra: Record<string, unknown>) {
  return entry
    ? {
        date: entry.date, audience: entry.audience, areas: entry.areas, title: entry.title, body: entry.body,
        highlight: entry.highlight, kind: entry.kind, ...extra,
      }
    : extra;
}

/** The DB columns for an entry's content. */
function contentColumns(fields: Snapshotable) {
  return {
    date: fields.date, audience: fields.audience, areas: fields.areas,
    titles: fields.title as Record<string, string>, bodies: fields.body as Record<string, string>,
    // cover / cover_alts stay in the table from an earlier design; nothing writes them now.
    highlight: fields.highlight, kind: fields.kind, cover: null, coverAlts: null,
  };
}

const PUBLIC_CACHE_MS = 30_000;
type Tx = Parameters<Parameters<typeof primaryDb.transaction>[0]>[0];

export function createChangelogStore(deps: {
  database?: () => DrizzleDB;
  readDatabase?: () => DrizzleDB;
  files?: () => ChangelogEntry[];
  now?: () => Date;
} = {}) {
  const database = deps.database ?? (() => primaryDb);
  const readDatabase = deps.readDatabase ?? (() => readPublic());
  const files = deps.files ?? getChangelogEntries;
  const now = deps.now ?? (() => new Date());
  let cache: { at: number; rows: ChangelogRow[] } | null = null;

  async function readRows(fresh: boolean): Promise<ChangelogRow[]> {
    if (!fresh && cache && Date.now() - cache.at < PUBLIC_CACHE_MS) return cache.rows;
    try {
      const rows = await (fresh ? database() : readDatabase()).select().from(changelogEntries);
      cache = { at: Date.now(), rows };
      return rows;
    } catch (error) {
      // The page must never fail because the web layer can't be read; files still show.
      console.error("[changelog] reading changelog_entries failed:", error instanceof Error ? error.message : error);
      return cache?.rows ?? [];
    }
  }

  /** Everything merged. `fresh` reads the primary (admins, right after their own edit). */
  async function list(fresh = false): Promise<MergedChangelogEntry[]> {
    return mergeChangelog(files(), await readRows(fresh));
  }

  async function rowFor(tx: Tx, id: string): Promise<ChangelogRow | null> {
    const [row] = await tx.select().from(changelogEntries).where(eq(changelogEntries.id, id));
    return row ?? null;
  }

  async function record(tx: Tx, entryId: string, action: ChangelogRevisionAction, actorId: string, snap: Record<string, unknown>) {
    await tx.insert(changelogEntryRevisions).values({ entryId, action, snapshot: snap, createdBy: actorId, createdAt: now() });
  }

  function fileFor(id: string): ChangelogEntry | null {
    return files().find((f) => f.id === id) ?? null;
  }

  function assertId(id: string) {
    if (!CHANGELOG_ID_RE.test(id)) throw new ChangelogStoreError(400, "id must look like YYYY-MM-DD-short-slug (lowercase letters, digits, dashes)", "id");
  }

  async function current(id: string): Promise<MergedChangelogEntry | null> {
    const file = fileFor(id);
    const [row] = await database().select().from(changelogEntries).where(eq(changelogEntries.id, id));
    return mergeChangelog(file ? [file] : [], row ? [row] : []).find((e) => e.id === id) ?? null;
  }

  function done<T>(value: T): T {
    cache = null;
    return value;
  }

  return {
    list,

    /** One entry with every language, for the editor. */
    async get(id: string): Promise<MergedChangelogEntry> {
      const entry = await current(id);
      if (!entry) throw new ChangelogStoreError(404, "No such entry");
      return entry;
    },

    async create(actorId: string, id: string, input: ChangelogInput): Promise<MergedChangelogEntry> {
      assertId(id);
      const fields = validate(id, input);
      if (fileFor(id)) throw new ChangelogStoreError(409, "An entry with this id already exists in changelog/", "id");
      const at = now();
      await database().transaction(async (tx) => {
        if (await rowFor(tx, id)) throw new ChangelogStoreError(409, "An entry with this id already exists", "id");
        await tx.insert(changelogEntries).values({
          id, ...contentColumns(fields), hidden: false, createdBy: actorId, updatedBy: actorId, createdAt: at, updatedAt: at,
        });
        await record(tx, id, "create", actorId, snapshot(fields, { hidden: false, source: "web" }));
      });
      return done((await current(id))!);
    },

    /** Save new content. On a file entry this creates the web override. */
    async update(actorId: string, id: string, input: ChangelogInput, expectedRevision?: string | null): Promise<MergedChangelogEntry> {
      const fields = validate(id, input);
      const file = fileFor(id);
      const at = now();
      await database().transaction(async (tx) => {
        const row = await rowFor(tx, id);
        if (!file && !(row && hasContent(row))) throw new ChangelogStoreError(404, "No such entry");
        const live = row ? row.updatedAt.toISOString() : null;
        if (expectedRevision !== undefined && expectedRevision !== live) {
          throw new ChangelogStoreError(409, "Someone else changed this entry meanwhile. Reload it and try again.");
        }
        const content = { ...contentColumns(fields), updatedBy: actorId, updatedAt: at };
        if (row) await tx.update(changelogEntries).set(content).where(eq(changelogEntries.id, id));
        else await tx.insert(changelogEntries).values({ id, ...content, hidden: false, createdBy: actorId, createdAt: at });
        await record(tx, id, "edit", actorId, snapshot(fields, { hidden: row?.hidden ?? false, source: file ? "file+web" : "web" }));
      });
      return done((await current(id))!);
    },

    async setHidden(actorId: string, id: string, hidden: boolean): Promise<MergedChangelogEntry> {
      const before = await current(id);
      if (!before) throw new ChangelogStoreError(404, "No such entry");
      const at = now();
      await database().transaction(async (tx) => {
        const row = await rowFor(tx, id);
        if (row && !hidden && !hasContent(row)) {
          // A hide-only row has nothing else to say: showing the file again drops it.
          await tx.delete(changelogEntries).where(eq(changelogEntries.id, id));
        } else if (row) {
          await tx.update(changelogEntries).set({ hidden, updatedBy: actorId, updatedAt: at }).where(eq(changelogEntries.id, id));
        } else if (hidden) {
          await tx.insert(changelogEntries).values({ id, hidden: true, createdBy: actorId, updatedBy: actorId, createdAt: at, updatedAt: at });
        }
        await record(tx, id, hidden ? "hide" : "unhide", actorId, snapshot(before, { hidden, source: before.fromWeb ? (before.hasFile ? "file+web" : "web") : "file" }));
      });
      return done((await current(id))!);
    },

    /** Delete a web-only entry for good. File entries can only be hidden. */
    async remove(actorId: string, id: string): Promise<void> {
      const before = await current(id);
      if (!before) throw new ChangelogStoreError(404, "No such entry");
      if (before.hasFile) throw new ChangelogStoreError(409, "This entry comes from changelog/ in the repo; hide it instead");
      await database().transaction(async (tx) => {
        await tx.delete(changelogEntries).where(eq(changelogEntries.id, id));
        await record(tx, id, "delete", actorId, snapshot(before, { hidden: before.hidden, source: "web" }));
      });
      done(undefined);
    },

    /** Drop the web override and the hide flag: the entry reads from its file again. */
    async restoreFile(actorId: string, id: string): Promise<MergedChangelogEntry> {
      const file = fileFor(id);
      if (!file) throw new ChangelogStoreError(409, "There is no changelog/ file for this entry to restore");
      await database().transaction(async (tx) => {
        if (!(await rowFor(tx, id))) throw new ChangelogStoreError(409, "This entry already shows the repo version");
        await tx.delete(changelogEntries).where(eq(changelogEntries.id, id));
        await record(tx, id, "restore", actorId, snapshot(file, { hidden: false, source: "file" }));
      });
      return done((await current(id))!);
    },

    async revisions(id: string) {
      return database()
        .select({
          id: changelogEntryRevisions.id,
          action: changelogEntryRevisions.action,
          snapshot: changelogEntryRevisions.snapshot,
          createdAt: changelogEntryRevisions.createdAt,
          byId: changelogEntryRevisions.createdBy,
          byName: user.name,
        })
        .from(changelogEntryRevisions)
        .leftJoin(user, eq(user.id, changelogEntryRevisions.createdBy))
        .where(eq(changelogEntryRevisions.entryId, id))
        .orderBy(desc(changelogEntryRevisions.createdAt))
        .limit(200);
    },
  };
}

export type ChangelogStore = ReturnType<typeof createChangelogStore>;

/** Every language of an entry (for the editor), empty strings where missing. */
export function allLanguages(record: Partial<Record<ChangelogLang, string>>): Record<ChangelogLang, string> {
  return Object.fromEntries(CHANGELOG_LANGS.map((lang) => [lang, record[lang] ?? ""])) as Record<ChangelogLang, string>;
}
