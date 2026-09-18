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
      <button
        onClick={() => setOpen(true)}
        className="group mx-auto flex shrink-0 items-center gap-2 rounded-full border border-white/[0.12] bg-white/[0.05] px-3 py-1.5 transition-all hover:border-white/20 hover:bg-white/[0.09]"
        title={ROW_LABEL[lang] ?? ROW_LABEL.en}
      >
        <Brain className="h-3.5 w-3.5 text-primary/70 group-hover:text-primary" />
        <span className="text-[11px] font-medium text-white/70 group-hover:text-white transition-colors">
          {PILL_LABEL[lang] ?? PILL_LABEL.en}
        </span>
      </button>
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
