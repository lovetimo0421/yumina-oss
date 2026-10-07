import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useEditorStore } from "@/stores/editor";
import { showAiPresence } from "./agent-job";
import { presenceForTool } from "./agent-presence-target";

const apiBase = import.meta.env?.VITE_API_URL || "";

/**
 * While a card is open, an outside AI's edits (made with a card token, see
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
  useEffect(() => {
    if (!worldId || typeof EventSource === "undefined") return;
    const source = new EventSource(`${apiBase}/api/studio/${worldId}/live`, { withCredentials: true });
    let clear: ReturnType<typeof setTimeout> | undefined;
    source.addEventListener("external-write", (raw) => {
      let event: { actor: string; tool: string; args: Record<string, unknown> };
      try { event = JSON.parse((raw as MessageEvent).data); } catch { return; }
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
    return () => { source.close(); if (clear) clearTimeout(clear); };
  }, [worldId]);
}
