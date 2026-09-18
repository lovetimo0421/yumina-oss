import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  Copy,
  Plus,
  Trash2,
  Music,
  Play,
  Square,
  FolderOpen,
  Search,
  Settings2,
  ArrowLeft,
} from "lucide-react";
import { feedback } from "@/lib/feedback";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import { cn } from "@/lib/utils";
import { DOCS_URLS } from "@/lib/docs-urls";
import { resolveAssetUrl } from "@/lib/asset-url";
import { useEditorStore } from "@/stores/editor";
import { AssetPicker } from "../asset-picker";
import { StyledCheckbox } from "../components/styled-checkbox";
import { BgmConfigPanel } from "../components/bgm-config-panel";
import { NumberInput } from "@/components/ui/number-input";
import type { AudioTrack } from "@yumina/engine";
import { TwoTapDeleteButton } from "@/components/ui/two-tap-delete-button";

const TRACK_TYPES: { value: AudioTrack["type"]; labelKey: string; badgeColor: string }[] = [
  { value: "bgm", labelKey: "audio.trackTypes.bgm", badgeColor: "border-border bg-secondary text-muted-foreground" },
  { value: "sfx", labelKey: "audio.trackTypes.sfx", badgeColor: "border-border bg-secondary text-muted-foreground" },
  { value: "ambient", labelKey: "audio.trackTypes.ambient", badgeColor: "border-border bg-secondary text-muted-foreground" },
];

