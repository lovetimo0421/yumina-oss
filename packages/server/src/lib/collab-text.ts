import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { sql } from "drizzle-orm";
import { mergeText, parseTextFieldKey, readTextField, textHunks, type TextFieldRef } from "@yumina/engine";
import { db } from "../db/index.js";
import { redis } from "./redis.js";
import { publishWorldEvent } from "./world-events.js";

/**
 * Live text for Studio fields people type into together (an entry's
 * content, a frontend file…), Google Docs style: each open field is one
 * shared Yjs document, and every keystroke travels as a small update that
 * every open copy merges character by character. The server only relays and
 * keeps the updates; the editor's autosave still writes the merged text to
 * the card like any other edit.
 *
 * A field's document lives in Redis (several replicas serve one card) as a
 * list of updates that expires an hour after the last one; without Redis
 * (dev) it lives in memory. It is created ONCE, here, from the field's
 * stored text — never by a client — so two people opening it at the same
 * moment can't both insert the starting text. Every document carries a
 * generation id: one that expired and was made again is a different
 * document, and an editor still holding the old one starts over instead of
 * sending updates that refer to text the new one never had.
 *
 * Writers that don't type into the shared document — the assistant, an
 * outside AI, a restored version, an editor without the field open — change
 * the stored text; injectServerTextWrite folds that change into the live
 * document so the people typing see it arrive and don't type over it.
 */

export const TEXT_TTL_SECONDS = 60 * 60;
/** Updates kept one by one before they are squashed into one. */
const COMPACT_AT = 150;
/** One update (a large paste is the most there is). */
export const MAX_TEXT_UPDATE_BYTES = 512 * 1024;
/** A field's text, as the shared document will hold it. */
export const MAX_TEXT_FIELD_CHARS = 2_000_000;

const listKey = (worldId: string, field: string) => `ytext:${worldId}:${field}`;
const genKey = (worldId: string, field: string) => `ytext:${worldId}:${field}:gen`;
const fieldsKey = (worldId: string) => `ytext:${worldId}:fields`;
const lockKey = (worldId: string, field: string) => `ytext:${worldId}:${field}:compact`;

export interface TextDoc {
  gen: string;
  /** Every update so far, base64. */
  updates: string[];
}

/** Where the documents live: Redis in production, this process in dev and tests. */
interface TextStore {
  /** The document, made from `init` (base64 update) under `gen` when there is none. */
  open(worldId: string, field: string, gen: string, init: string): Promise<TextDoc>;
  /** Append to the document `gen` names; null when that document is gone. */
  append(worldId: string, field: string, gen: string, update: string): Promise<number | null>;
  read(worldId: string, field: string): Promise<TextDoc | null>;
  /** Replace the first `count` updates with `merged`. */
  compact(worldId: string, field: string, gen: string, count: number, merged: string): Promise<void>;
  /** Fields of this card with a live document. */
  fields(worldId: string): Promise<string[]>;
}

const OPEN_LUA = `
local gen = redis.call('GET', KEYS[2])
if (not gen) or redis.call('EXISTS', KEYS[1]) == 0 then
  gen = ARGV[1]
  redis.call('DEL', KEYS[1])
  redis.call('RPUSH', KEYS[1], ARGV[2])
  redis.call('SET', KEYS[2], gen)
end
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('EXPIRE', KEYS[2], ARGV[3])
redis.call('SADD', KEYS[3], ARGV[4])
redis.call('EXPIRE', KEYS[3], ARGV[3])
local out = redis.call('LRANGE', KEYS[1], 0, -1)
table.insert(out, 1, gen)
return out`;

const APPEND_LUA = `
if redis.call('GET', KEYS[2]) ~= ARGV[1] or redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
local n = redis.call('RPUSH', KEYS[1], ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('EXPIRE', KEYS[2], ARGV[3])
redis.call('EXPIRE', KEYS[3], ARGV[3])
return n`;

const COMPACT_LUA = `
if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 0 end
redis.call('LTRIM', KEYS[1], tonumber(ARGV[2]), -1)
redis.call('LPUSH', KEYS[1], ARGV[3])
return 1`;

function redisStore(client: NonNullable<typeof redis>): TextStore {
  return {
    async open(worldId, field, gen, init) {
      const out = await client.eval(OPEN_LUA, 3, listKey(worldId, field), genKey(worldId, field), fieldsKey(worldId),
        gen, init, TEXT_TTL_SECONDS, field) as string[];
      return { gen: out[0]!, updates: out.slice(1) };
    },
    async append(worldId, field, gen, update) {
      const n = await client.eval(APPEND_LUA, 3, listKey(worldId, field), genKey(worldId, field), fieldsKey(worldId),
        gen, update, TEXT_TTL_SECONDS) as number;
      return n < 0 ? null : n;
    },
    async read(worldId, field) {
      const [gen, updates] = await Promise.all([client.get(genKey(worldId, field)), client.lrange(listKey(worldId, field), 0, -1)]);
      return gen && updates.length ? { gen, updates } : null;
    },
    async compact(worldId, field, gen, count, merged) {
      // One squash at a time per field: two would each trim the other's work.
      const token = randomUUID();
      const locked = await client.set(lockKey(worldId, field), token, "PX", 10_000, "NX");
      if (!locked) return;
      try {
        await client.eval(COMPACT_LUA, 2, listKey(worldId, field), genKey(worldId, field), gen, count, merged);
      } finally {
        await client.eval(`if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`, 1, lockKey(worldId, field), token).catch(() => {});
      }
    },
    async fields(worldId) {
      return client.smembers(fieldsKey(worldId));
    },
  };
}

