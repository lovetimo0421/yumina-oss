import { useEffect, useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { useYumina } from "../../sandbox-context";
import { SandboxPlatformOverlay } from "../../platform-overlay-portal";
import { ToolMenuRow } from "../../chat/composer-tool-menu";
import { ExtensionToolbarButton } from "../../chat/extension-toolbar-button";
import type { ExtensionClientContext } from "../registry";
import { guardLabels, StateGuardHistory, validationRecords } from "./details";
import { StateGuardSettingsPanel, guardSettingsLabels } from "./settings";
import { ModelPickerModal, ModelTrigger } from "../../chat/model-picker-modal";
import { activeGuardElement, focusGuardDialog, installGuardFocusScope } from "./focus";
import { parseStateGuardModel, stateGuardModelSelection } from "@yumina/shared";

export function StateGuardModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const api = useYumina();
  const text = guardLabels(api.language);
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const [officialModels, setOfficialModels] = useState(true);
  const [picker, setPicker] = useState<{ selected: string | null; provider: "official" | "private"; save: (model: string) => void } | null>(null);
  const pickerTrigger = useRef<HTMLElement | null>(null);
  const focusState = useRef({ pickerOpen: false, onClose });
  focusState.current = { pickerOpen: Boolean(picker), onClose };
  const activeDialog = () => {
    const guard = dialog.current;
    if (!guard || !focusState.current.pickerOpen) return guard;
    return [...(guard.getRootNode() as Document | ShadowRoot).querySelectorAll<HTMLElement>('[role="dialog"]')]
      .reverse().find((element) => element !== guard) ?? guard;
  };
  useEffect(() => { setPicker(null); }, [api.sessionId, open]);
  useEffect(() => {
    if (!open) return;
    return installGuardFocusScope(document, activeDialog, () => {
      if (focusState.current.pickerOpen) setPicker(null);
      else focusState.current.onClose();
    });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const active = activeDialog();
    if (active) focusGuardDialog(active, picker ? null : pickerTrigger.current ?? closeButton.current);
  }, [open, Boolean(picker), api.sessionId]);
  if (!open) return null;
  return <><SandboxPlatformOverlay>
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4" onClick={(event) => {
      if (event.target === event.currentTarget && !picker) onClose();
    }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-label={text[0]} className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl border border-white/10 bg-zinc-950 p-5 text-white shadow-2xl">
        <div className="mb-4 flex items-center justify-between gap-4"><h2 className="text-lg font-semibold">{text[0]}</h2><button ref={closeButton} onClick={onClose} className="rounded px-3 py-2 hover:bg-white/10 focus-visible:outline focus-visible:outline-2">{text[13]}</button></div>
        <StateGuardHistory key={api.sessionId} records={validationRecords(api.messages)} language={api.language}>
        <StateGuardSettingsPanel key={api.sessionId} sessionId={api.sessionId} language={api.language} readOnly={api.readOnly} storyModel={api.selectedModel}
          load={async () => { const settings = await api.getStateGuardSettings(); setOfficialModels(settings.officialModels !== false); return settings; }} save={(patch) => api.setStateGuardSettings(patch)}
          renderModel={(model, onClick) => <ModelTrigger model={parseStateGuardModel(model).model ?? api.selectedModel} provider={parseStateGuardModel(model).provider} showBalance={false} onClick={onClick} className="mx-0 min-h-11 max-w-full focus-visible:outline focus-visible:outline-2" />}
          getModels={async () => (await api.getModels("private")).models} chooseModel={(selected, save) => {
            pickerTrigger.current = activeGuardElement(document) as HTMLElement | null;
            const selection = parseStateGuardModel(selected);
            setPicker({ selected: selection.model, provider: officialModels ? selection.provider ?? api.preferredProvider : "private", save });
          }} />
        </StateGuardHistory>
      </div>
    </div>
  </SandboxPlatformOverlay>
    <ModelPickerModal open={Boolean(picker)} onClose={() => setPicker(null)}
      selectedModel={picker?.selected ?? api.selectedModel}
      selectionProvider={picker?.provider}
      allowOfficialModels={officialModels}
      onSelectionProviderChange={(provider) => setPicker((current) => current ? { ...current, provider } : null)}
      onSelectModel={(model) => { if (picker) picker.save(stateGuardModelSelection(model, picker.provider)); setPicker(null); }}
      title={guardSettingsLabels(api.language)[3]} subtitle={text[0]} />
  </>;
}

function Toolbar() {
  const api = useYumina();
  const [open, setOpen] = useState(false);
  return <><ExtensionToolbarButton icon={ShieldCheck} label={guardLabels(api.language)[0]} onClick={() => setOpen(true)} /><StateGuardModal open={open} onClose={() => setOpen(false)} /></>;
}

function Row({ onSelect }: { onSelect: () => void }) {
  const api = useYumina();
  return <ToolMenuRow icon={<ShieldCheck className="h-4 w-4 text-primary/80" />} label={guardLabels(api.language)[0]} onSelect={onSelect} />;
}

export default function register(ctx: ExtensionClientContext) {
  ctx.contribute("chat.composer.toolbar", { id: "state-update-guard:status", priority: 40, Component: Toolbar });
  ctx.contributeTool({ id: "state-update-guard", priority: 40, Row, Modal: StateGuardModal });
}
