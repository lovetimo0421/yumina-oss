import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  Check,
  Copy,
  FolderOpen,
  Images,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { feedback } from "@/lib/feedback";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import { cn } from "@/lib/utils";
import { resolveImageUrl } from "@/lib/asset-url";
import { DOCS_URLS } from "@/lib/docs-urls";
import { useEditorStore } from "@/stores/editor";
import { uploadSceneImageFiles } from "./scene-image-upload";
import { isSceneImageAuto, useSceneImageMode, type SceneImageMode } from "./scene-image-auto";
import { AssetPicker } from "../asset-picker";
import { StyledCheckbox } from "../components/styled-checkbox";
import { TwoTapDeleteButton } from "@/components/ui/two-tap-delete-button";
import { sceneImageEmbed } from "@yumina/engine";

const SCENE_MAX = 200;
const HINT_MAX = 80;

const inputClass =
  "w-full rounded-xl border border-border bg-card px-4 py-2.5 text-[13px] text-foreground shadow-inner focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/50 transition-all";

function Thumb({ url, className }: { url: string; className?: string }) {
  const src = url ? resolveImageUrl(url) : undefined;
  return (
    <div className={cn("shrink-0 overflow-hidden rounded-lg border border-border bg-muted/40", className)}>
      {src ? (
        <img src={src} alt="" className="h-full w-full object-cover" loading="lazy" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-muted-foreground/30">
          <Images className="h-4 w-4" />
        </div>
      )}
    </div>
  );
}

/**
 * Who places the card's images — one choice for the whole card, above the
 * list so it is read before any single image. Both options stay described so
 * the author compares them rather than guessing what the other one does.
 */
