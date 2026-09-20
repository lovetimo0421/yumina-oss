import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ShieldCheck } from "lucide-react";
import { useChatStore } from "@/stores/chat";
import { useExtensionsStore } from "@/stores/extensions";
import { fetchPrivateModelCatalog } from "@/stores/models";
import { PLAY_MODELS, stateGuardModelSelection } from "@yumina/shared";
import { requestStateGuardSettings } from "@/lib/state-guard-settings";
import { StateGuardSettingsPanel } from "../../../sandbox/extensions/state-update-guard/settings";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { guardLabels, StateGuardHistory, validationRecords } from "../../../sandbox/extensions/state-update-guard/details";
import { useFeature } from "@/edition/edition";
import { useConfigStore } from "@/stores/config";

/** Parent-owned access stays reachable even if a card omits every extension slot. */
export function StateGuardHost() {
  const installed = useExtensionsStore((state) => state.installState["state-update-guard"] === "installed");
  const messages = useChatStore((state) => state.messages);
  const sessionId = useChatStore((state) => state.session?.id ?? "");
  const variableDefs = useChatStore((state) => state.session?.world?.schema?.variables);
  const officialModels = useFeature("officialModels");
  const storyModel = useConfigStore((state) => state.selectedModel);
  const { i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener("yumina:request-state-guard", show);
    return () => window.removeEventListener("yumina:request-state-guard", show);
  }, []);
  if (!installed) return null;
  return <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[85vh] overflow-y-auto"><DialogHeader><DialogTitle>{guardLabels(i18n.language)[0]}</DialogTitle></DialogHeader>
    <StateGuardHistory key={sessionId} records={validationRecords(messages as unknown as Array<Record<string, unknown>>, Array.isArray(variableDefs) ? variableDefs.filter((v) => v && typeof v.id === "string" && (v.name === undefined || typeof v.name === "string")) : undefined)} language={i18n.language}>
    <StateGuardSettingsPanel key={sessionId} sessionId={sessionId} language={i18n.language} officialModels={officialModels} storyModel={storyModel}
      load={() => requestStateGuardSettings(sessionId)} save={(patch) => requestStateGuardSettings(sessionId, patch)}
      getModels={async () => [
        ...(officialModels ? PLAY_MODELS.map((model) => ({ id: stateGuardModelSelection(model.id, "official"), name: `Yumina · ${model.name}` })) : []),
        ...(await fetchPrivateModelCatalog().catch(() => [])).map((model) => ({ id: stateGuardModelSelection(model.id, "private"), name: `BYOK · ${model.name}` })),
      ]} />
    </StateGuardHistory>
  </DialogContent></Dialog>;
}

export function StateGuardHostButton() {
  const installed = useExtensionsStore((state) => state.installState["state-update-guard"] === "installed");
  const { i18n } = useTranslation();
  if (!installed) return null;
  return <button onClick={() => window.dispatchEvent(new CustomEvent("yumina:request-state-guard"))} className="flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-sm text-white/70 hover:bg-white/10 hover:text-white"><ShieldCheck className="h-4 w-4" />{guardLabels(i18n.language)[0]}</button>;
}
