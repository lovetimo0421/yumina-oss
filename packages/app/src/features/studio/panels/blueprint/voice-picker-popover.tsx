import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Check, Loader2, Play, Volume2, X } from "lucide-react";
import { TTS_VOICES } from "@yumina/shared";
import { cn } from "@/lib/utils";
import { previewVoice } from "@/lib/tts-playback";

const LANG_ORDER = ["zh", "en", "ja", "es"] as const;

/**
 * A voice for a character, or for the narrator.
 *
 * The same curated list the player's settings offer — the two sides have to
 * agree on what a voice is, and a card that names a voice the player's
 * picker has never heard of would be a card nobody could check. Every row
 * plays its sample through the same preview the settings page uses. The
 * first row hands the choice back to the player: not "no voice", but "not
 * this card's to decide".
 */
export function VoicePickerPopover({ title, value, onChange, onClose, inputMode, onInputModeChange }: {
  title: string;
  value?: string;
  onChange: (voice: string | undefined) => void;
  onClose: () => void;
  /** Card-wide only (the narrator's popover): what the player's voice input
   *  does on release. */
  inputMode?: "confirm" | "auto";
  onInputModeChange?: (mode: "confirm" | "auto") => void;
}) {
  const { t, i18n } = useTranslation("editor");
  const { t: ts } = useTranslation("settings");
  const [playing, setPlaying] = useState<string | null>(null);
  const uiLang = (i18n.language || "en").slice(0, 2);
  // The interface's own language first: a Chinese card's author is shown
  // Chinese voices before anything else, without hiding the rest.
  const groups = useMemo(() => {
    const order = [uiLang, ...LANG_ORDER.filter(l => l !== uiLang)];
    return order.map(lang => ({ lang, voices: TTS_VOICES.filter(v => v.lang === lang) })).filter(g => g.voices.length > 0);
  }, [uiLang]);
  const preview = async (id: string, lang: string) => {
    setPlaying(id);
    try { await previewVoice(id, lang); } finally { setPlaying(null); }
  };
  return createPortal(
    <div className="fixed inset-0 z-[1200] flex items-center justify-center modal-backdrop p-4" onClick={onClose} role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-voice-picker
        onClick={e => e.stopPropagation()}
        className="flex max-h-[80vh] w-full max-w-md flex-col rounded-xl border border-white/[0.08] bg-[#181a24] text-foreground shadow-[0_24px_80px_rgba(0,0,0,0.6)]"
      >
        <div className="flex items-center gap-2 border-b border-white/[0.07] px-4 py-3">
          <Volume2 className="h-4 w-4 text-amber-400" />
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h2>
          <button type="button" onClick={onClose} aria-label={t("blueprint.rowEdit.close")} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"><X className="h-4 w-4" /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          <button
            type="button"
            data-voice-option=""
            onClick={() => { onChange(undefined); onClose(); }}
            className={cn("flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-accent", !value && "bg-amber-400/10")}
          >
            <span className="min-w-0 flex-1">
              <span className="block">{t("blueprint.voice.follow")}</span>
            </span>
            {!value && <Check className="h-4 w-4 shrink-0 text-amber-300" />}
          </button>
          {groups.map(group => (
            <section key={group.lang} className="mt-2">
              <h3 className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{t(`blueprint.voice.lang.${group.lang}` as never)}</h3>
              {group.voices.map(v => {
                const selected = value === v.id;
                return (
                  <div key={v.id} className={cn("flex items-center gap-1 rounded-lg pr-1 transition-colors hover:bg-accent", selected && "bg-amber-400/10")}>
                    <button
                      type="button"
                      data-voice-option={v.id}
                      onClick={() => { onChange(v.id); onClose(); }}
                      className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-sm"
                    >
                      <span className="min-w-0 flex-1 truncate">{ts(`display.tts.voices.${v.labelKey}` as never)}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">{t(`blueprint.voice.gender.${v.gender}` as never)}</span>
                      {selected && <Check className="h-4 w-4 shrink-0 text-amber-300" />}
                    </button>
                    <button
                      type="button"
                      onClick={() => void preview(v.id, v.lang)}
                      disabled={playing !== null}
                      title={t("blueprint.voice.preview")}
                      aria-label={t("blueprint.voice.preview")}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-white/10 hover:text-foreground disabled:opacity-50"
                    >
                      {playing === v.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                );
              })}
            </section>
          ))}
        </div>
        {onInputModeChange && (
          <div className="flex items-center justify-between gap-3 border-t border-white/[0.07] px-4 py-2.5">
            <div className="min-w-0">
              <div className="text-sm">{t("blueprint.voice.inputTitle")}</div>
            </div>
            <div className="flex shrink-0 gap-1" role="group" aria-label={t("blueprint.voice.inputTitle")}>
              {(["confirm", "auto"] as const).map(m => {
                const active = (inputMode ?? "confirm") === m;
                return (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={active}
                    onClick={() => onInputModeChange(m)}
                    className={cn("rounded-md border px-2.5 py-1 text-xs transition-colors", active ? "border-amber-400/50 bg-amber-400/10 text-amber-300" : "border-white/[0.1] text-muted-foreground hover:text-foreground")}
                  >
                    {t(m === "auto" ? "blueprint.voice.inputAuto" : "blueprint.voice.inputConfirm")}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
