import { useEffect, useRef } from "react";
import { editorClientId, useEditorStore, type EditTarget } from "@/stores/editor";
import { feedback } from "@/lib/feedback";
import i18n from "@/lib/i18n";
import { collabApi, CollabError } from "./collab-api";
import { useCollabStore, type PresenceEvent } from "./collab-store";
import { unsavedText } from "./unsaved-text";

const HEARTBEAT_MS = 20_000;
/** How long "X is editing Y" holds after their last keystroke there. */
export const EDITING_HOLD_MS = 25_000;
/** One heads-up per person and thing in this window. */
const WARN_EVERY_MS = 2 * 60_000;

const tr = (key: string, options: Record<string, unknown>) =>
  (i18n.t as unknown as (k: string, o: Record<string, unknown>) => string)(`editor:${key}`, options);

/**
 * Tell everyone else with this card open that we're here, where, and what
 * we are editing; keep the list of who else is here fresh; and give a
 * heads-up when two people work on the same thing, since the later save of
 * the same field wins. Runs for the card's creator too. A card nobody shared
 * costs one small request per 20s while it is open.
 */
export function useCollabPresence(worldId: string | null) {
  const section = useEditorStore((s) => s.activeSection);
  const peerCount = useCollabStore((s) => Object.keys(s.peers).length);
  const helloVersion = useCollabStore((s) => s.helloVersion);
  const lastSent = useRef(0);
  const editing = useRef<(EditTarget & { at: number }) | null>(null);
  const warned = useRef(new Map<string, number>());

  const focusNow = (): Record<string, string> => {
    const f: Record<string, string> = { section: useEditorStore.getState().activeSection };
    const e = editing.current;
    if (e && Date.now() - e.at < EDITING_HOLD_MS) { f.editing = e.target; f.label = e.label; }
    return f;
  };

  // Join, heartbeat, leave.
  useEffect(() => {
    if (!worldId) return;
    useCollabStore.getState().reset(worldId);
    const send = () => {
      lastSent.current = Date.now();
      void collabApi.presence(worldId, { clientId: editorClientId, focus: focusNow() });
    };
    send();
    const beat = setInterval(send, HEARTBEAT_MS);
    const prune = setInterval(() => useCollabStore.getState().prune(), 10_000);
    const leave = () => { void collabApi.presence(worldId, { clientId: editorClientId, gone: true }, true); };
    window.addEventListener("pagehide", leave);
    return () => {
      clearInterval(beat);
      clearInterval(prune);
      window.removeEventListener("pagehide", leave);
      leave();
      useCollabStore.getState().reset(null);
      editing.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worldId]);

  // Moving to another part of the card, or someone new arriving (so they see
  // us now rather than at our next heartbeat).
  useEffect(() => {
    if (!worldId) return;
    const wait = Math.max(0, 1000 - (Date.now() - lastSent.current));
    const timer = setTimeout(() => {
      lastSent.current = Date.now();
      void collabApi.presence(worldId, { clientId: editorClientId, focus: focusNow() });
    }, wait);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worldId, section, peerCount, helloVersion]);

  // Our live stream just (re)connected: the presence sent before it was open
  // may have been answered while we couldn't hear. Ask again.
  useEffect(() => {
    if (!worldId) return;
    const onOpen = (raw: Event) => {
      if ((raw as CustomEvent<{ worldId: string }>).detail?.worldId !== worldId) return;
      lastSent.current = Date.now();
      void collabApi.presence(worldId, { clientId: editorClientId, focus: focusNow(), hello: true });
    };
    window.addEventListener("yumina:live-open", onOpen);
    return () => window.removeEventListener("yumina:live-open", onOpen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worldId]);

  // What I'm editing: tell the others (at most every 1.5s), and warn when
  // someone else is on the same thing right now.
  useEffect(() => {
    if (!worldId) return;
    let pending: ReturnType<typeof setTimeout> | null = null;
    let clearTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      pending = null;
      lastSent.current = Date.now();
      void collabApi.presence(worldId, { clientId: editorClientId, focus: focusNow() });
    };
    const onLocal = (raw: Event) => {
      const detail = (raw as CustomEvent<EditTarget>).detail;
      if (!detail) return;
      const changedTarget = editing.current?.target !== detail.target;
      editing.current = { ...detail, at: Date.now() };
      if (changedTarget) {
        for (const peer of Object.values(useCollabStore.getState().peers)) {
          if (peer.focus?.editing !== detail.target) continue;
          if (Date.now() - peer.seenAt > EDITING_HOLD_MS) continue;
          const key = `${peer.userId}|${detail.target}`;
          if (Date.now() - (warned.current.get(key) ?? 0) < WARN_EVERY_MS) continue;
          warned.current.set(key, Date.now());
          feedback.notice(tr("collab.alsoEditing", { name: peer.name, label: detail.label }));
        }
      }
      if (changedTarget) flush();
      else if (!pending) pending = setTimeout(flush, 1500);
      // Stop saying "editing" once they've gone quiet.
      if (clearTimer) clearTimeout(clearTimer);
      clearTimer = setTimeout(() => { editing.current = null; flush(); }, EDITING_HOLD_MS);
    };
    // Someone else's save just changed the thing I'm in the middle of.
    const onRemote = (raw: Event) => {
      const detail = (raw as CustomEvent<{ actorUserId: string; targets: string[] }>).detail;
      const mine = editing.current;
      if (!detail || !mine || Date.now() - mine.at > EDITING_HOLD_MS || !detail.targets.includes(mine.target)) return;
      const key = `${detail.actorUserId}|${mine.target}|remote`;
      if (Date.now() - (warned.current.get(key) ?? 0) < WARN_EVERY_MS) return;
      warned.current.set(key, Date.now());
      const who = Object.values(useCollabStore.getState().peers).find((p) => p.userId === detail.actorUserId)?.name
        ?? tr("collab.someone", {});
      feedback.notice(tr("collab.editedYourTarget", { name: who, label: mine.label }));
    };
    window.addEventListener("yumina:local-edit", onLocal);
    window.addEventListener("yumina:remote-edit", onRemote);
    return () => {
      window.removeEventListener("yumina:local-edit", onLocal);
      window.removeEventListener("yumina:remote-edit", onRemote);
      if (pending) clearTimeout(pending);
      if (clearTimer) clearTimeout(clearTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worldId]);
}

/** A presence line from the card's live stream. */
export function receivePresence(event: PresenceEvent) {
  useCollabStore.getState().applyPresence(event, editorClientId);
}

/**
 * Someone's access to the open card changed. When it is ours, re-read what we
 * may do now — or close the card if we were removed.
 */
export async function receiveAccessChange(worldId: string, userId: string, myUserId: string | undefined) {
  useCollabStore.getState().bumpAccess();
  if (!myUserId || (userId !== myUserId && userId !== "*")) return;
  const editor = useEditorStore.getState();
  if (editor.serverWorldId !== worldId || editor.access?.role === "owner") return;
  try {
    const list = await collabApi.list(worldId);
    const me = list.me.role === "owner" ? null : list.me;
    // Moved from editing to viewing: say who did it, since the page just
    // stopped saving under them.
    if (me && me.role === "viewer" && useEditorStore.getState().access?.role === "editor") {
      feedback.notice(tr("collab.downgraded", { name: list.owner?.name ?? tr("collab.someone", {}) }));
    }
    if (me) editor.setAccess({ role: me.role, canPublish: me.canPublish });
  } catch (error) {
    if (error instanceof CollabError && error.status === 404) {
      // Stay on the card's address (so the route doesn't reload it) and stop
      // every save: there is nothing this person may write any more. What
      // they had typed and not saved is kept aside for them to copy.
      const before = useEditorStore.getState();
      useCollabStore.setState({ removedUnsaved: before.isDirty ? unsavedText(before._baseSchema, before.worldDraft) || null : null });
      useEditorStore.getState().stopAutosave();
      useEditorStore.setState({ loadError: "removed", access: null, isDirty: false, layoutDirty: false, loadingWorld: false });
    }
  }
}
