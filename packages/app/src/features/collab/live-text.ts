import * as Y from "yjs";
import { create } from "zustand";
import { mergeText, readTextField, textHunks, writeTextField } from "@yumina/engine";
import { editorClientId, useEditorStore } from "@/stores/editor";
import { setCollaboratorsPresent, setLiveTextProvider } from "@/stores/live-text-registry";
import { FLUSH_PENDING_EDITS_EVENT } from "@/features/editor/components/flush-pending-edits";
import { peoplePresent, useCollabStore } from "./collab-store";

/**
 * Typing together in Studio's text fields, the way Google Docs does it.
 *
 * Each text field someone is in (an entry's content, a frontend file…) is a
 * Yjs document shared through the server (server lib/collab-text): every
 * keystroke is a small update that every open copy merges character by
 * character, so two people typing in one field both keep everything they
 * typed, and see each other's words — and carets — as they go.
 *
 * The draft in the editor store mirrors each live field (written here, a
 * moment after the typing, with no undo step: each person undoes their own
 * typing in the field itself), and the ordinary autosave stores it. Because
 * every copy holds the same text, whichever save lands last is right.
 *
 * A field goes live when someone focuses it, or when someone else starts
 * typing in a field that is on screen here. The server makes the document
 * from the stored text, once; text typed here before it went live is merged
 * in from the last saved version (never pasted twice, never lost).
 */

const apiBase = import.meta.env?.VITE_API_URL || "";
const TEXT = "t";
/** Keystrokes go out at most this often (merged). */
const SEND_EVERY_MS = 50;
/** The draft follows the shared text after this pause. */
const STORE_WRITE_MS = 250;
/** A field nobody here has on screen any more stops being live after this. */
const IDLE_CLOSE_MS = 60_000;
/** Our caret is re-sent this often while it sits still (others drop stale ones). */
const CARET_HEARTBEAT_MS = 10_000;
export const CARET_STALE_MS = 25_000;

/** Transaction origins. */
const LOCAL = { local: true };
const REMOTE = "remote";

type Status = "idle" | "opening" | "live" | "gone";

const toB64 = (u: Uint8Array) => {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (s: string) => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

interface FieldHooks {
  /** Commit text the field holds locally, before it goes live. */
  flush?: () => void;
  /** About to apply someone else's change: remember the selection. */
  beforeRemote?: () => void;
}

class LiveField {
  doc = new Y.Doc();
  text = this.doc.getText(TEXT);
  gen: string | null = null;
  status: Status = "idle";
  mounts = new Set<FieldHooks>();
  listeners = new Set<() => void>();
  outbox: Uint8Array[] = [];
  sending = false;
  sendTimer: ReturnType<typeof setTimeout> | null = null;
  retryMs = 0;
  buffered: Array<{ gen: string; update: Uint8Array }> = [];
  undo: Y.UndoManager | null = null;
  /** What the draft held for this field when we last wrote or read it. */
  lastStore: string | undefined = undefined;
  storeTimer: ReturnType<typeof setTimeout> | null = null;
  storeOrigin: "local" | "remote" = "remote";
  closeTimer: ReturnType<typeof setTimeout> | null = null;
  focused = 0;
  opening: Promise<void> | null = null;

  constructor(public key: string) {
    this.bind();
  }

  bind() {
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE) return;
      this.outbox.push(update);
      scheduleSend(this);
    });
    this.text.observe((event) => {
      const origin = event.transaction.origin;
      if (origin === LOCAL || (origin instanceof Y.UndoManager)) this.storeOrigin = "local";
      scheduleStoreWrite(this);
      for (const l of this.listeners) l();
    });
    this.undo = new Y.UndoManager(this.text, { trackedOrigins: new Set([LOCAL]), captureTimeout: 600 });
  }

  /** Start over on a fresh document (a new generation). */
  replaceDoc() {
    this.undo?.destroy();
    this.doc.destroy();
    this.doc = new Y.Doc();
    this.text = this.doc.getText(TEXT);
    this.outbox = [];
    this.bind();
  }
}

