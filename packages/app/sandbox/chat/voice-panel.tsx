/**
 * In-chat voice readout panel.
 *
 * A composer-toolbar popover where the player tunes voice readout without
 * leaving the story: master switch, auto-read (read-along while the AI
 * generates), reading scope, the player's voice pool (multi-select, with live
 * previews — AI casting picks characters' voices from it), and volume.
 *
 * Voice readout is opt-in from Settings › Display. Until the player turns it
 * on, the button isn't there at all. Voice-input (hold-to-talk) settings live
 * in Settings › Display too, not here.
 *
 * All state lives in the account preferences — reads come from the
 * host-pushed `ttsState`, writes go through `api.tts.setPrefs` (optimistic on
 * the host side, so the panel reflects a change on the next channel push).
 */

import { useState, useRef, useEffect, useMemo } from "react";
import { Volume2, Play, Square, Loader2, Check, Captions } from "lucide-react";
import { TTS_VOICES } from "@yumina/shared";
import { useYumina } from "../sandbox-context";
import { makeChatT } from "./i18n";
import { ComposerPopover } from "./composer-popover";

/** The i18n keys for the curated voices, mirrored from shared TTS_VOICES. */
type VoiceLabelKey = (typeof TTS_VOICES)[number]["labelKey"];

export function VoicePanelButton() {
  const api = useYumina();
  const t = useMemo(() => makeChatT(api.language), [api.language]);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const tts = api.ttsState;
  const readout = !!tts?.available && tts.enabled;

  // Click-outside dismiss (same pattern as the "+" actions menu).
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (rootRef.current && !rootRef.current.contains(target) && !panelRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (!readout) return null;

  const speaking = tts.playback != null;
  const title = t("voicePanelTitle");

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={title}
        aria-label={title}
        className={`play-composer-icon-button hover-surface relative rounded-lg transition-colors ${
          open || speaking ? "text-primary" : "text-foreground/70 hover:text-foreground"
        }`}
      >
        <Volume2 className="h-4 w-4" />
        {speaking && (
          <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
        )}
      </button>

      {open && (
        <ComposerPopover
          anchorRef={rootRef}
          popoverRef={panelRef}
          align="right"
          className="flex w-[300px] max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-md"
        >
          <VoicePanel onClose={() => setOpen(false)} />
        </ComposerPopover>
      )}
    </div>
  );
}

