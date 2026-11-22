/**
 * Entries an author keeps to themselves on a card others may remix.
 *
 * Two places say an entry is kept:
 *  - on the author's own card, `worlds.retained` (set in the publish dialog)
 *    lists entry ids and folder ids;
 *  - on a copy of that card, each kept entry and folder carries a `sealed`
 *    mark naming the author (written by `sealCopy` when the copy is made).
 *
 * The stored schema always holds the real text, so prompts are built as usual.
 * Whatever leaves the server for anyone but the author goes through
 * `redactWorldFor`, and whatever a copy's owner saves goes through
 * `restoreSealed`, which puts the real text back and refuses edits to it.
 */

export interface RetainedSet {
  entryIds: string[];
  folderIds: string[];
}

interface SealedMark { by: string; from?: string }
type Entry = Record<string, unknown> & { id: string; sealed?: SealedMark };
type Folder = Record<string, unknown> & { id: string; sealed?: SealedMark };
type Schema = Record<string, unknown>;

/** What a kept entry or folder is called where its name may not be shown. The
 *  app prints its own wording whenever `sealed` is present. */
export const SEALED_NAME = "🔒";

const MAX_RETAINED = 2000;

export function parseRetained(value: unknown): RetainedSet | null {
  if (!value || typeof value !== "object") return null;
  const ids = (list: unknown) =>
    Array.isArray(list) ? [...new Set(list.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 200))].slice(0, MAX_RETAINED) : [];
  const set = { entryIds: ids((value as RetainedSet).entryIds), folderIds: ids((value as RetainedSet).folderIds) };
  return set.entryIds.length + set.folderIds.length > 0 ? set : null;
}

const entriesOf = (schema: unknown): Entry[] => {
  const list = (schema as Schema | null)?.entries;
  return Array.isArray(list) ? (list as Entry[]) : [];
};
const foldersOf = (schema: unknown): Folder[] => {
  const list = (schema as Schema | null)?.entryFolders;
  return Array.isArray(list) ? (list as Folder[]) : [];
};

/** An opening is shown to every player as the first message, so it cannot be kept. */
const keepable = (entry: Entry) => entry.role !== "greeting";

const foreign = (mark: SealedMark | undefined, viewerId: string | null | undefined): mark is SealedMark =>
  !!mark && typeof mark.by === "string" && mark.by !== viewerId;

/** The author's own card: which entries `retained` covers right now. */
function retainedOnSource(schema: unknown, retained: RetainedSet | null): { entries: Set<string>; folders: Set<string> } {
  const entries = new Set<string>();
  const folders = new Set<string>();
  if (!retained) return { entries, folders };
  const folderIds = new Set(retained.folderIds);
  const entryIds = new Set(retained.entryIds);
  for (const folder of foldersOf(schema)) if (folderIds.has(folder.id)) folders.add(folder.id);
  for (const entry of entriesOf(schema)) {
    if (!keepable(entry)) continue;
    if (entryIds.has(entry.id) || (typeof entry.folderId === "string" && folders.has(entry.folderId))) entries.add(entry.id);
  }
  return { entries, folders };
}

function blank(entry: Entry, mark: SealedMark, view: "play" | "edit"): Entry {
  const out: Entry = {
    ...entry,
    // A character's name is spoken in the story and the chat needs it to find
    // the speaker's portrait, so a player keeps it; an editor never does.
    name: view === "play" && entry.role === "character" && typeof entry.name === "string" ? entry.name : SEALED_NAME,
    content: "",
    keywords: [],
    conditions: [],
    sealed: mark,
  };
  if ("secondaryKeywords" in out) out.secondaryKeywords = [];
  delete out.tags;
  delete out.initialVariables;
  return out;
}

export interface SealedWorldRow {
  id: string;
  creatorId: string | null;
  schema: unknown;
  retained?: unknown;
  /** The viewer works on this card with its creator (an editor collaborator):
   *  the creator's own choice does not hide anything from them. Marks on a
   *  copy still do. */
  team?: boolean;
}

/**
 * The schema to send `viewerId`. Returns the same object when nothing in it is
 * kept from this viewer.
 */
