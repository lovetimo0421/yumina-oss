import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2, Play, Sparkles, Square } from "lucide-react";
import { MushroomIcon } from "@/lib/plan-theme";
import { feedback } from "@/lib/feedback";
import { useAudioStore } from "@/stores/audio";
import { useUserProfileStore } from "@/stores/user-profile";
import { readTtsCustomVoices } from "@yumina/shared";
import { cn } from "@/lib/utils";
import {
  loadVoiceDesignStatus,
  requestVoiceDesign,
  saveDesignedVoice,
  withSavedVoice,
  type VoiceDesignCandidate,
  type VoiceDesignStatus,
} from "./voice-design-client";

const apiBase = import.meta.env.VITE_API_URL || "";

function refreshCredits() {
  void import("@/edition/slots.state")
    .then((m) => m.useCreditStore.getState().fetchCredits())
    .catch(() => {});
}

/**
 * "AI design" inside the voice picker's custom group: describe a voice, hear
 * a few candidates, keep one. The kept voice is saved to the author's custom
 * voices (named) and handed back through `onPick` like a pasted id.
 * Renders nothing unless the server has voice design switched on.
 */
export function VoiceDesignPanel({ onPick }: { onPick: (id: string) => void }) {
  const { t, i18n } = useTranslation("editor");
  const [status, setStatus] = useState<VoiceDesignStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState<"design" | string | null>(null);
  const [candidates, setCandidates] = useState<VoiceDesignCandidate[]>([]);
  const playback = useAudioStore((s) => s.voicePlayback);
  const preferences = useUserProfileStore((s) => s.profile?.preferences);
  const forceFetchProfile = useUserProfileStore((s) => s.forceFetchProfile);

  useEffect(() => {
    let live = true;
    void loadVoiceDesignStatus().then((s) => { if (live) setStatus(s); });
    return () => { live = false; };
  }, []);

  useEffect(() => () => {
    const key = useAudioStore.getState().voicePlayback?.key;
    if (key?.startsWith("voice-design:")) useAudioStore.getState().stopVoice();
  }, []);

  if (!status?.enabled) return null;

  const design = async () => {
    const text = description.trim();
    if (!text || busy) return;
    setBusy("design");
    const result = await requestVoiceDesign(text, i18n.language || "en");
    setBusy(null);
    if (!result.ok) {
      feedback.error(t(`voiceField.design.${result.errorKey}` as never));
      if (result.errorKey === "failed") refreshCredits();
      return;
    }
    setCandidates(result.candidates);
    refreshCredits();
    const first = result.candidates[0];
    if (first) useAudioStore.getState().playVoice(`voice-design:${first.token}`, `${apiBase}${first.url}`);
  };

  const keep = async (candidate: VoiceDesignCandidate) => {
    if (busy) return;
    setBusy(candidate.token);
    const result = await saveDesignedVoice(candidate.token, "");
    if (!result.ok) {
      setBusy(null);
      feedback.error(t(`voiceField.design.${result.errorKey === "failed" ? "saveFailed" : result.errorKey}` as never));
      return;
    }
    if (result.credits > 0) refreshCredits();
    const list = withSavedVoice(readTtsCustomVoices(preferences), { id: result.id, name: result.name });
    try {
      const res = await fetch(`${apiBase}/api/users/me`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ preferences: { ttsCustomVoices: list } }),
      });
      if (res.ok) await forceFetchProfile();
    } catch { /* the card still gets the id; only the name in the list is lost */ }
    setBusy(null);
    onPick(result.id);
  };

  const toggle = (candidate: VoiceDesignCandidate) => {
    const key = `voice-design:${candidate.token}`;
    const store = useAudioStore.getState();
    if (store.voicePlayback?.key === key) store.stopVoice();
    else store.playVoice(key, `${apiBase}${candidate.url}`);
  };

  if (!open) {
    return (
      <button
        type="button"
        data-voice-design-open
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Sparkles className="h-3.5 w-3.5 text-amber-400" />
        <span className="flex-1">{t("voiceField.design.open")}</span>
      </button>
    );
  }

  return (
    <div data-voice-design className="mx-1 my-1.5 space-y-2 rounded-lg border border-white/[0.08] bg-white/[0.02] p-2.5">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
        <Sparkles className="h-3.5 w-3.5 text-amber-400" />
        {t("voiceField.design.open")}
      </div>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value.slice(0, status.maxDescription))}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void design(); }}
        rows={2}
        placeholder={t("voiceField.design.placeholder")}
        className="w-full resize-none rounded-md border border-white/[0.1] bg-white/[0.03] px-2.5 py-1.5 text-xs placeholder:text-muted-foreground/50 focus:border-amber-400/40 focus:outline-none"
      />
      <button
        type="button"
        onClick={() => void design()}
        disabled={!description.trim() || busy !== null}
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-amber-400/40 bg-amber-400/10 px-3 text-xs text-amber-200 transition-colors hover:bg-amber-400/20 disabled:opacity-40"
      >
        {busy === "design" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        {t(candidates.length ? "voiceField.design.again" : "voiceField.design.generate")}
        <span className="inline-flex items-center gap-0.5 text-amber-300/80">
          <MushroomIcon className="h-3 w-3" />
          {status.designCredits}
        </span>
      </button>
      {candidates.length > 0 && (
        <div className="space-y-0.5">
          {candidates.map((c, i) => {
            const key = `voice-design:${c.token}`;
            const state = playback?.key === key ? playback.status : null;
            return (
              <div key={c.token} className="flex items-center gap-1 rounded-md pr-1 hover:bg-accent">
                <button
                  type="button"
                  onClick={() => toggle(c)}
                  aria-label={t("voiceField.preview")}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-white/10 hover:text-foreground"
                >
                  {state === "loading" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : state === "playing" ? <Square className="h-3 w-3" /> : <Play className="h-3.5 w-3.5" />}
                </button>
                <span className={cn("min-w-0 flex-1 truncate text-xs", state === "playing" && "text-amber-200")}>
                  {t("voiceField.design.candidate", { n: i + 1 })}
                  {c.durationMs > 0 && <span className="ml-1.5 text-[10px] text-muted-foreground">{(c.durationMs / 1000).toFixed(1)}s</span>}
                </span>
                <button
                  type="button"
                  data-voice-design-keep={i}
                  onClick={() => void keep(c)}
                  disabled={busy !== null}
                  className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-white/[0.1] px-2.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
                >
                  {busy === c.token ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                  {t("voiceField.useCustom")}
                  {status.saveCredits > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-amber-300/80"><MushroomIcon className="h-3 w-3" />{status.saveCredits}</span>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
