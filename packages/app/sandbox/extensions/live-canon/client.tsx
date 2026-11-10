/* eslint-disable react-refresh/only-export-components -- extension modules export a registrar, not a React route */
import { useState } from "react";
import { BookOpenCheck } from "lucide-react";
import { useYumina } from "../../sandbox-context";
import { pickLang } from "../../chat/i18n";
import { ToolMenuRow } from "../../chat/composer-tool-menu";
import type { ExtensionClientContext } from "../registry";
import { LiveCanonModal } from "./live-canon-modal";

const LABEL = { en: "Lore Shift", zh: "Lore Shift", "zh-Hant": "Lore Shift", ja: "Lore Shift", es: "Lore Shift" } as const;
const SUBLABEL = { en: "Session state & lore", zh: "会话状态与设定", "zh-Hant": "工作階段狀態與設定", ja: "状態と設定を編集", es: "Estado y lore de sesión" } as const;

function liveCanonLang(language: string | undefined): keyof typeof LABEL {
  const normalized = (language ?? "en").toLowerCase();
  if (/^zh(?:-|_)(?:tw|hk|mo|hant)/.test(normalized)) return "zh-Hant";
  return pickLang(language);
}

function ToolbarItem() {
  const api = useYumina();
  const [open, setOpen] = useState(false);
  const lang = liveCanonLang(api.language);
  return <><button type="button" onClick={() => setOpen(true)} title={LABEL[lang] ?? LABEL.en} className="group mx-auto flex shrink-0 items-center gap-2 rounded-full border border-white/[0.12] bg-white/[0.05] px-3 py-1.5 transition-all hover:border-white/20 hover:bg-white/[0.09]"><BookOpenCheck className="h-3.5 w-3.5 text-primary/70" /><span className="text-[11px] font-medium text-white/70">{LABEL[lang] ?? LABEL.en}</span></button>{open && <LiveCanonModal open={open} onClose={() => setOpen(false)} />}</>;
}

function MenuRow({ onSelect }: { onSelect: () => void }) {
  const api = useYumina();
  const lang = liveCanonLang(api.language);
  return <ToolMenuRow icon={<BookOpenCheck className="h-4 w-4 text-primary/80" />} label={LABEL[lang] ?? LABEL.en} sublabel={SUBLABEL[lang] ?? SUBLABEL.en} onSelect={onSelect} />;
}

export default function register(ctx: ExtensionClientContext): void {
  ctx.contribute("chat.composer.toolbar", { id: "live-canon:toolbar", priority: 20, Component: ToolbarItem });
  ctx.contributeTool({ id: "live-canon", priority: 20, Row: MenuRow, Modal: LiveCanonModal });
}
