import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useStudioStore } from "@/stores/studio";
import { useEditorStore } from "@/stores/editor";
import { showAiPresence } from "./agent-job";
import { presenceForTool } from "./agent-presence-target";

/** Mount on the canvas: follows the assistant's current tool call. */
export function useAgentPresence() {
  const { t } = useTranslation("editor");
  const working = useStudioStore((s) => s.isAgentWorking);
  const call = useStudioStore((s) => s.agentToolCall);
  useEffect(() => {
    if (!working || !call) { showAiPresence(null); return; }
    const presence = presenceForTool(call.name, call.arguments, useEditorStore.getState().worldDraft, t as unknown as (key: string) => string);
    if (presence) showAiPresence(presence);
  }, [working, call, t]);
  useEffect(() => () => showAiPresence(null), []);
}
