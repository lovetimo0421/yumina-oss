import { randomUUID } from "node:crypto";
import { redis, redisSub } from "./redis.js";

/**
 * Changes to a card made from outside the open editor — an AI working
 * through a world access token — pushed to every Studio tab that has the card
 * open, so the creator watches it happen (the board reloads, a notice says
 * who changed what) instead of finding it later.
 *
 * Production runs several replicas: the AI's request and the creator's open
 * tab often land on different ones. Each event is delivered locally and
 * published on Redis; other replicas deliver what they hear, and a replica
 * skips its own echo. Without Redis (dev) it stays in-process. The write is
 * safe either way — the editor's save 3-way merges a newer server copy — only
 * the live refresh depends on this.
 */

export type WorldEvent = ExternalWriteEvent | WorldSavedEvent | AccessChangedEvent | PresenceEvent | CursorEvent | TextUpdateEvent | TextCaretEvent;

/** Typing in a shared text field: one Yjs update (see lib/collab-text). */
export interface TextUpdateEvent {
  kind: "text";
  /** The field's key (engine textFieldKey). */
  field: string;
  /** The document generation the update belongs to. */
  gen: string;
  /** The update, base64. */
  update: string;
  /** The editor tab that typed it (it skips its own echo); null for a server write. */
  clientId: string | null;
  userId: string;
  at: string;
}

/** Where someone's caret and selection are in a shared text field, as Yjs
 *  relative positions (base64), or field null when they left it. Never stored. */
export interface TextCaretEvent {
  kind: "caret";
  userId: string;
  name: string;
  clientId: string;
  field: string | null;
  anchor?: string;
  head?: string;
  at: string;
}

/** Someone's pointer on the board, what they selected, and their view —
 *  several times a second while they move. Never stored. */
export interface CursorEvent {
  kind: "cursor";
  userId: string;
  name: string;
  clientId: string;
  x?: number;
  y?: number;
  out?: boolean;
  sel?: string | null;
  view?: { x: number; y: number; zoom: number };
  at: string;
}

/** Someone has the card open (sent every ~20s while they do), or closed it. */
export interface PresenceEvent {
  kind: "presence";
  userId: string;
  name: string;
  image: string | null;
  /** Their editor tab — one person can have several open. */
  clientId: string;
  /** Where they are, e.g. { section: "entries", label: "Alice" }. */
  focus: Record<string, string> | null;
  gone: boolean;
  /** Just connected: everyone else answers with their own presence. */
  hello?: boolean;
  at: string;
}

/** Someone's access to the card changed (invited, re-roled, removed, left).
 *  Their open editor re-reads its access; a removed person's stream closes. */
export interface AccessChangedEvent {
  kind: "access-changed";
  userId: string;
  at: string;
}

/**
 * The stored world moved. Every open editor of the card hears it — another
 * tab, another device, a collaborator — and either applies `changes` (when
 * its copy is at `previousUpdatedAt`) or pulls the server copy and merges.
 */
export interface WorldSavedEvent {
  kind: "saved";
  updatedAt: string;
  /** The save token the change was applied on top of, when known. */
  previousUpdatedAt: string | null;
  /** The editor tab that made it; that tab ignores its own echo. */
  clientId: string | null;
  actorUserId: string;
  /** The change set, when it was a change-set save small enough to send. */
  changes?: unknown[];
  /** Card fields kept outside the schema that this save set (tags, gallery…). */
  meta?: Record<string, unknown>;
}

/** The card fields a `saved` event carries in `meta`. Name and description
 *  live in the schema too and travel with its change set. */
export const WORLD_SAVED_META_KEYS = ["tags", "galleryImages", "announcement", "approxTime", "variantLabel", "language"] as const;

/** Larger change sets are left out of the event; listeners refetch instead. */
export const MAX_EVENT_CHANGES_BYTES = 200_000;

export interface ExternalWriteEvent {
  kind: "external-write";
  /** Who did it: the token's name, e.g. "Claude Code". */
  actor: string;
  tool: string;
  /** The tool's arguments, trimmed — the editor finds the row it touched. */
  args: Record<string, unknown>;
  ok: boolean;
  at: string;
}

type Listener = (event: WorldEvent) => void;
const listeners = new Map<string, Set<Listener>>();
/** Hear every card's events on this replica, local and remote alike. */
type AnyListener = (worldId: string, event: WorldEvent) => void;
const anyListeners = new Set<AnyListener>();

const WORLD_EVENTS_CHANNEL = "world:events";
const REPLICA_ID = randomUUID();

function deliver(worldId: string, event: WorldEvent): void {
  for (const listener of anyListeners) {
    try { listener(worldId, event); } catch { /* bookkeeping only */ }
  }
  for (const listener of listeners.get(worldId) ?? []) {
    try { listener(event); } catch { /* one tab's failure is not the writer's */ }
  }
}

if (redisSub) {
  const sub = redisSub;
  const subscribe = () => { sub.subscribe(WORLD_EVENTS_CHANNEL).catch(() => { /* retried on reconnect */ }); };
  sub.on("ready", subscribe);
  if ((sub as { status?: string }).status === "ready") subscribe();
  sub.on("message", (channel: string, message: string) => {
    if (channel !== WORLD_EVENTS_CHANNEL) return;
    try {
      const { from, worldId, event } = JSON.parse(message) as { from: string; worldId: string; event: WorldEvent };
      if (from !== REPLICA_ID && (listeners.has(worldId) || (anyListeners.size > 0 && event.kind === "access-changed"))) deliver(worldId, event);
    } catch { /* malformed message */ }
  });
}

export function subscribeWorldEvents(worldId: string, listener: Listener): () => void {
  let set = listeners.get(worldId);
  if (!set) { set = new Set(); listeners.set(worldId, set); }
  set.add(listener);
  // Idempotent, and only ever empties its own set: the live stream calls
  // this twice (on abort, and when its loop ends up to 25s later), and that
  // second call used to delete the card's NEW listener set — everyone still
  // on the card stopped hearing saves, typing and presence.
  return () => {
    if (!set!.delete(listener)) return;
    if (set!.size === 0 && listeners.get(worldId) === set) listeners.delete(worldId);
  };
}

/** Server-side bookkeeping that must follow every card's events on every
 *  replica (e.g. forgetting cached access when it changes). */
export function onWorldEvent(listener: AnyListener): () => void {
  anyListeners.add(listener);
  return () => { anyListeners.delete(listener); };
}

export function publishWorldEvent(worldId: string, event: WorldEvent): void {
  deliver(worldId, event);
  if (redis) {
    redis.publish(WORLD_EVENTS_CHANNEL, JSON.stringify({ from: REPLICA_ID, worldId, event })).catch(() => { /* live refresh only */ });
  }
}