function SceneImageModeChoice({ compact, autoCount, total }: { compact?: boolean; autoCount: number; total: number }) {
  const { t } = useTranslation("editor");
  const { mode, locked, setMode } = useSceneImageMode();
  const options: Array<{ value: SceneImageMode; title: string; help: string; recommended?: boolean }> = [
    { value: "judge", title: t("sceneImages.modeJudge"), help: t("sceneImages.modeJudgeHelp"), recommended: true },
    { value: "narrator", title: t("sceneImages.modeNarrator"), help: t("sceneImages.modeNarratorHelp") },
  ];
  return (
    <div className={cn("space-y-2.5 border-b border-border", compact ? "px-3 py-3" : "px-5 py-4")}>
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
        <h3 className="whitespace-nowrap text-xs font-bold text-foreground">{t("sceneImages.modeTitle")}</h3>
        <span className={cn("flex items-center gap-1 whitespace-nowrap text-[11px] tabular-nums", autoCount > 0 ? "text-primary" : "text-muted-foreground/60")}>
          <Sparkles className="h-3 w-3" />
          {t("sceneImages.autoCount", { on: autoCount, total })}
        </span>
      </div>
      {locked ? (
        <p className="rounded-xl border border-border bg-card px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
          {t("sceneImages.modeLocked")}
        </p>
      ) : (
        <div role="radiogroup" aria-label={t("sceneImages.modeTitle")} className="space-y-1.5">
          {options.map((o) => {
            const on = mode === o.value;
            return (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setMode(o.value)}
                className={cn(
                  "w-full rounded-xl border px-3 py-2.5 text-left transition-colors",
                  on ? "border-primary/40 bg-primary/[0.06]" : "border-border bg-card hover:bg-accent/50",
                )}
              >
                <span className="flex items-center gap-2">
                  <span className={cn("flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border", on ? "border-primary" : "border-muted-foreground/40")}>
                    {on && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}
                  </span>
                  <span className={cn("text-[13px] font-semibold", on ? "text-foreground" : "text-foreground/80")}>{o.title}</span>
                  {o.recommended && (
                    <span className="rounded-full bg-primary/10 px-1.5 py-px text-[10px] font-bold text-primary">{t("sceneImages.modeRecommended")}</span>
                  )}
                </span>
                <span className="mt-1 block pl-[22px] text-[11px] leading-relaxed text-muted-foreground">{o.help}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Scene images — pictures the author registers with a one-line "when to show
 * it" description. By default the continuity judge picks one after each reply
 * by that sentence; a card can hand them to the story model instead, which
 * writes `[image: id]` itself. Either way the server expands the handle into
 * the shared embed syntax. Mirrors the Audio section's list + detail layout,
 * down to the "when" sentence being the image's only on/off switch.
 */
export function SceneImagesSection({ compact, mobileListMode }: { compact?: boolean; mobileListMode?: boolean } = {}) {
  const { t } = useTranslation("editor");
  const worldDraft = useEditorStore((s) => s.worldDraft);
  const serverWorldId = useEditorStore((s) => s.serverWorldId);
  const saveDraft = useEditorStore((s) => s.saveDraft);
  const addSceneImage = useEditorStore((s) => s.addSceneImage);
  const updateSceneImage = useEditorStore((s) => s.updateSceneImage);
  const { mode } = useSceneImageMode();
  const removeSceneImage = useEditorStore((s) => s.removeSceneImage);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadState, setUploadState] = useState<{ done: number; total: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const sceneImages = worldDraft.sceneImages ?? [];
  const greetings = worldDraft.entries.filter((e) => e.role === "greeting");

  const [selectedId, setSelectedId] = useState<string | null>(mobileListMode ? null : sceneImages[0]?.id ?? null);
  const [searchQuery, setSearchQuery] = useState("");
  const [showPicker, setShowPicker] = useState(false);
  const { copied: idCopied, copy: copyId } = useCopyFeedback();
  const { copied: codeCopied, copy: copyCode } = useCopyFeedback();

  const selected = sceneImages.find((img) => img.id === selectedId);

  const filtered = searchQuery.trim()
    ? sceneImages.filter((img) => {
        const q = searchQuery.toLowerCase();
        return (
          img.name.toLowerCase().includes(q) ||
          img.scene.toLowerCase().includes(q) ||
          img.id.toLowerCase().includes(q)
        );
      })
    : sceneImages;

  function handleAdd() {
    addSceneImage();
    const list = useEditorStore.getState().worldDraft.sceneImages ?? [];
    setSelectedId(list[list.length - 1]?.id ?? null);
  }

  function handleDelete(id: string) {
    const idx = sceneImages.findIndex((img) => img.id === id);
    removeSceneImage(id);
    const remaining = useEditorStore.getState().worldDraft.sceneImages ?? [];
    const nextIdx = Math.min(idx, remaining.length - 1);
    setSelectedId(nextIdx >= 0 ? remaining[nextIdx]?.id ?? null : null);
  }

  async function ensureWorldId(): Promise<string | null> {
    if (serverWorldId) return serverWorldId;
    await saveDraft();
    return useEditorStore.getState().serverWorldId;
  }

  async function openPicker() {
    if (!(await ensureWorldId())) return;
    setShowPicker(true);
  }

  async function handleFiles(files: FileList | File[]) {
    const targetId = await uploadSceneImageFiles({
      files,
      selectedId: selected?.id ?? null,
      onProgress: (done, total) => setUploadState({ done, total }),
      onFailed: (name) => feedback.error(t("sceneImages.uploadFailed", { name })),
    });
    if (targetId) setSelectedId(targetId);
    setUploadState(null);
  }

  const dropProps = {
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); setDragOver(true); },
    onDragLeave: () => setDragOver(false),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      void handleFiles(e.dataTransfer.files);
    },
  };

  const scopeIds = selected?.greetingIds ?? [];
  const scopeAll = scopeIds.length === 0;

  function toggleGreeting(greetingId: string) {
    if (!selected) return;
    const next = scopeIds.includes(greetingId)
      ? scopeIds.filter((g) => g !== greetingId)
      : [...scopeIds, greetingId];
    updateSceneImage(selected.id, { greetingIds: next.length > 0 ? next : undefined });
  }

  return (
    <div className="@container flex min-h-0 flex-1 flex-col">
      {!compact && (
        <div className="shrink-0 border-b border-border bg-card px-6 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="max-w-xl">
              <h1 className="text-[22px] font-bold tracking-tight text-foreground">{t("sceneImages.title")}</h1>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {t("sceneImages.description")}{" "}
                <a href={DOCS_URLS.sceneImages} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{t("sceneImages.learnMore")}</a>
              </p>
            </div>
            <button
              onClick={handleAdd}
              className="flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-[0_0_15px_hsl(var(--primary)/0.3)] transition-colors hover:bg-primary/90"
            >
              <Plus className="h-3.5 w-3.5" />
              {t("sceneImages.addImage")}
            </button>
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col @[640px]:flex-row">
        {/* Left list */}
        <div
          className={cn(
            "flex w-full flex-col border-b border-border bg-sidebar @[640px]:w-80 @[640px]:shrink-0 @[640px]:border-b-0 @[640px]:border-r",
            selected && "hidden @[640px]:flex",
          )}
        >
          <div className={cn("border-b border-border", compact ? "px-3 py-2" : "p-5")}>
            <div className={cn(compact && "flex items-center gap-2")}>
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/40" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t("sceneImages.searchPlaceholder")}
                  className="w-full rounded-xl border border-border bg-card py-2.5 pl-9 pr-4 text-sm text-foreground shadow-inner transition-all placeholder:text-muted-foreground/40 focus:border-primary/50 focus:outline-none"
                />
              </div>
              {compact && (
                <button
                  onClick={handleAdd}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>

          {sceneImages.length > 0 && (
            <SceneImageModeChoice compact={compact} autoCount={sceneImages.filter(isSceneImageAuto).length} total={sceneImages.length} />
          )}

          <div
            {...dropProps}
            className={cn(
              "flex flex-col gap-2 overflow-y-auto p-5 transition-colors",
              dragOver && "bg-primary/[0.06] ring-2 ring-inset ring-primary/40",
            )}
          >
            {sceneImages.length === 0 && (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="rounded-xl border border-dashed border-border py-12 text-center transition-colors hover:border-primary/50 hover:bg-primary/[0.04]"
              >
                <Images className="mx-auto h-8 w-8 text-muted-foreground/20" />
                <p className="mt-2 text-sm text-muted-foreground/40">{t("sceneImages.noImages")}</p>
                <p className="mx-auto mt-1.5 max-w-xs text-xs text-muted-foreground/30">{t("sceneImages.noImagesDesc")}</p>
                <span className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-primary">
                  <Upload className="h-3.5 w-3.5" />
                  {t("sceneImages.uploadFiles")}
                </span>
              </button>
            )}
            {filtered.map((img) => {
              const isActive = selectedId === img.id;
              return (
                <button
                  key={img.id}
                  onClick={() => setSelectedId(img.id)}
                  className={cn(
                    "flex items-center gap-3 rounded-xl p-3 text-left transition-all",
                    isActive
                      ? "border border-primary/30 bg-primary/[0.06] shadow-[0_0_15px_hsl(var(--primary)/0.08)]"
                      : "border border-transparent hover:bg-accent/50",
                  )}
                >
                  <Thumb url={img.url} className="h-12 w-12" />
                  <div className="min-w-0 flex-1">
                    <div className={cn("truncate text-sm font-bold", isActive ? "text-primary" : "text-foreground")}>
                      {img.name || t("sceneImages.unnamed")}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground/60">
                      <span className="font-mono">{img.id}</span>
                      {img.scene ? ` · ${img.scene}` : ""}
                    </div>
                  </div>
                  {isSceneImageAuto(img) && (
                    <span title={t("sceneImages.autoBadgeTitle")} className="flex shrink-0 items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] font-bold text-primary">
                      <Sparkles className="h-3 w-3" />
                      AI
                    </span>
                  )}
                </button>
              );
            })}
            {filtered.length === 0 && sceneImages.length > 0 && searchQuery && (
              <p className="px-3 py-2 text-xs text-muted-foreground/40">{t("sceneImages.noImagesMatch", { query: searchQuery })}</p>
            )}
            {sceneImages.length > 0 && (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="mt-1 flex items-center justify-center gap-2 rounded-xl border border-dashed border-border/70 px-3 py-3 text-xs text-muted-foreground/60 transition-colors hover:border-primary/50 hover:text-primary"
              >
                <Upload className="h-3.5 w-3.5" />
                {uploadState ? t("sceneImages.uploading", uploadState) : t("sceneImages.dropHint")}
              </button>
            )}
          </div>
        </div>

        {/* Right editor */}
        <div className={cn("min-w-0 flex-1 overflow-y-auto", !selected && "hidden @[640px]:flex")}>
          {selected ? (
            <div className="p-8 lg:p-12">
              <button
                onClick={() => setSelectedId(null)}
                className="mb-4 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground @[640px]:hidden"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                {t("sceneImages.back")}
              </button>
              <div className="mx-auto max-w-3xl space-y-6">
                {/* Name + delete */}
                <div className="flex items-center gap-4">
                  <div className="flex-1 space-y-1.5">
                    <label className="text-[13px] font-bold text-foreground">{t("sceneImages.nameLabel")}</label>
                    <input
                      type="text"
                      value={selected.name}
                      onChange={(e) => updateSceneImage(selected.id, { name: e.target.value })}
                      placeholder={t("sceneImages.namePlaceholder")}
                      className={cn(inputClass, "font-bold")}
                    />
                  </div>
                  <TwoTapDeleteButton
                    onConfirm={() => handleDelete(selected.id)}
                    className="mt-6 flex items-center gap-2 rounded-xl px-3 py-2 text-[13px] font-medium text-destructive transition-colors hover:bg-destructive/10"
                    armedChildren={<><Trash2 className="h-3.5 w-3.5" />{t("twoTapConfirm")}</>}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {t("sceneImages.delete")}
                  </TwoTapDeleteButton>
                </div>

                {/* Image source */}
                <div className="rounded-2xl border border-border bg-card p-6">
                  <h3 className="mb-4 text-[15px] font-bold tracking-wide text-foreground">{t("sceneImages.imageSource")}</h3>
                  <div className="flex flex-col gap-5 sm:flex-row">
                    <Thumb url={selected.url} className="h-40 w-40 sm:shrink-0" />
                    <div className="flex-1 space-y-3">
                      <div className="space-y-1.5">
                        <label className="text-[12px] font-bold text-foreground">{t("sceneImages.urlLabel")}</label>
                        <input
                          type="text"
                          value={selected.url}
                          onChange={(e) => updateSceneImage(selected.id, { url: e.target.value })}
                          placeholder={t("sceneImages.urlPlaceholder")}
                          className={inputClass}
                        />
                      </div>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <button
                          onClick={() => fileInputRef.current?.click()}
                          className="flex items-center justify-center gap-2.5 rounded-xl border-2 border-dashed border-primary/40 bg-primary/10 px-4 py-3.5 text-sm font-semibold text-primary transition-colors hover:border-primary/60 hover:bg-primary/20"
                        >
                          <Upload className="h-5 w-5" />
                          {uploadState ? t("sceneImages.uploading", uploadState) : t("sceneImages.uploadFiles")}
                        </button>
                        <button
                          onClick={openPicker}
                          className="flex items-center justify-center gap-2.5 rounded-xl border-2 border-dashed border-border px-4 py-3.5 text-sm font-semibold text-foreground transition-colors hover:border-primary/50 hover:bg-accent"
                        >
                          <FolderOpen className="h-5 w-5" />
                          {t("sceneImages.browseAssets")}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                {/* ── AI auto-show ── the "when" sentence is the whole switch,
                    as on the Audio page: written = the image can appear on its
                    own, empty = only where its code is pasted. */}
                {(() => {
                  const auto = isSceneImageAuto(selected);
                  const held = selected.allowAiControl === false;
                  const hasCue = Boolean(selected.scene.trim());
                  const status = held
                    ? t("sceneImages.autoHeld")
                    : auto
                      ? t("sceneImages.autoOn")
                      : hasCue
                        ? t("sceneImages.autoNoPicture")
                        : t("sceneImages.autoOff");
                  return (
                    <div className={cn("rounded-2xl border p-6 transition-colors", auto ? "border-primary/40 bg-primary/[0.06]" : "border-border bg-card")}>
                      <div className="flex items-center gap-2">
                        <Sparkles className={cn("h-4 w-4", auto ? "text-primary" : "text-muted-foreground")} />
                        <h3 className="text-[15px] font-bold tracking-wide text-foreground">{t("sceneImages.allowAi")}</h3>
                      </div>
                      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                        {t(mode === "judge" ? "sceneImages.autoHelpJudge" : "sceneImages.autoHelpNarrator")}
                      </p>
                      <label htmlFor="scene-image-scene" className="mt-4 block text-[13px] font-bold text-foreground">{t("sceneImages.sceneLabel")}</label>
                      <textarea
                        id="scene-image-scene"
                        value={selected.scene}
                        maxLength={SCENE_MAX}
                        onChange={(e) => updateSceneImage(selected.id, { scene: e.target.value })}
                        placeholder={t("sceneImages.scenePlaceholder")}
                        rows={3}
                        className={cn(inputClass, "mt-1.5 resize-y")}
                      />
                      <div className="mt-1 flex items-start justify-between gap-3">
                        <p className={cn("text-xs leading-relaxed", auto ? "text-primary" : "text-muted-foreground/70")}>
                          {status}
                          {held && (
                            <button
                              type="button"
                              onClick={() => updateSceneImage(selected.id, { allowAiControl: undefined })}
                              className="ml-1.5 font-semibold text-primary hover:underline"
                            >
                              {t("sceneImages.autoReenable")}
                            </button>
                          )}
                        </p>
                        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60">
                          {selected.scene.length}/{SCENE_MAX}
                        </span>
                      </div>
                    </div>
                  );
                })()}

                {/* Gallery hint + openings */}
                <div className="rounded-2xl border border-border bg-card p-6">
                  <div className="space-y-6">
                    <div className="space-y-1.5">
                      <label className="text-[13px] font-bold text-foreground">{t("sceneImages.hintLabel")}</label>
                      <p className="text-xs leading-relaxed text-muted-foreground">{t("sceneImages.hintHelp")}</p>
                      <input
                        type="text"
                        value={selected.hint ?? ""}
                        maxLength={HINT_MAX}
                        onChange={(e) => updateSceneImage(selected.id, { hint: e.target.value || undefined })}
                        placeholder={t("sceneImages.hintPlaceholder")}
                        className={inputClass}
                      />
                      <div className="text-right text-[11px] tabular-nums text-muted-foreground/60">
                        {(selected.hint ?? "").length}/{HINT_MAX}
                      </div>
                    </div>

                    <div className="space-y-2">
                      <h4 className="text-[13px] font-bold text-foreground">{t("sceneImages.scopeLabel")}</h4>
                      <p className="text-xs leading-relaxed text-muted-foreground">{t("sceneImages.scopeHelp")}</p>
                      {greetings.length === 0 ? (
                        <p className="text-xs text-muted-foreground/60">{t("sceneImages.scopeNoGreetings")}</p>
                      ) : (
                        <div className="space-y-2 pt-1">
                          <StyledCheckbox
                            checked={scopeAll}
                            onChange={(v) => {
                              if (v) updateSceneImage(selected.id, { greetingIds: undefined });
                              else if (greetings[0]) updateSceneImage(selected.id, { greetingIds: [greetings[0].id] });
                            }}
                            label={t("sceneImages.scopeAll")}
                          />
                          {!scopeAll && (
                            <div className="ml-6 space-y-1.5">
                              {greetings.map((g, i) => (
                                <StyledCheckbox
                                  key={g.id}
                                  checked={scopeIds.includes(g.id)}
                                  onChange={() => toggleGreeting(g.id)}
                                  label={g.name || t("sceneImages.greetingFallback", { index: i + 1 })}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Id + copy code */}
                <div className="space-y-1.5">
                  <label htmlFor="scene-image-id" className="text-[13px] font-bold text-foreground">{t("sceneImages.idLabel")}</label>
                  <div className="flex min-w-0 items-center gap-2">
                    <input id="scene-image-id" readOnly value={selected.id} className={cn(inputClass, "min-w-0 flex-1 font-mono")} onFocus={(e) => e.target.select()} />
                    <button
                      type="button"
                      aria-label={t("sceneImages.copyId")}
                      title={t("sceneImages.copyId")}
                      className="shrink-0 rounded-xl border border-border p-3 text-muted-foreground hover:bg-accent hover:text-foreground"
                      onClick={async () => {
                        if (!(await copyId(selected.id))) feedback.error(t("sceneImages.copyFailed"));
                      }}
                    >
                      {idCopied ? <Check className="h-4 w-4 text-primary" /> : <Copy className="h-4 w-4" />}
                    </button>
                    <button
                      type="button"
                      disabled={!selected.url}
                      className="flex shrink-0 items-center gap-1.5 rounded-xl border border-border px-3 py-3 text-xs font-semibold text-foreground hover:bg-accent disabled:opacity-40"
                      onClick={async () => {
                        if (!(await copyCode(sceneImageEmbed(selected)))) feedback.error(t("sceneImages.copyFailed"));
                      }}
                    >
                      {codeCopied ? <Check className="h-3.5 w-3.5 text-primary" /> : <Copy className="h-3.5 w-3.5" />}
                      {t("sceneImages.copyCode")}
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground">{t("sceneImages.idHelp")}</p>
                </div>

                <div className="pb-20" />
              </div>
            </div>
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <p className="text-sm text-muted-foreground/40">
                {sceneImages.length === 0 ? t("sceneImages.emptyNoImages") : t("sceneImages.emptySelect")}
              </p>
            </div>
          )}
        </div>
      </div>

      <input
        ref={fileInputRef}
        id="scene-image-files"
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) void handleFiles(e.target.files);
          e.target.value = "";
        }}
      />

      {showPicker && (serverWorldId || useEditorStore.getState().serverWorldId) && selected && (
        <AssetPicker
          worldId={(serverWorldId || useEditorStore.getState().serverWorldId)!}
          filterType="image"
          onSelect={(ref) => {
            updateSceneImage(selected.id, { url: ref });
            setShowPicker(false);
          }}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  );
}