export function redactSchemaFor<S>(row: SealedWorldRow, schema: S, viewerId: string | null | undefined, view: "play" | "edit"): S {
  const entries = entriesOf(schema);
  if (entries.length === 0) return schema;
  const isAuthor = (!!viewerId && viewerId === row.creatorId) || row.team === true;
  const own = isAuthor ? { entries: new Set<string>(), folders: new Set<string>() } : retainedOnSource(schema, parseRetained(row.retained));
  const ownMark: SealedMark = { by: row.creatorId ?? "", from: row.id };

  let touched = false;
  const nextEntries = entries.map((entry) => {
    if (foreign(entry.sealed, viewerId)) { touched = true; return blank(entry, entry.sealed, view); }
    if (own.entries.has(entry.id)) { touched = true; return blank(entry, ownMark, view); }
    return entry;
  });
  const nextFolders = foldersOf(schema).map((folder) => {
    const mark = foreign(folder.sealed, viewerId) ? folder.sealed : own.folders.has(folder.id) ? ownMark : null;
    if (!mark) return folder;
    touched = true;
    return { ...folder, name: SEALED_NAME, sealed: mark };
  });
  if (!touched) return schema;
  return { ...(schema as object), entries: nextEntries, entryFolders: nextFolders } as S;
}

/** Shorthand for a row whose own `schema` is what is being sent. */
export function redactWorldFor<R extends SealedWorldRow>(row: R, viewerId: string | null | undefined, view: "play" | "edit"): R {
  const schema = redactSchemaFor(row, row.schema, viewerId, view);
  return schema === row.schema ? row : { ...row, schema };
}

/**
 * The schema a copy of `source` starts with: what the author kept gets a mark
 * naming them, and marks already on the source (a copy of a copy) stay.
 */
export function sealCopy(schema: Schema, source: { id: string; creatorId: string | null; retained?: unknown }): Schema {
  const kept = retainedOnSource(schema, parseRetained(source.retained));
  if (kept.entries.size === 0 && kept.folders.size === 0) return schema;
  const mark: SealedMark = { by: source.creatorId ?? "", from: source.id };
  return {
    ...schema,
    entries: entriesOf(schema).map((entry) => (kept.entries.has(entry.id) && !entry.sealed ? { ...entry, sealed: mark } : entry)),
    entryFolders: foldersOf(schema).map((folder) => (kept.folders.has(folder.id) && !folder.sealed ? { ...folder, sealed: mark } : folder)),
  };
}

/** Does this schema hold text its owner may not read? */
export function holdsSealedFrom(schema: unknown, ownerId: string | null | undefined): boolean {
  return entriesOf(schema).some((entry) => foreign(entry.sealed, ownerId));
}

/** Where an entry sits is the copy owner's to change; what it says is not. */
const MOVABLE = ["enabled", "position", "folderId", "section", "alwaysSend", "depth", "worldbookId"] as const;

/**
 * A copy's owner saved `incoming` (built from the redacted schema they were
 * sent) over `stored`. Kept entries come back with their real text and
 * settings, moved or switched off if the owner did that, or stay deleted if
 * the owner deleted them.
 */
export function restoreSealed<S>(stored: unknown, incoming: S, ownerId: string): S {
  const keptEntries = new Map(entriesOf(stored).filter((e) => foreign(e.sealed, ownerId)).map((e) => [e.id, e]));
  const keptFolders = new Map(foldersOf(stored).filter((f) => foreign(f.sealed, ownerId)).map((f) => [f.id, f]));
  const incomingEntries = entriesOf(incoming);
  const incomingFolders = foldersOf(incoming);
  const marked = incomingEntries.some((e) => e.sealed) || incomingFolders.some((f) => f.sealed);
  if (keptEntries.size === 0 && keptFolders.size === 0 && !marked) return incoming;

  // A blanked entry that storage no longer holds (deleted, then sent back by
  // an undo or a stale tab) has no text to restore, so it stays deleted. One
  // that arrives with text came from the server's own history and keeps its mark.
  const ghost = (entry: Entry) => foreign(entry.sealed, ownerId) && !keptEntries.has(entry.id) && !entry.content;
  const entries = incomingEntries.filter((entry) => !ghost(entry)).map((entry) => {
    const kept = keptEntries.get(entry.id);
    if (!kept) return entry;
    const out: Entry = { ...kept };
    for (const key of MOVABLE) {
      if (key in entry) out[key] = entry[key];
      else delete out[key];
    }
    return out;
  });
  const folders = incomingFolders.map((folder) => {
    const kept = keptFolders.get(folder.id);
    return kept ? { ...folder, name: kept.name, sealed: kept.sealed } : folder;
  });
  const out = { ...(incoming as object), entries } as Schema;
  if (Array.isArray((incoming as Schema).entryFolders)) out.entryFolders = folders;
  return out as S;
}