const inputClass =
  "w-full rounded-xl border border-border bg-card px-4 py-2.5 text-[13px] text-foreground shadow-inner focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/50 transition-all [&>option]:bg-popover";

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function AudioSection({ compact, mobileListMode }: { compact?: boolean; mobileListMode?: boolean } = {}) {
  const { t } = useTranslation("editor");
  const worldDraft = useEditorStore(s => s.worldDraft);
  const serverWorldId = useEditorStore(s => s.serverWorldId);
  const saveDraft = useEditorStore(s => s.saveDraft);
  const addAudioTrack = useEditorStore(s => s.addAudioTrack);
  const updateAudioTrack = useEditorStore(s => s.updateAudioTrack);
  const removeAudioTrack = useEditorStore(s => s.removeAudioTrack);

  const audioTracks = worldDraft.audioTracks ?? [];

  const [selectedId, setSelectedId] = useState<string | null>(mobileListMode ? null : audioTracks[0]?.id ?? null);
  const [view, setView] = useState<"track" | "bgm">("track");
  const [searchQuery, setSearchQuery] = useState("");
  const previewRef = useRef<HTMLAudioElement | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [previewTime, setPreviewTime] = useState(0);
  const [previewDuration, setPreviewDuration] = useState(0);
  const [showPicker, setShowPicker] = useState(false);
  const { copied: trackIdCopied, copy: copyTrackId } = useCopyFeedback();

  // Stop the preview audio when leaving the section, otherwise it keeps
  // playing with no visible controls to stop it.
  useEffect(() => {
    return () => {
      previewRef.current?.pause();
      previewRef.current = null;
    };
  }, []);

  const selected = audioTracks.find((t) => t.id === selectedId);

  const showBgmPanel = view === "bgm";

  function selectTrack(id: string | null) {
    setSelectedId(id);
    setView("track");
  }

  function showBgmConfig() {
    setSelectedId(null);
    setView("bgm");
  }

  const filteredTracks = searchQuery.trim()
    ? audioTracks.filter((t) =>
        t.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        t.type.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : audioTracks;

  function stopPreview() {
    previewRef.current?.pause();
    previewRef.current = null;
    setPreviewing(null);
    setPreviewTime(0);
    setPreviewDuration(0);
  }

  async function togglePreview(url: string, trackId: string) {
    if (previewing === trackId) {
      stopPreview();
      return;
    }
    if (previewRef.current) previewRef.current.pause();

    let resolvedUrl = url;
    if (url.startsWith("@asset:")) {
      try {
        resolvedUrl = await resolveAssetUrl(url);
      } catch {
        return;
      }
    }

    const audio = new Audio(resolvedUrl);
    audio.volume = 0.5;
    // Guard every listener: a stale audio element (replaced by a newer
    // preview) must not keep driving the UI state.
    audio.addEventListener("loadedmetadata", () => {
      if (previewRef.current === audio) {
        setPreviewDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
      }
    });
    audio.addEventListener("timeupdate", () => {
      if (previewRef.current === audio) setPreviewTime(audio.currentTime);
    });
    audio.addEventListener("ended", () => {
      if (previewRef.current === audio) stopPreview();
    });
    audio.play().catch(() => {});
    previewRef.current = audio;
    setPreviewing(trackId);
    setPreviewTime(0);
    setPreviewDuration(0);
  }

  function seekPreview(seconds: number) {
    const audio = previewRef.current;
    if (!audio) return;
    audio.currentTime = seconds;
    setPreviewTime(seconds);
  }

  function handleAddTrack() {
    addAudioTrack();
    // If the user is currently configuring BGM, keep them there — the new
    // track appears in the playlist's track list immediately. Otherwise
    // open the new track's detail so they can fill in name/url.
    if (view === "bgm") return;
    const tracks = useEditorStore.getState().worldDraft.audioTracks ?? [];
    selectTrack(tracks[tracks.length - 1]?.id ?? null);
  }

  function handleDeleteTrack(id: string) {
    if (previewing === id) stopPreview();
    const tracks = worldDraft.audioTracks ?? [];
    const idx = tracks.findIndex((t) => t.id === id);
    removeAudioTrack(id);
    const remaining = useEditorStore.getState().worldDraft.audioTracks ?? [];
    const nextIdx = Math.min(idx, remaining.length - 1);
    selectTrack(nextIdx >= 0 ? remaining[nextIdx]?.id ?? null : null);
  }

  return (
    <div className="@container flex min-h-0 flex-1 flex-col">
      {/* ── Header (full editor only) ── */}
      {!compact && (
        <div className="shrink-0 border-b border-border bg-card px-6 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="max-w-xl">
              <h1 className="text-[22px] font-bold text-foreground tracking-tight">{t("audio.title")}</h1>
              <p className="mt-0.5 text-xs text-muted-foreground leading-relaxed">
                {t("audio.description")}{" "}
                <a href={DOCS_URLS.audio} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{t("audio.learnMore")}</a>
              </p>
            </div>
            <button
              onClick={handleAddTrack}
              data-tour="audio-add"
              className="flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-[0_0_15px_hsl(var(--primary)/0.3)] transition-colors hover:bg-primary/90"
            >
              <Plus className="h-3.5 w-3.5" />
              {t("audio.addTrack")}
            </button>
          </div>
        </div>
      )}

      {/* ── Body: two-panel ── */}
      <div className="flex flex-col @[640px]:flex-row flex-1 min-h-0">
        {/* Left list */}
        <div className={cn(
          "w-full @[640px]:w-80 @[640px]:shrink-0 flex flex-col border-b @[640px]:border-b-0 @[640px]:border-r border-border bg-sidebar",
          (selected || showBgmPanel) && "hidden @[640px]:flex"
        )}>
          {/* Search + compact actions */}
          <div className={cn("border-b border-border", compact ? "px-3 py-2" : "p-5")}>
            <div className={cn(compact && "flex items-center gap-2")}>
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/40" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t("audio.searchPlaceholder")}
                  className="w-full rounded-xl border border-border bg-card py-2.5 pl-9 pr-4 text-sm text-foreground shadow-inner placeholder:text-muted-foreground/40 focus:border-primary/50 focus:outline-none transition-all"
                />
              </div>
              {compact && (
                <button
                  onClick={handleAddTrack}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* Track cards */}
          <div className="flex flex-col gap-2 p-5 overflow-y-auto">
            {/* World-level BGM config entry — pinned at top of list */}
            <button
              onClick={showBgmConfig}
              className={cn(
                "mb-1 flex items-center gap-3 rounded-xl border p-3.5 text-left transition-all",
                showBgmPanel
                  ? "border-primary/30 bg-primary/[0.06] shadow-[0_0_15px_hsl(var(--primary)/0.08)]"
                  : "border-dashed border-border/60 hover:border-border hover:bg-accent/40"
              )}
            >
              <div
                className={cn(
                  "shrink-0 rounded-lg p-1.5",
                  showBgmPanel ? "bg-primary/15 text-primary" : "bg-muted/40 text-muted-foreground"
                )}
              >
                <Settings2 className="h-3.5 w-3.5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className={cn(
                  "text-sm font-bold truncate",
                  showBgmPanel ? "text-primary" : "text-foreground"
                )}>
                  {t("audio.bgmConfigTitle")}
                </div>
                <div className="text-[11px] text-muted-foreground/60 truncate">
                  {t("audio.bgmConfigSubtitle")}
                </div>
              </div>
            </button>

            {audioTracks.length === 0 && (
              <div className="rounded-xl border border-dashed border-border py-12 text-center">
                <Music className="mx-auto h-8 w-8 text-muted-foreground/20" />
                <p className="mt-2 text-sm text-muted-foreground/40">{t("audio.noTracks")}</p>
                <p className="mt-1.5 max-w-xs mx-auto text-xs text-muted-foreground/30">{t("audio.noTracksDesc")}</p>
                <a href={DOCS_URLS.audio} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-xs text-primary hover:underline">{t("audio.learnMore")}</a>
              </div>
            )}
            {filteredTracks.map((track) => {
              const typeInfo = TRACK_TYPES.find((t) => t.value === track.type);
              const isActive = view === "track" && selectedId === track.id;
              return (
                <button
                  key={track.id}
                  onClick={() => selectTrack(track.id)}
                  className={cn(
                    "flex items-center gap-3 rounded-xl p-3.5 text-left transition-all",
                    isActive
                      ? "border border-primary/30 bg-primary/[0.06] shadow-[0_0_15px_hsl(var(--primary)/0.08)]"
                      : "border border-transparent hover:bg-accent/50"
                  )}
                >
                  <div
                    className={cn(
                      "shrink-0 rounded px-2 py-0.5 text-[10px] font-bold border",
                      typeInfo?.badgeColor ?? ""
                    )}
                  >
                    {typeInfo ? t(typeInfo.labelKey as any) : track.type.toUpperCase()}
                  </div>
                  <span
                    className={cn(
                      "flex-1 truncate text-sm font-bold",
                      isActive ? "text-primary" : "text-foreground"
                    )}
                  >
                    {track.name || t("audio.unnamed")}
                  </span>
                </button>
              );
            })}
            {filteredTracks.length === 0 && audioTracks.length > 0 && searchQuery && (
              <p className="px-3 py-2 text-xs text-muted-foreground/40">
                {t("audio.noTracksMatch", { query: searchQuery })}
              </p>
            )}
          </div>
        </div>

        {/* Right editor */}
        <div className={cn(
          "flex-1 overflow-y-auto min-w-0",
          !selected && !showBgmPanel && "hidden @[640px]:flex"
        )}>
          {showBgmPanel ? (
            <BgmConfigPanel />
          ) : selected ? (
            <div className="p-8 lg:p-12">
              {/* Back button — narrow mode only */}
              <button
                onClick={() => selectTrack(null)}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground @[640px]:hidden mb-4"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                {t("audio.back")}
              </button>
              <div className="mx-auto max-w-3xl space-y-6">
                {/* Track Name & Delete */}
                <div className="flex items-center gap-4">
                  <div className="flex-1 space-y-1.5">
                    <label className="text-[13px] font-bold text-foreground">{t("audio.trackTitle")}</label>
                    <input
                      type="text"
                      value={selected.name}
                      onChange={(e) => updateAudioTrack(selected.id, { name: e.target.value })}
                      placeholder={t("audio.trackTitlePlaceholder")}
                      className={cn(inputClass, "font-bold")}
                    />
                  </div>
                  <TwoTapDeleteButton
                    onConfirm={() => handleDeleteTrack(selected.id)}
                    className="flex items-center gap-2 rounded-xl px-3 py-2 text-[13px] font-medium text-destructive transition-colors hover:bg-destructive/10 mt-6"
                    armedChildren={<><Trash2 className="h-3.5 w-3.5" />{t("twoTapConfirm")}</>}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {t("audio.delete")}
                  </TwoTapDeleteButton>
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="audio-track-id" className="text-[13px] font-bold text-foreground">{t("audio.trackId")}</label>
                  <div className="flex min-w-0 items-center gap-2">
                    <input id="audio-track-id" readOnly value={selected.id} className={cn(inputClass, "min-w-0 flex-1 font-mono")} onFocus={(e) => e.target.select()} />
                    <button type="button" aria-label={t("audio.copyTrackId")} title={t("audio.copyTrackId")}
                      className="shrink-0 rounded-xl border border-border p-3 text-muted-foreground hover:bg-accent hover:text-foreground"
                      onClick={async () => {
                        if (!(await copyTrackId(selected.id))) feedback.error(t("audio.trackIdCopyFailed"));
                      }}>
                      {trackIdCopied ? <Check className="h-4 w-4 text-primary" /> : <Copy className="h-4 w-4" />}
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground">{t("audio.trackIdHelp")}</p>
                  <code className="block break-all text-xs text-muted-foreground">{`api.playAudio(${JSON.stringify(selected.id)})`}</code>
                </div>

                {/* ── Audio Source ── */}
                <div className="rounded-2xl border border-border bg-card p-6">
                  <h3 className="text-[15px] font-bold text-foreground tracking-wide mb-4">
                    {t("audio.audioSource")}
                  </h3>

                  <div className="space-y-5">
                    <div className="space-y-1.5">
                      <label className="text-[12px] font-bold text-foreground">
                        {t("audio.urlLabel")}
                      </label>
                      <input
                        type="text"
                        value={selected.url}
                        onChange={(e) => updateAudioTrack(selected.id, { url: e.target.value })}
                        placeholder={t("audio.urlPlaceholder")}
                        className={inputClass}
                      />
                      <button
                        onClick={async () => {
                          if (!serverWorldId) {
                            await saveDraft();
                            if (!useEditorStore.getState().serverWorldId) return;
                          }
                          setShowPicker(true);
                        }}
                        className="flex w-full items-center justify-center gap-2.5 rounded-xl border-2 border-dashed border-primary/40 bg-primary/10 px-4 py-3.5 text-sm font-semibold text-primary transition-colors hover:border-primary/60 hover:bg-primary/20"
                      >
                        <FolderOpen className="h-5 w-5" />
                        {t("audio.browseAssets")}
                      </button>
                    </div>

                    {/* Preview player */}
                    {selected.url && (
                      <div className="flex items-center gap-3 rounded-xl border border-border bg-accent/30 p-3">
                        <button
                          onClick={() => togglePreview(selected.url, selected.id)}
                          className="text-primary"
                        >
                          {previewing === selected.id ? (
                            <Square className="h-4 w-4" />
                          ) : (
                            <Play className="h-4 w-4" />
                          )}
                        </button>
                        <input
                          type="range"
                          min={0}
                          max={previewing === selected.id && previewDuration > 0 ? previewDuration : 1}
                          step={0.1}
                          value={previewing === selected.id ? previewTime : 0}
                          disabled={previewing !== selected.id || previewDuration <= 0}
                          onChange={(e) => seekPreview(parseFloat(e.target.value))}
                          className="min-w-0 flex-1 accent-primary disabled:opacity-40"
                          aria-label={t("audio.preview")}
                        />
                        <span className="shrink-0 text-[12px] text-muted-foreground font-medium tabular-nums">
                          {previewing === selected.id
                            ? `${formatTime(previewTime)} / ${previewDuration > 0 ? formatTime(previewDuration) : "--:--"}`
                            : t("audio.preview")}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                {/* ── Playback Settings ── */}
                <div className="rounded-2xl border border-border bg-card p-6">
                  <h3 className="text-[15px] font-bold text-foreground tracking-wide mb-6">
                    {t("audio.playbackSettings")}
                  </h3>

                  <div className="space-y-6">
                    <div className="space-y-2">
                      <label className="flex cursor-pointer items-center gap-2 text-sm font-bold text-foreground">
                        <input
                          type="checkbox"
                          checked={selected.allowAiControl !== false}
                          onChange={(e) => updateAudioTrack(selected.id, { allowAiControl: e.target.checked })}
                          className="h-5 w-5 shrink-0 accent-primary"
                        />
                        {t("audio.allowAiControl")}
                      </label>
                      <p className="text-xs leading-relaxed text-muted-foreground">{t("audio.allowAiControlHelp")}</p>
                    </div>
                    {/* Track Type */}
                    <div className="flex items-center justify-between">
                      <h4 className="text-[13px] font-bold text-foreground">{t("audio.trackType")}</h4>
                      <div className="flex rounded-lg border border-border bg-accent/30 p-1">
                        {TRACK_TYPES.map((tt) => (
                          <button
                            key={tt.value}
                            onClick={() => updateAudioTrack(selected.id, { type: tt.value })}
                            className={cn(
                              "rounded-md px-4 py-1.5 text-xs font-bold transition-colors",
                              selected.type === tt.value
                                ? "bg-primary text-primary-foreground"
                                : "text-muted-foreground hover:text-foreground"
                            )}
                          >
                            {t(tt.labelKey as any)}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Volume + Loop — single column on mobile: a range input has
                        a UA minimum width it refuses to shrink below, so a forced
                        2-up grid makes the volume cell overflow and the "100%"
                        readout collide with the Loop Audio label. */}
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-8 sm:items-center">
                      <div className="min-w-0 space-y-2">
                        <label className="text-[13px] font-bold text-foreground">
                          {t("audio.defaultVolume")}
                        </label>
                        <div className="flex items-center gap-3">
                          <span className="shrink-0 text-[11px] text-muted-foreground">0%</span>
                          <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.05}
                            value={selected.volume ?? 1}
                            onChange={(e) =>
                              updateAudioTrack(selected.id, {
                                volume: parseFloat(e.target.value),
                              })
                            }
                            className="min-w-0 flex-1 accent-primary"
                          />
                          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                            {Math.round((selected.volume ?? 1) * 100)}%
                          </span>
                        </div>
                      </div>

                      <div className="sm:mt-6">
                        <StyledCheckbox
                          checked={selected.loop ?? false}
                          onChange={(v) => updateAudioTrack(selected.id, { loop: v })}
                          label={t("audio.loopAudio")}
                        />
                      </div>
                    </div>

                    {/* Fade In/Out */}
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6 pt-2">
                      <div className="space-y-2 flex max-w-[200px] flex-col">
                        <label className="text-[13px] font-bold text-foreground">
                          {t("audio.fadeIn")}
                        </label>
                        <NumberInput
                          min={0}
                          step={0.5}
                          value={selected.fadeIn ?? 0}
                          onChange={(val) =>
                            updateAudioTrack(selected.id, {
                              fadeIn: val === "" ? 0 : val,
                            })
                          }
                        />
                      </div>
                      <div className="space-y-2 flex max-w-[200px] flex-col">
                        <label className="text-[13px] font-bold text-foreground">
                          {t("audio.fadeOut")}
                        </label>
                        <NumberInput
                          min={0}
                          step={0.5}
                          value={selected.fadeOut ?? 0}
                          onChange={(val) =>
                            updateAudioTrack(selected.id, {
                              fadeOut: val === "" ? 0 : val,
                            })
                          }
                        />
                      </div>
                    </div>
                  </div>
                </div>

                <div className="pb-20" />
              </div>
            </div>
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <p className="text-sm text-muted-foreground/40">
                {audioTracks.length === 0
                  ? t("audio.emptyNoTracks")
                  : t("audio.emptySelectTrack")}
              </p>
            </div>
          )}
        </div>
      </div>

      {showPicker && (serverWorldId || useEditorStore.getState().serverWorldId) && selected && (
        <AssetPicker
          worldId={(serverWorldId || useEditorStore.getState().serverWorldId)!}
          filterType="audio"
          onSelect={(ref) => {
            updateAudioTrack(selected.id, { url: ref });
            setShowPicker(false);
          }}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  );
}