interface Session {
  worldId: string;
  fields: Map<string, LiveField>;
  stop: () => void;
}

let session: Session | null = null;

function canWrite(): boolean {
  const s = useEditorStore.getState();
  return !s.guestMode && !s.readOnlyInspect && s.access?.role !== "viewer";
}

function api(path: string, body: unknown, keepalive = false) {
  return fetch(`${apiBase}/api/world-collab/worlds/${session?.worldId}/text/${path}`, {
    method: "POST",
    credentials: "include",
    keepalive,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── sending ─────────────────────────────────────────────────────────────────

function scheduleSend(f: LiveField) {
  if (f.sendTimer || f.sending) return;
  f.sendTimer = setTimeout(() => { f.sendTimer = null; void send(f); }, f.retryMs || SEND_EVERY_MS);
}

async function send(f: LiveField) {
  const s = session;
  if (!s || f.status !== "live" || !f.gen || f.outbox.length === 0 || f.sending) return;
  if (!canWrite()) { f.outbox = []; return; }
  const update = f.outbox.length === 1 ? f.outbox[0]! : Y.mergeUpdates(f.outbox);
  f.outbox = [];
  f.sending = true;
  let retry = false;
  try {
    const res = await api("update", { field: f.key, gen: f.gen, update: toB64(update), clientId: editorClientId });
    if (res.status === 409) {
      // The server's copy started over (it expired): open it again; what we
      // typed is merged back in from the draft.
      f.outbox = [];
      void reopen(f);
    } else if (res.status === 429 || res.status >= 500) {
      retry = true;
    } else if (!res.ok) {
      f.status = "gone";
      notify(f);
    } else {
      f.retryMs = 0;
    }
  } catch {
    retry = true; // offline: keep it, try again
  } finally {
    f.sending = false;
  }
  if (retry) {
    f.outbox.unshift(update);
    f.retryMs = Math.min(5000, Math.max(200, f.retryMs * 2 || 200));
  }
  if (f.outbox.length) scheduleSend(f);
}

/** Send what is waiting now (the tab is going away). */
function flushOutboxes(keepalive: boolean) {
  const s = session;
  if (!s) return;
  for (const f of s.fields.values()) {
    if (f.sendTimer) { clearTimeout(f.sendTimer); f.sendTimer = null; }
    if (!f.outbox.length || !f.gen || f.status !== "live") continue;
    const update = Y.mergeUpdates(f.outbox);
    f.outbox = [];
    void api("update", { field: f.key, gen: f.gen, update: toB64(update), clientId: editorClientId }, keepalive).catch(() => {
      f.outbox.unshift(update);
    });
  }
}

// ── the draft mirror ────────────────────────────────────────────────────────

function scheduleStoreWrite(f: LiveField) {
  if (f.storeTimer) clearTimeout(f.storeTimer);
  f.storeTimer = setTimeout(() => writeStore(f), STORE_WRITE_MS);
}

function writeStore(f: LiveField) {
  if (f.storeTimer) { clearTimeout(f.storeTimer); f.storeTimer = null; }
  if (f.status !== "live" || !session) return;
  const editor = useEditorStore.getState();
  if (editor.serverWorldId !== session.worldId) return;
  const value = f.text.toString();
  const origin = f.storeOrigin;
  f.storeOrigin = "remote";
  f.lastStore = value;
  if (readTextField(editor.worldDraft, f.key) === value) return;
  editor.applyLiveText(f.key, value, origin);
}

function flushStoreWrites() {
  for (const f of session?.fields.values() ?? []) if (f.storeTimer) writeStore(f);
}

/**
 * The draft changed some other way than through us — undo, an action that
 * rewrites text (renaming a variable's references), the assistant applied
 * here: that change goes into the shared text, merged with whatever arrived
 * meanwhile, so everyone gets it.
 */
function onDraftChanged(next: ReturnType<typeof useEditorStore.getState>, prev: ReturnType<typeof useEditorStore.getState>) {
  const s = session;
  if (!s || next.worldDraft === prev.worldDraft || next.serverWorldId !== s.worldId) return;
  for (const f of s.fields.values()) {
    if (f.status !== "live" || f.lastStore === undefined) continue;
    const value = readTextField(next.worldDraft, f.key);
    if (value === undefined || value === f.lastStore) continue;
    const before = f.lastStore;
    f.lastStore = value;
    if (!canWrite()) continue;
    const current = f.text.toString();
    const target = mergeText(before, value, current);
    if (target !== current) applyText(f, current, target, LOCAL);
    if (target !== value) scheduleStoreWrite(f);
  }
}

function applyText(f: LiveField, current: string, target: string, origin: unknown) {
  const hunks = textHunks(current, target);
  if (!hunks.length) return;
  f.doc.transact(() => {
    for (const h of [...hunks].reverse()) {
      if (h.end > h.start) f.text.delete(h.start, h.end - h.start);
      if (h.insert) f.text.insert(h.start, h.insert);
    }
  }, origin);
}

function notify(f: LiveField) {
  for (const l of f.listeners) l();
}

// ── opening ─────────────────────────────────────────────────────────────────

function fieldFor(key: string): LiveField | null {
  const s = session;
  if (!s) return null;
  let f = s.fields.get(key);
  if (!f) { f = new LiveField(key); s.fields.set(key, f); }
  return f;
}

function activate(f: LiveField): Promise<void> {
  if (f.status === "live" || f.status === "gone") return Promise.resolve();
  if (f.opening) return f.opening;
  f.opening = open(f).finally(() => { f.opening = null; });
  return f.opening;
}

async function open(f: LiveField, resync = false) {
  const s = session;
  if (!s) return;
  const worldId = s.worldId;
  if (!resync) { f.status = "opening"; notify(f); }
  type Opened = { gen: string; update: string; fresh: boolean; sv?: string };
  let data: Opened | null = null;
  try {
    const res = await api("open", resync && f.gen ? { field: f.key, gen: f.gen, sv: toB64(Y.encodeStateVector(f.doc)) } : { field: f.key });
    if (session?.worldId !== worldId) return;
    if (res.status === 404) { f.status = "gone"; notify(f); return; }
    if (!res.ok) throw new Error(String(res.status));
    data = ((await res.json()) as { data: Opened }).data;
  } catch {
    if (!resync) { f.status = "idle"; notify(f); }
    return;
  }
  if (!data || session?.worldId !== worldId) return;
  const update = fromB64(data.update);
  if (resync && f.gen === data.gen && !data.fresh) {
    // Caught up: what we missed comes in, what they missed goes out.
    for (const m of f.mounts) m.beforeRemote?.();
    Y.applyUpdate(f.doc, update, REMOTE);
    if (data.sv && canWrite()) {
      const mine = Y.encodeStateAsUpdate(f.doc, fromB64(data.sv));
      // An empty update is two bytes (no structs, no deletes).
      if (mine.length > 2) { f.outbox.push(mine); scheduleSend(f); }
    }
    return;
  }
  // A new document (or the first): what this tab had — typed before it was
  // live, or kept from an expired copy — is merged in from the last save.
  for (const m of f.mounts) m.flush?.();
  const editor = useEditorStore.getState();
  const local = readTextField(editor.worldDraft, f.key);
  const base = readTextField(editor._baseSchema, f.key) ?? local;
  if (f.gen) f.replaceDoc();
  for (const m of f.mounts) m.beforeRemote?.();
  Y.applyUpdate(f.doc, update, REMOTE);
  f.gen = data.gen;
  for (const b of f.buffered.splice(0)) if (b.gen === f.gen) Y.applyUpdate(f.doc, b.update, REMOTE);
  const shared = f.text.toString();
  f.status = "live";
  f.lastStore = readTextField(editor.worldDraft, f.key);
  if (local !== undefined && local !== shared && canWrite()) {
    applyText(f, shared, mergeText(base ?? shared, local, shared), LOCAL);
    f.undo?.clear();
  }
  f.storeOrigin = "remote";
  writeStore(f);
  notify(f);
}

/** The shared copy started over (expired, or we fell out of step): put what
 *  we have in the draft, and open the new one like the first time. */
function reopen(f: LiveField) {
  if (f.opening) return f.opening;
  if (f.status === "live") writeStore(f);
  f.status = "opening";
  notify(f);
  f.opening = open(f).finally(() => { f.opening = null; });
  return f.opening;
}

/** After the live stream comes back: catch every live field up. */
export function resyncLiveText() {
  for (const f of session?.fields.values() ?? []) if (f.status === "live") void open(f, true);
}

function closeIfIdle(f: LiveField) {
  if (f.closeTimer) clearTimeout(f.closeTimer);
  f.closeTimer = setTimeout(() => {
    f.closeTimer = null;
    if (f.mounts.size > 0 || f.focused > 0 || !session) return;
    if (f.outbox.length) { scheduleSend(f); closeIfIdle(f); return; }
    if (f.storeTimer) writeStore(f);
    f.undo?.destroy();
    f.doc.destroy();
    session.fields.delete(f.key);
  }, IDLE_CLOSE_MS);
}

// ── incoming ────────────────────────────────────────────────────────────────

export interface TextEvent { field: string; gen: string; update: string; clientId: string | null; userId: string }

export function receiveText(event: TextEvent) {
  const s = session;
  if (!s || !event || typeof event.field !== "string" || typeof event.update !== "string") return;
  if (event.clientId && event.clientId === editorClientId) return;
  const f = s.fields.get(event.field);
  // A field nobody has on screen here: its saves bring the text.
  if (!f) return;
  let update: Uint8Array;
  try { update = fromB64(event.update); } catch { return; }
  if (f.status === "live") {
    if (event.gen !== f.gen) { void reopen(f); return; }
    for (const m of f.mounts) m.beforeRemote?.();
    Y.applyUpdate(f.doc, update, REMOTE);
    return;
  }
  if (f.status === "opening") { f.buffered.push({ gen: event.gen, update }); return; }
  // On screen and someone started typing in it: go live to watch.
  if (f.status === "idle" && f.mounts.size > 0) void activate(f);
}

// ── carets ──────────────────────────────────────────────────────────────────

export interface RemoteCaret {
  clientId: string;
  userId: string;
  name: string;
  field: string;
  anchor?: string;
  head?: string;
  at: number;
}

interface CaretState {
  carets: Record<string, RemoteCaret>;
  receive: (event: { clientId: string; userId: string; name: string; field: string | null; anchor?: string; head?: string }) => void;
  drop: (clientId: string) => void;
  prune: () => void;
  reset: () => void;
}

export const useLiveCaretStore = create<CaretState>((set) => ({
  carets: {},
  receive: (event) => set((s) => {
    if (!event?.clientId || event.clientId === editorClientId) return {};
    if (event.field === null) {
      if (!s.carets[event.clientId]) return {};
      const { [event.clientId]: _gone, ...rest } = s.carets;
      return { carets: rest };
    }
    return { carets: { ...s.carets, [event.clientId]: { clientId: event.clientId, userId: event.userId, name: event.name, field: event.field, anchor: event.anchor, head: event.head, at: Date.now() } } };
  }),
  drop: (clientId) => set((s) => {
    if (!s.carets[clientId]) return {};
    const { [clientId]: _gone, ...rest } = s.carets;
    return { carets: rest };
  }),
  prune: () => set((s) => {
    const cutoff = Date.now() - CARET_STALE_MS;
    const live = Object.fromEntries(Object.entries(s.carets).filter(([, c]) => c.at >= cutoff));
    return Object.keys(live).length === Object.keys(s.carets).length ? {} : { carets: live };
  }),
  reset: () => set({ carets: {} }),
}));

export function receiveCaret(event: Parameters<CaretState["receive"]>[0]) {
  useLiveCaretStore.getState().receive(event);
  // Someone's caret is in a field on screen here: go live to see them type.
  if (event?.field && event.clientId !== editorClientId) {
    const f = session?.fields.get(event.field);
    if (f && f.status === "idle" && f.mounts.size > 0) void activate(f);
  }
}

let caretTimer: ReturnType<typeof setTimeout> | null = null;
let caretPending: { field: string | null; anchor?: string; head?: string } | null = null;
let caretLastSent = 0;
let caretHeartbeat: ReturnType<typeof setInterval> | null = null;
let caretCurrent: { field: string | null; anchor?: string; head?: string } | null = null;

function sendCaretNow() {
  caretTimer = null;
  const body = caretPending;
  caretPending = null;
  if (!body || !session) return;
  caretLastSent = Date.now();
  void api("caret", { clientId: editorClientId, ...body }).catch(() => undefined);
}

function queueCaret(body: { field: string | null; anchor?: string; head?: string }) {
  caretPending = body;
  caretCurrent = body.field ? body : null;
  if (body.field === null) { if (caretTimer) clearTimeout(caretTimer); sendCaretNow(); return; }
  if (caretTimer) return;
  caretTimer = setTimeout(sendCaretNow, Math.max(0, 100 - (Date.now() - caretLastSent)));
}

/** A position in the field's text as a Yjs relative position (base64). */
function relPos(f: LiveField, index: number): string {
  return toB64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(f.text, Math.max(0, Math.min(index, f.text.length)))));
}

/** A relative position (base64) as an index in the field's current text. */
export function absPos(key: string, encoded: string | undefined): number | null {
  const f = session?.fields.get(key);
  if (!f || f.status !== "live" || !encoded) return null;
  try {
    const abs = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(fromB64(encoded)), f.doc);
    return abs && abs.type === f.text ? abs.index : null;
  } catch {
    return null;
  }
}

