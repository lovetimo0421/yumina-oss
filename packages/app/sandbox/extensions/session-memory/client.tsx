// Session Memory & Story Summary — sandbox client module. Registered when the
// extension is installed (see sandbox/extensions/index.ts). Imports are STATIC
// (not lazy): runtime dynamic import() does not load inside the production
// sandbox iframe (opaque origin + connect-src 'none' CSP), so both the button
// and the modal must be bundled, not fetched on demand. The pre-registry
// system imported this modal statically too — that is why it worked in prod.
//
// Two contributions:
//   • chat.composer.toolbar — the inline "Context" pill (desktop / wide bars).
//   • tool menu — a launcher ROW for the compact mobile selector, split from
//     the modal so the selector can close and the real modal takes over.

import { useState } from "react";
import { Brain } from "lucide-react";
import { useYumina } from "../../sandbox-context";
import { pickLang } from "../../chat/i18n";
import { ToolMenuRow } from "../../chat/composer-tool-menu";
import { ExtensionToolbarButton } from "../../chat/extension-toolbar-button";
import { SessionMemoryModal } from "./session-memory-modal";
import type { ExtensionClientContext } from "../registry";

const ROW_LABEL: Record<string, string> = {
  en: "Session Memory",
  zh: "会话记忆",
  ja: "セッションメモリ",
  es: "Memoria de sesión",
};
const ROW_SUBLABEL: Record<string, string> = {
  en: "Memory & story summary",
  zh: "记忆与剧情摘要",
  ja: "記憶とストーリー要約",
  es: "Memoria y resumen",
};
/** Localized pill label — matches the store listing name ("Session Memory…"),
 *  not the old "Context" codename players couldn't connect to the extension. */
const PILL_LABEL: Record<string, string> = {
  en: "Memory",
  zh: "记忆",
  ja: "記憶",
  es: "Memoria",
};

function SessionMemoryToolbarItem() {
  const api = useYumina();
  const [open, setOpen] = useState(false);
  // Defense in depth — the SlotOutlet already gates on install state.
  if (!api.memorySummaryEnabled) return null;
  const lang = pickLang(api.language);
  return (
    <>
      <ExtensionToolbarButton
        icon={Brain}
        label={PILL_LABEL[lang] ?? PILL_LABEL.en!}
        onClick={() => setOpen(true)}
        title={ROW_LABEL[lang] ?? ROW_LABEL.en}
      />
      {open && <SessionMemoryModal open={open} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Launcher row for the compact tool menu. Pure chooser — opening the modal is
 *  the menu's job (it owns the open-state and mounts SessionMemoryModal). */
function SessionMemoryMenuRow({ onSelect }: { onSelect: () => void }) {
  const api = useYumina();
  if (!api.memorySummaryEnabled) return null;
  const lang = pickLang(api.language);
  return (
    <ToolMenuRow
      icon={<Brain className="h-4 w-4 text-primary/80" />}
      label={ROW_LABEL[lang] ?? ROW_LABEL.en}
      sublabel={ROW_SUBLABEL[lang] ?? ROW_SUBLABEL.en}
      onSelect={onSelect}
    />
  );
}

export default function register(ctx: ExtensionClientContext): void {
  ctx.contribute("chat.composer.toolbar", {
    id: "session-memory:context",
    priority: 10,
    Component: SessionMemoryToolbarItem,
  });
  ctx.contributeTool({
    id: "session-memory",
    priority: 10,
    Row: SessionMemoryMenuRow,
    Modal: SessionMemoryModal,
  });
}
