import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { editorClientId, useEditorStore, type RemoteSaveEvent } from "@/stores/editor";
import { useSession } from "@/lib/auth-client";
import { receiveAccessChange, receivePresence } from "@/features/collab/use-collab-presence";
import { useCollabStore } from "@/features/collab/collab-store";
import { receiveCaret, receiveText, resyncLiveText, startLiveText } from "@/features/collab/live-text";
import { showAiPresence } from "./agent-job";
import { presenceForTool } from "./agent-presence-target";
import { OUTSIDE_AI_WRITE_EVENT } from "../components/connect-ai-button";

const apiBase = import.meta.env?.VITE_API_URL || "";

/**
 * The card's live stream. Saves made anywhere else are applied as they land
 * (see applyRemoteSave). And while a card is open, an outside AI's edits (made with a card token, see
 * server routes/agent-api.ts) arrive here: the board pulls the server copy —
 * merged with anything unsaved, the same way the assistant's runs land — and
 * the block it touched glows with who did it, so the creator watches the work
 * instead of finding it later.
 */
export function useExternalWrites(worldId: string | null | undefined) {
  const { t } = useTranslation("editor");
  // One stream per open card: `t` changes as namespaces load, and reopening
  // the stream each time stacks long-lived connections on the API host.
  const tRef = useRef(t);
  tRef.current = t;
  const { data: session } = useSession();
  const myUserIdRef = useRef<string | undefined>(undefined);
  myUserIdRef.current = session?.user?.id;
  // Text typed together lives as long as the card is open; the stream below
  // may be replaced under it.
  useEffect(() => (worldId ? startLiveText(worldId) : undefined), [worldId]);
  // A stream that has gone quiet (no ping in a minute: a proxy dropped it
  // without telling the browser) is replaced by a fresh one.
  const [streamEpoch, setStreamEpoch] = useState(0);
  useEffect(() => {
    if (!worldId || typeof EventSource === "undefined") return;
    const source = new EventSource(`${apiBase}/api/studio/${worldId}/live`, { withCredentials: true });
    let clear: ReturnType<typeof setTimeout> | undefined;
    let heard = Date.now();
    for (const kind of ["open", "ping", "saved", "text", "caret", "presence", "cursor", "external-write", "access-changed"]) {
      source.addEventListener(kind, () => { heard = Date.now(); });
    }
    const watchdog = setInterval(() => {
      if (Date.now() - heard > 60_000) setStreamEpoch((n) => n + 1);
    }, 10_000);
    source.addEventListener("text", (raw) => {
      try { receiveText(JSON.parse((raw as MessageEvent).data)); } catch { /* malformed */ }
    });
    source.addEventListener("caret", (raw) => {
      try { receiveCaret(JSON.parse((raw as MessageEvent).data)); } catch { /* malformed */ }
    });
    source.addEventListener("external-write", (raw) => {
      let event: { actor: string; tool: string; args: Record<string, unknown> };
      try { event = JSON.parse((raw as MessageEvent).data); } catch { return; }
      // The Studio bar's 连接你的 AI button says who is at work.
      window.dispatchEvent(new CustomEvent(OUTSIDE_AI_WRITE_EVENT, { detail: { actor: event.actor } }));
      void useEditorStore.getState().refreshWorldSchema().then(() => {
        const t = tRef.current;
        const world = useEditorStore.getState().worldDraft;
        const presence = presenceForTool(event.tool, JSON.stringify(event.args ?? {}), world, t as unknown as (key: string) => string);
        const what = presence?.label.split(" · ").slice(1).join(" · ") ?? "";
        showAiPresence({
          target: presence?.target ?? '.react-flow__node[data-id^="block:card"]',
          label: t("studio.outsideAi.changed", { actor: event.actor, what, defaultValue: "{{actor}} 改了 · {{what}}" }),
        });
        if (clear) clearTimeout(clear);
        clear = setTimeout(() => showAiPresence(null), 4500);
      }).catch((error) => console.warn("[outside-ai] could not refresh after an outside write", error));
    });
    // Every save of this card from elsewhere — another tab, another device,
    // the assistant — lands in this editor as it happens.
    source.addEventListener("saved", (raw) => {
      let event: RemoteSaveEvent;
      try { event = JSON.parse((raw as MessageEvent).data); } catch { return; }
      useEditorStore.getState().applyRemoteSave(event);
    });
    // Who else has the card open, and changes to who may work on it.
    source.addEventListener("presence", (raw) => {
      try { receivePresence(JSON.parse((raw as MessageEvent).data)); } catch { /* malformed */ }
    });
    source.addEventListener("cursor", (raw) => {
      try { useCollabStore.getState().applyCursor(JSON.parse((raw as MessageEvent).data), editorClientId); } catch { /* malformed */ }
    });
    source.addEventListener("access-changed", (raw) => {
      let event: { userId: string };
      try { event = JSON.parse((raw as MessageEvent).data); } catch { return; }
      void receiveAccessChange(worldId, event.userId, myUserIdRef.current);
    });
    // A dropped connection may have missed saves; catch up once it is back.
    let opened = streamEpoch > 0;
    source.addEventListener("open", () => {
      if (opened) {
        void useEditorStore.getState().refreshWorldSchema(false, { source: "remote-save" }).catch(() => {});
        resyncLiveText();
      }
      opened = true;
      // Now that we can hear answers, say hello: everyone here replies.
      window.dispatchEvent(new window.CustomEvent("yumina:live-open", { detail: { worldId } }));
    });
    return () => { source.close(); clearInterval(watchdog); if (clear) clearTimeout(clear); };
  }, [worldId, streamEpoch]);
}
