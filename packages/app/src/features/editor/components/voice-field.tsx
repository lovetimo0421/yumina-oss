import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Volume2 } from "lucide-react";
import { TTS_VOICES, readTtsCustomVoices, resolveTtsVoiceAlias, ttsCustomVoiceLabel } from "@yumina/shared";
import { useUserProfileStore } from "@/stores/user-profile";
import { cn } from "@/lib/utils";
import { VoicePickerPopover } from "./voice-picker-popover";

/**
 * The voice a character (or the card's narrator) is read in when the player
 * turns voice readout on. Every editor mounts this one field — the full
 * editor's entry form, the simple editor's character card, the canvas
 * inspector and the card's voice settings — and all of them open the same
 * picker, so "what a voice is" can't drift between them.
 */
export function VoiceField({
  value,
  onChange,
  title,
  label,
  hint,
  variant = "row",
}: {
  value?: string;
  onChange: (voice: string | undefined) => void;
  /** Heading of the picker, e.g. 「老猎户」的音色. */
  title: string;
  label: string;
  hint?: string;
  variant?: "row" | "compact";
}) {
  const { t } = useTranslation("editor");
  const { t: ts } = useTranslation("settings");
  const [open, setOpen] = useState(false);

  const id = value ? resolveTtsVoiceAlias(value) : undefined;
  const known = id ? TTS_VOICES.find((v) => v.id === id) : undefined;
  const preferences = useUserProfileStore((s) => s.profile?.preferences);
  const savedCustom = useMemo(() => readTtsCustomVoices(preferences), [preferences]);
  const custom = id && !known ? savedCustom.find((v) => v.id === id) : undefined;
  const current = !value
    ? t("voiceField.follow")
    : known
      ? ts(`display.tts.voices.${known.labelKey}` as never)
      : custom
        ? ttsCustomVoiceLabel(custom)
        : t("voiceField.custom");

  const picker = open ? (
    <VoicePickerPopover title={title} value={value} onChange={onChange} onClose={() => setOpen(false)} />
  ) : null;

  if (variant === "compact") {
    return (
      <>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors",
            value ? "border-teal-400/40 text-teal-300" : "border-border text-muted-foreground hover:text-foreground",
          )}
        >
          <Volume2 className="h-3.5 w-3.5" />
          <span>{label}：{current}</span>
        </button>
        {picker}
      </>
    );
  }

  return (
    <div className="space-y-2">
      <label className="text-sm font-bold text-foreground">{label}</label>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={cn(
            "inline-flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm transition-colors hover:border-primary/40",
            value ? "border-teal-400/40 text-foreground" : "border-border text-muted-foreground",
          )}
        >
          <Volume2 className={cn("h-4 w-4", value ? "text-teal-300" : "text-muted-foreground/60")} />
          {current}
        </button>
        {value && (
          <button
            type="button"
            onClick={() => onChange(undefined)}
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {t("voiceField.clear")}
          </button>
        )}
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {picker}
    </div>
  );
}