function memoryStore(): TextStore {
  const docs = new Map<string, TextDoc & { expires: number }>();
  const live = (worldId: string, field: string) => {
    const doc = docs.get(listKey(worldId, field));
    if (doc && doc.expires < Date.now()) { docs.delete(listKey(worldId, field)); return undefined; }
    return doc;
  };
  return {
    async open(worldId, field, gen, init) {
      let doc = live(worldId, field);
      if (!doc) {
        doc = { gen, updates: [init], expires: 0 };
        docs.set(listKey(worldId, field), doc);
      }
      doc.expires = Date.now() + TEXT_TTL_SECONDS * 1000;
      return { gen: doc.gen, updates: [...doc.updates] };
    },
    async append(worldId, field, gen, update) {
      const doc = live(worldId, field);
      if (!doc || doc.gen !== gen) return null;
      doc.updates.push(update);
      doc.expires = Date.now() + TEXT_TTL_SECONDS * 1000;
      return doc.updates.length;
    },
    async read(worldId, field) {
      const doc = live(worldId, field);
      return doc ? { gen: doc.gen, updates: [...doc.updates] } : null;
    },
    async compact(worldId, field, gen, count, merged) {
      const doc = live(worldId, field);
      if (!doc || doc.gen !== gen) return;
      doc.updates = [merged, ...doc.updates.slice(count)];
    },
    async fields(worldId) {
      const prefix = `ytext:${worldId}:`;
      return [...docs.keys()].filter((k) => k.startsWith(prefix) && live(worldId, k.slice(prefix.length))).map((k) => k.slice(prefix.length));
    },
  };
}

let store: TextStore = redis ? redisStore(redis) : memoryStore();

/** Tests: run against a fresh in-memory store. */
export function useMemoryTextStoreForTests(): void {
  store = memoryStore();
}

const toB64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const fromB64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

/** The document's text type. One per document, always this name. */
export const TEXT_NAME = "t";

export function mergedUpdate(doc: TextDoc): Uint8Array {
  return doc.updates.length === 1 ? fromB64(doc.updates[0]!) : Y.mergeUpdates(doc.updates.map(fromB64));
}

export function textOf(update: Uint8Array): string {
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, update);
  const text = ydoc.getText(TEXT_NAME).toString();
  ydoc.destroy();
  return text;
}

/** A first update that makes a document holding `text`. */
export function initialUpdate(text: string): Uint8Array {
  const ydoc = new Y.Doc();
  ydoc.getText(TEXT_NAME).insert(0, text);
  const update = Y.encodeStateAsUpdate(ydoc);
  ydoc.destroy();
  return update;
}

/**
 * The field's text as the card's working copy stores it (the held edit of a
 * published card, else the card), read straight out of the stored JSON so a
 * multi-MB card isn't loaded to open one field. undefined: no such field
 * (its row or file is gone, or the card is).
 */
export async function readStoredText(worldId: string, ref: TextFieldRef): Promise<string | undefined> {
  const pick = (col: ReturnType<typeof sql.raw>) => {
    switch (ref.kind) {
      case "row":
        // Collection and field names were checked against /^[A-Za-z]\w*$/ when the key was parsed.
        return sql`(SELECT CASE WHEN r IS NULL THEN NULL ELSE jsonb_build_object('v', r->${ref.field}) END
          FROM jsonb_path_query_first(${col}, ${sql.raw(`'$.${ref.key}[*] ? (@.id == $id)'`)}, jsonb_build_object('id', ${ref.id}::text)) AS r)`;
      case "file":
        return sql`(CASE WHEN ${col}->'rootComponent'->'files' ? ${ref.name} THEN jsonb_build_object('v', ${col}->'rootComponent'->'files'->${ref.name}) END)`;
      case "top":
        return sql`jsonb_build_object('v', ${col}->${ref.field})`;
    }
  };
  const result = await db.execute(sql`
    SELECT w.status, w.description,
      ${pick(sql.raw("w.schema"))} AS live,
      ${pick(sql.raw("pe.schema"))} AS held,
      pe.world_id IS NOT NULL AS has_held,
      pe.metadata->>'description' AS held_description
    FROM worlds w LEFT JOIN world_pending_edits pe ON pe.world_id = w.id
    WHERE w.id = ${worldId} LIMIT 1`);
  const row = result.rows[0] as { status: string | null; description: string | null; live: { v?: unknown } | null; held: { v?: unknown } | null; has_held: boolean; held_description: string | null } | undefined;
  if (!row) return undefined;
  const fromHeld = row.status === "published" && row.has_held;
  const found = fromHeld ? row.held : row.live;
  if (!found) return undefined;
  const value = found.v;
  if (typeof value === "string" && value) return value;
  // The card's description also lives on the card row (the editor falls back to it).
  if (ref.kind === "top" && ref.field === "description") return (fromHeld ? row.held_description : null) ?? row.description ?? "";
  return typeof value === "string" ? value : value === undefined || value === null ? "" : undefined;
}