// ── the field binding ───────────────────────────────────────────────────────

export interface LiveTextHandle {
  key: string;
  /** Live: the field shows and edits the shared text. */
  live(): boolean;
  text(): string;
  /** The person is in the field: make it live. */
  focus(): void;
  blur(): void;
  /** Local typing: `shadow` is what the field showed, `next` what it shows now. */
  edit(shadow: string, next: string): void;
  undo(): boolean;
  redo(): boolean;
  caret(anchor: number, head: number): void;
  /** Selection as relative positions, to put back after someone else's change. */
  saveSelection(anchor: number, head: number): [Y.RelativePosition, Y.RelativePosition] | null;
  restoreSelection(saved: [Y.RelativePosition, Y.RelativePosition]): [number, number] | null;
  subscribe(listener: () => void): () => void;
  release(): void;
}

/** Bind a mounted field to `key`. Null when nothing is live in this editor. */
export function attachLiveText(key: string, hooks: FieldHooks): LiveTextHandle | null {
  const f = fieldFor(key);
  if (!f) return null;
  f.mounts.add(hooks);
  if (f.closeTimer) { clearTimeout(f.closeTimer); f.closeTimer = null; }
  let released = false;
  let inField = false;
  const handle: LiveTextHandle = {
    key,
    live: () => f.status === "live",
    text: () => f.text.toString(),
    focus: () => {
      if (!inField) { inField = true; f.focused++; }
      void activate(f);
    },
    blur: () => {
      if (inField) { inField = false; f.focused = Math.max(0, f.focused - 1); }
      if (f.storeTimer) writeStore(f);
      if (caretCurrent?.field === key) queueCaret({ field: null });
    },
    edit: (shadow, next) => {
      if (f.status !== "live" || !canWrite()) return;
      const current = f.text.toString();
      const target = shadow === current ? next : mergeText(shadow, next, current);
      applyText(f, current, target, LOCAL);
    },
    undo: () => {
      if (f.status !== "live" || !f.undo || !canWrite()) return false;
      return f.undo.undo() !== null;
    },
    redo: () => {
      if (f.status !== "live" || !f.undo || !canWrite()) return false;
      return f.undo.redo() !== null;
    },
    caret: (anchor, head) => {
      if (f.status !== "live") return;
      queueCaret({ field: key, anchor: relPos(f, anchor), head: relPos(f, head) });
    },
    saveSelection: (anchor, head) => {
      if (f.status !== "live") return null;
      return [
        Y.createRelativePositionFromTypeIndex(f.text, Math.min(anchor, f.text.length)),
        Y.createRelativePositionFromTypeIndex(f.text, Math.min(head, f.text.length)),
      ];
    },
    restoreSelection: ([a, h]) => {
      const pa = Y.createAbsolutePositionFromRelativePosition(a, f.doc);
      const ph = Y.createAbsolutePositionFromRelativePosition(h, f.doc);
      return pa && ph ? [pa.index, ph.index] : null;
    },
    subscribe: (listener) => {
      f.listeners.add(listener);
      return () => { f.listeners.delete(listener); };
    },
    release: () => {
      if (released) return;
      released = true;
      handle.blur();
      f.mounts.delete(hooks);
      if (f.mounts.size === 0) closeIfIdle(f);
    },
  };
  return handle;
}