function VoicePanel({ onClose }: { onClose: () => void }) {
  const api = useYumina();
  const t = useMemo(() => makeChatT(api.language), [api.language]);
  const tts = api.ttsState;

  // Volume: local echo while dragging (channel round-trips are too slow for a
  // slider), pushed throttled; the bar snaps to the authoritative value when
  // the host echoes it back.
  const [localVolume, setLocalVolume] = useState(tts.volume);
  const lastSentRef = useRef(0);
  useEffect(() => setLocalVolume(tts.volume), [tts.volume]);
  const onVolume = (v: number) => {
    setLocalVolume(v);
    const now = Date.now();
    if (now - lastSentRef.current > 120) {
      lastSentRef.current = now;
      api.tts.setPrefs({ volume: v });
    }
  };
  const commitVolume = () => api.tts.setPrefs({ volume: localVolume });

  // Curated voices, player's UI language first (stable within groups).
  const uiLang = (api.language ?? "en").toLowerCase();
  const langGroup = uiLang.startsWith("zh")
    ? "zh"
    : uiLang.startsWith("ja")
      ? "ja"
      : uiLang.startsWith("es")
        ? "es"
        : "en";
  const voices = useMemo(
    () =>
      [...TTS_VOICES].sort(
        (a, b) => Number(b.lang === langGroup) - Number(a.lang === langGroup),
      ),
    [langGroup],
  );

  // The voice pool (older hosts send only the single legacy voice).
  const pool = tts.voicePool ?? (tts.voice ? [tts.voice] : []);
  const togglePool = (id: string) =>
    api.tts.setPrefs({ voicePool: pool.includes(id) ? pool.filter((v) => v !== id) : [...pool, id] });

  const [previewPending, setPreviewPending] = useState<string | null>(null);
  const playbackKey = tts.playback?.key ?? null;
  const isSamplePlaying = (id: string) =>
    playbackKey === `preview:${id || "auto"}` && tts.playback?.status === "playing";

  const handlePreview = (id: string) => {
    if (isSamplePlaying(id)) {
      api.tts.stop();
      return;
    }
    if (previewPending) return;
    setPreviewPending(id || "auto");
    void api.tts.preview(id).finally(() => setPreviewPending(null));
  };

  return (
    <>
      {/* Header: title + master switch */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/60 px-3.5 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Volume2 className="h-4 w-4 shrink-0 text-primary" />
          <span className="truncate text-[13px] font-semibold">{t("voicePanelTitle")}</span>
        </div>
        <div className="flex items-center gap-2">
          {tts.playback && (
            <button
              type="button"
              onClick={() => api.tts.stop()}
              className="rounded-md bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/25"
            >
              {t("stopReading")}
            </button>
          )}
          <MiniSwitch
            checked={tts.enabled}
            onChange={(v) => api.tts.setPrefs({ enabled: v })}
            label={t("voicePanelTitle")}
          />
        </div>
      </div>

      <div className="min-h-0 max-h-[min(30rem,60vh)] overflow-y-auto">
          {/* Auto read-along — the hero row. The whole row is a click target,
              but the MiniSwitch inside is the accessible control (a row
              <button> would nest buttons); its stopPropagation keeps a click
              on the switch from toggling twice. */}
          <div
            onClick={() => api.tts.setPrefs({ autoPlay: !tts.autoPlay })}
            className={`flex w-full cursor-pointer items-center justify-between gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-accent/50 ${
              tts.autoPlay ? "bg-primary/5" : ""
            }`}
          >
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-[12px] font-medium text-foreground">
                {t("voiceAutoRead")}
                {tts.autoPlay && <SpeakingBars />}
              </div>
              <div className="mt-0.5 text-[10.5px] leading-snug text-muted-foreground/60">
                {t("voiceAutoReadHint")}
              </div>
            </div>
            <MiniSwitch
              checked={tts.autoPlay}
              onChange={(v) => api.tts.setPrefs({ autoPlay: v })}
              label={t("voiceAutoRead")}
            />
          </div>

          {/* Reading scope */}
          <div className="border-t border-border/60 px-3.5 py-2.5">
            <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
              <Captions className="h-3 w-3" />
              {t("voiceScope")}
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {(["full", "dialogue"] as const).map((m) => {
                const active = tts.mode === m;
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => api.tts.setPrefs({ mode: m })}
                    className={`rounded-lg border px-2 py-1.5 text-[11.5px] font-medium transition-colors ${
                      active
                        ? "border-primary/40 bg-primary/10 text-primary"
                        : "border-border/60 text-foreground/70 hover:border-border hover:text-foreground"
                    }`}
                  >
                    {m === "full" ? t("voiceScopeFull") : t("voiceScopeDialogue")}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Voice picker */}
          <div className="border-t border-border/60 px-3.5 py-2.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
              {t("voiceVoice")}
            </div>
            <div className="mb-1.5 mt-0.5 text-[10.5px] leading-snug text-muted-foreground/60">{t("voicePoolHint")}</div>
            <div className="max-h-44 space-y-1 overflow-y-auto pr-0.5">
              <VoiceRow
                label={t("voiceAuto")}
                langTag={null}
                selected={pool.length === 0}
                samplePlaying={isSamplePlaying("")}
                previewPending={previewPending === "auto"}
                previewDisabled={previewPending !== null && previewPending !== "auto" && !isSamplePlaying("")}
                onSelect={() => api.tts.setPrefs({ voicePool: [] })}
                onPreview={() => handlePreview("")}
                previewTitle={t("voicePreview")}
              />
              {voices.map((v) => (
                <VoiceRow
                  key={v.id}
                  label={t(`voice_${v.labelKey}` as `voice_${VoiceLabelKey}`)}
                  langTag={v.lang}
                  selected={pool.includes(v.id)}
                  samplePlaying={isSamplePlaying(v.id)}
                  previewPending={previewPending === v.id}
                  previewDisabled={previewPending !== null && previewPending !== v.id && !isSamplePlaying(v.id)}
                  onSelect={() => togglePool(v.id)}
                  onPreview={() => handlePreview(v.id)}
                  previewTitle={t("voicePreview")}
                />
              ))}
            </div>
          </div>

          {/* Volume */}
          <div className="border-t border-border/60 px-3.5 py-2.5">
            <div className="mb-1.5 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
              <span>{t("voiceVolume")}</span>
              <span className="tabular-nums text-muted-foreground/80">{localVolume}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={localVolume}
              onChange={(e) => onVolume(Number(e.target.value))}
              onMouseUp={commitVolume}
              onTouchEnd={commitVolume}
              aria-label={t("voiceVolume")}
              className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-[color:var(--color-primary,#C9A25E)]"
            />
          </div>

          {/* Cost footnote */}
          <p className="border-t border-border/60 px-3.5 py-2 text-[10px] leading-snug text-muted-foreground/50">
            {t("voiceCostHint")}
          </p>
        </div>
      {/* Escape hatch for keyboard users */}
      <button type="button" onClick={onClose} className="sr-only">
        {t("cancel")}
      </button>
    </>
  );
}

function VoiceRow({
  label,
  langTag,
  selected,
  samplePlaying,
  previewPending,
  previewDisabled,
  onSelect,
  onPreview,
  previewTitle,
}: {
  label: string;
  langTag: string | null;
  selected: boolean;
  samplePlaying: boolean;
  previewPending: boolean;
  previewDisabled: boolean;
  onSelect: () => void;
  onPreview: () => void;
  previewTitle: string;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onSelect();
      }}
      className={`flex cursor-pointer items-center justify-between gap-2 rounded-lg border px-2 py-1.5 transition-colors ${
        selected
          ? "border-primary/40 bg-primary/10"
          : "border-transparent hover:bg-accent/60"
      }`}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {selected && <Check className="h-3 w-3 shrink-0 text-primary" />}
        <span className={`truncate text-[11.5px] ${selected ? "font-medium text-primary" : "text-foreground/85"}`}>
          {label}
        </span>
        {langTag && (
          <span className="shrink-0 rounded bg-muted px-1 py-px text-[9px] uppercase text-muted-foreground/70">
            {langTag}
          </span>
        )}
      </div>
      <button
        type="button"
        aria-label={previewTitle}
        title={previewTitle}
        disabled={previewDisabled}
        onClick={(e) => {
          e.stopPropagation();
          onPreview();
        }}
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-30 ${
          samplePlaying
            ? "bg-primary/15 text-primary"
            : "text-muted-foreground/60 hover:bg-accent hover:text-foreground"
        }`}
      >
        {previewPending ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : samplePlaying ? (
          <Square className="h-2.5 w-2.5 fill-current" />
        ) : (
          <Play className="h-3 w-3" />
        )}
      </button>
    </div>
  );
}

/** Tiny toggle matching the chat's dark glass style. */
function MiniSwitch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      className={`relative h-[18px] w-8 shrink-0 rounded-full transition-colors ${
        checked ? "bg-primary" : "bg-muted"
      }`}
    >
      <span
        className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-background shadow transition-all ${
          checked ? "left-[16px]" : "left-[2px]"
        }`}
      />
    </button>
  );
}

/** Three animated bars — the shared "voice is live" glyph. */
function SpeakingBars() {
  return (
    <span className="inline-flex items-end gap-[2px]" aria-hidden="true">
      <style>{"@keyframes yum-eq{0%,100%{transform:scaleY(.3)}50%{transform:scaleY(1)}}"}</style>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="inline-block h-2.5 w-[2px] rounded-full bg-primary/80"
          style={{ animation: `yum-eq 0.9s ease-in-out ${i * 0.18}s infinite`, transformOrigin: "bottom" }}
        />
      ))}
    </span>
  );
}