export class TextFieldGone extends Error {}

/**
 * The field's live document, made from its stored text when nobody has it
 * open. Returns the whole document, or with `since` (a state vector of a copy
 * of the same generation) only what that copy is missing.
 */
export async function openTextDoc(worldId: string, field: string, since?: { gen: string; sv: Uint8Array }): Promise<{ gen: string; update: Uint8Array; fresh: boolean; sv: Uint8Array }> {
  const ref = parseTextFieldKey(field);
  if (!ref) throw new TextFieldGone("bad field");
  let doc = await store.read(worldId, field);
  if (!doc) {
    const stored = await readStoredText(worldId, ref);
    if (stored === undefined) throw new TextFieldGone("no such field");
    if (stored.length > MAX_TEXT_FIELD_CHARS) throw new TextFieldGone("too long");
    doc = await store.open(worldId, field, randomUUID(), toB64(initialUpdate(stored)));
  } else {
    // Touch: an open document stays alive while someone has it open.
    doc = await store.open(worldId, field, doc.gen, doc.updates[0]!);
  }
  const fresh = !since || since.gen !== doc.gen;
  const whole = mergedUpdate(doc);
  // The document's state vector too: a copy catching up sends back exactly
  // what the server is missing.
  return { gen: doc.gen, update: fresh ? whole : Y.diffUpdate(whole, since.sv), fresh, sv: Y.encodeStateVectorFromUpdate(whole) };
}

/** Append an update to the document `gen` names. False: that document is gone (start over). */
export async function appendTextUpdate(worldId: string, field: string, gen: string, update: Uint8Array): Promise<boolean> {
  const n = await store.append(worldId, field, gen, toB64(update));
  if (n === null) return false;
  if (n >= COMPACT_AT) void compactTextDoc(worldId, field).catch(() => { /* next append tries again */ });
  return true;
}

async function compactTextDoc(worldId: string, field: string): Promise<void> {
  const doc = await store.read(worldId, field);
  if (!doc || doc.updates.length < COMPACT_AT) return;
  await store.compact(worldId, field, doc.gen, doc.updates.length, toB64(mergedUpdate(doc)));
}

/** Tell everyone with the card open about an update to one of its fields. */
export function broadcastTextUpdate(worldId: string, args: { field: string; gen: string; update: Uint8Array; clientId: string | null; userId: string }) {
  publishWorldEvent(worldId, {
    kind: "text", field: args.field, gen: args.gen, update: toB64(args.update),
    clientId: args.clientId, userId: args.userId, at: new Date().toISOString(),
  });
}

/**
 * Fold a write made outside the shared documents into the ones that are
 * open: for every live field whose stored text this write changed, the
 * change (before → after) is merged into the document's current text and
 * sent to everyone typing there as an ordinary update. Fields in `skip` were
 * written by an editor that has them open (its text already is the
 * document's). Best effort: a failure here leaves the write itself intact.
 */
export async function injectServerTextWrite(
  worldId: string,
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  options: { actorUserId: string; skip?: ReadonlySet<string> },
): Promise<string[]> {
  if (!before || !after) return [];
  let fields: string[];
  try { fields = await store.fields(worldId); } catch { return []; }
  const changed: string[] = [];
  for (const field of fields) {
    if (options.skip?.has(field)) continue;
    const was = readTextField(before, field);
    const now = readTextField(after, field);
    if (was === undefined || now === undefined || was === now) continue;
    try {
      const doc = await store.read(worldId, field);
      if (!doc) continue;
      const ydoc = new Y.Doc();
      Y.applyUpdate(ydoc, mergedUpdate(doc));
      const ytext = ydoc.getText(TEXT_NAME);
      const current = ytext.toString();
      const target = mergeText(was, now, current);
      if (target === current) { ydoc.destroy(); continue; }
      const out: { update: Uint8Array | null } = { update: null };
      ydoc.on("update", (u: Uint8Array) => { out.update = out.update ? Y.mergeUpdates([out.update, u]) : u; });
      ydoc.transact(() => {
        for (const h of textHunks(current, target).reverse()) {
          if (h.end > h.start) ytext.delete(h.start, h.end - h.start);
          if (h.insert) ytext.insert(h.start, h.insert);
        }
      });
      ydoc.destroy();
      const update = out.update;
      if (!update) continue;
      if (!(await appendTextUpdate(worldId, field, doc.gen, update))) continue;
      broadcastTextUpdate(worldId, { field, gen: doc.gen, update, clientId: null, userId: options.actorUserId });
      changed.push(field);
    } catch (error) {
      console.warn("[collab-text] could not fold a write into", field, error instanceof Error ? error.message : error);
    }
  }
  return changed;
}