export function liveTextActive(): boolean {
  return !!session;
}

// ── the session ─────────────────────────────────────────────────────────────

/**
 * Start live text for the open card (the editor's live stream calls this).
 * Returns the stop function.
 */
export function startLiveText(worldId: string): () => void {
  if (session?.worldId === worldId) return session.stop;
  session?.stop();
  const fields = new Map<string, LiveField>();
  const unsubscribeStore = useEditorStore.subscribe(onDraftChanged);
  const unsubscribePeers = useCollabStore.subscribe((s) => setCollaboratorsPresent(peoplePresent(s.peers).length > 0));
  setCollaboratorsPresent(peoplePresent(useCollabStore.getState().peers).length > 0);
  const onFlush = () => flushStoreWrites();
  const onHide = () => { flushStoreWrites(); flushOutboxes(true); };
  const onOnline = () => resyncLiveText();
  window.addEventListener(FLUSH_PENDING_EDITS_EVENT, onFlush);
  window.addEventListener("pagehide", onHide);
  window.addEventListener("online", onOnline);
  const onVisibility = () => { if (document.visibilityState === "hidden") onHide(); };
  document.addEventListener("visibilitychange", onVisibility);
  const prune = setInterval(() => useLiveCaretStore.getState().prune(), 5000);
  caretHeartbeat = setInterval(() => {
    if (caretCurrent && Date.now() - caretLastSent > CARET_HEARTBEAT_MS) queueCaret(caretCurrent);
  }, 3000);
  setLiveTextProvider({
    overlay: (world) => {
      let out = world;
      for (const f of fields.values()) {
        if (f.status !== "live") continue;
        const value = f.text.toString();
        const next = writeTextField(out, f.key, value);
        if (next !== out || readTextField(out, f.key) === value) f.lastStore = value;
        out = next;
      }
      return out;
    },
    keys: () => [...fields.values()].filter((f) => f.status === "live").map((f) => f.key),
  });
  const stop = () => {
    if (session?.worldId !== worldId) return;
    flushStoreWrites();
    flushOutboxes(false);
    if (caretCurrent) queueCaret({ field: null });
    unsubscribeStore();
    unsubscribePeers();
    setCollaboratorsPresent(false);
    setLiveTextProvider(null);
    window.removeEventListener(FLUSH_PENDING_EDITS_EVENT, onFlush);
    window.removeEventListener("pagehide", onHide);
    window.removeEventListener("online", onOnline);
    document.removeEventListener("visibilitychange", onVisibility);
    clearInterval(prune);
    if (caretHeartbeat) clearInterval(caretHeartbeat);
    caretHeartbeat = null;
    caretCurrent = null;
    for (const f of fields.values()) {
      if (f.sendTimer) clearTimeout(f.sendTimer);
      if (f.storeTimer) clearTimeout(f.storeTimer);
      if (f.closeTimer) clearTimeout(f.closeTimer);
      f.undo?.destroy();
      f.doc.destroy();
      f.status = "gone";
      notify(f);
    }
    fields.clear();
    useLiveCaretStore.getState().reset();
    session = null;
  };
  session = { worldId, fields, stop };
  return stop;
}

/** Hear when a live field's text changes (carets are drawn against it). */
export function subscribeLiveText(key: string, listener: () => void): () => void {
  const f = session?.fields.get(key);
  if (!f) return () => undefined;
  f.listeners.add(listener);
  return () => { f.listeners.delete(listener); };
}
