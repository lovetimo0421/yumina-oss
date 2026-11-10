import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ImageIcon, Plus, Trash2, Upload } from "lucide-react";
import { COVER_BACKGROUND_URL, DEFAULT_BACKGROUND_BLUR, DEFAULT_BACKGROUND_DIM, DEFAULT_BACKGROUND_OPACITY } from "@yumina/engine";
import type { BackgroundImage } from "@yumina/engine";
import { cn } from "@/lib/utils";
import { resolveImageUrl } from "@/lib/asset-url";
import { useEditorStore } from "@/stores/editor";
import { useAssetStore } from "@/stores/assets";
import { StyledCheckbox } from "../components/styled-checkbox";
import { TwoTapDeleteButton } from "@/components/ui/two-tap-delete-button";

const SCENE_MAX = 200;

const inputClass =
  "w-full rounded-xl border border-border bg-card px-4 py-2.5 text-[13px] text-foreground shadow-inner focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/50 transition-all";

/** The sentence painted over the preview. Long enough to show what a real
 *  paragraph does to legibility, which a single word would not. */
const PREVIEW_SENTENCE_KEY = "backgrounds.previewSentence";

function Slider({
  label, value, min, max, step = 1, suffix, onChange,
}: {
  label: string; value: number; min: number; max: number; step?: number; suffix: string;
  onChange: (n: number) => void;
}) {
  return (
    <label className="flex items-center gap-3 text-[12px]">
      <span className="w-14 shrink-0 text-muted-foreground">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-border accent-primary"
      />
      <span className="w-12 shrink-0 text-right font-mono text-[11px] text-foreground">
        {value}{suffix}
      </span>
    </label>
  );
}

/**
 * Backgrounds — the picture behind the chat.
 *
 * Twin of the Scene Images section: same list + detail shape, same `scene`
 * sentence for the AI. What it adds is the treatment, and the treatment is
 * the point. A photograph placed directly behind body text is unreadable, so
 * the preview here always carries a real sentence over the processed image —
 * an author must be able to see the legibility problem before publishing,
 * not after a player complains.
 */
export function BackgroundsSection({ mobileListMode }: { mobileListMode?: boolean } = {}) {
  const { t } = useTranslation("editor");
  const worldDraft = useEditorStore((s) => s.worldDraft);
  const serverWorldId = useEditorStore((s) => s.serverWorldId);
  const saveDraft = useEditorStore((s) => s.saveDraft);
  const addBackground = useEditorStore((s) => s.addBackground);
  const updateBackground = useEditorStore((s) => s.updateBackground);
  const removeBackground = useEditorStore((s) => s.removeBackground);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);

  const backgrounds = worldDraft.backgrounds ?? [];
  const greetings = worldDraft.entries.filter((e) => e.role === "greeting");
  const [selectedId, setSelectedId] = useState<string | null>(mobileListMode ? null : backgrounds[0]?.id ?? null);
  const selected = backgrounds.find((b) => b.id === selectedId) ?? null;

  // The cover lives on the DB row; the editor mirrors it onto the draft as
  // `avatar` when a world loads, which is the only copy this section can see.
  const coverUrl = (worldDraft.avatar ? resolveImageUrl(worldDraft.avatar) : null) ?? null;
  const previewUrl = (bg: BackgroundImage): string | null =>
    bg.url === COVER_BACKGROUND_URL ? coverUrl : bg.url ? resolveImageUrl(bg.url) ?? null : null;

  async function uploadFiles(files: FileList | File[]) {
    const list = [...files].filter((f) => f.type.startsWith("image/"));
    if (list.length === 0) return;
    let worldId = serverWorldId;
    if (!worldId) {
      await saveDraft();
      worldId = useEditorStore.getState().serverWorldId;
    }
    if (!worldId) return;
    setBusy(true);
    try {
      for (const file of list) {
        const asset = await useAssetStore.getState().uploadAsset(worldId, file, "image");
        if (!asset) continue;
        const id = addBackground(`@asset:${asset.id}`);
        updateBackground(id, { name: file.name.replace(/\.[^.]+$/, "") });
        setSelectedId(id);
      }
    } finally {
      setBusy(false);
    }
  }

  function addFromCover() {
    const id = addBackground(COVER_BACKGROUND_URL);
    updateBackground(id, { name: t("backgrounds.coverName", { defaultValue: "Cover" }) });
    setSelectedId(id);
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4 md:flex-row">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => { void uploadFiles(e.target.files ?? []); e.target.value = ""; }}
      />

      {/* List */}
      <div className={cn("flex min-h-0 w-full flex-col gap-2 md:w-64", selected && mobileListMode && "hidden md:flex")}>
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">{t("backgrounds.title", { defaultValue: "Background" })}</h2>
          <span className="text-[11px] text-muted-foreground">{backgrounds.length}</span>
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {t("backgrounds.blurb", {
            defaultValue: "A picture behind the chat. Text gets a dark layer over it so it stays readable.",
          })}
        </p>

        {backgrounds.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-4">
            <p className="mb-3 text-[12px] leading-relaxed text-muted-foreground">
              {t("backgrounds.emptyHint", {
                defaultValue: "Start with the cover you already have — no upload, no generation.",
              })}
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={addFromCover}
                disabled={!coverUrl}
                title={coverUrl ? undefined : t("backgrounds.noCover", { defaultValue: "This card has no cover yet." })}
                className="rounded-lg bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground disabled:opacity-40"
              >
                {t("backgrounds.useCover", { defaultValue: "Use the cover" })}
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="rounded-lg border border-border px-3 py-1.5 text-[12px]"
              >
                {t("backgrounds.upload", { defaultValue: "Upload one" })}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
              {backgrounds.map((bg) => {
                const src = previewUrl(bg);
                return (
                  <button
                    key={bg.id}
                    type="button"
                    onClick={() => setSelectedId(bg.id)}
                    className={cn(
                      "flex items-center gap-2.5 rounded-xl border p-2 text-left transition-colors",
                      bg.id === selectedId ? "border-primary/50 bg-primary/5" : "border-border hover:bg-muted/40",
                    )}
                  >
                    <div className="h-10 w-16 shrink-0 overflow-hidden rounded-lg border border-border bg-muted/40">
                      {src ? (
                        <img src={src} alt="" className="h-full w-full object-cover" loading="lazy" />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-muted-foreground/30">
                          <ImageIcon className="h-3.5 w-3.5" />
                        </div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12.5px] font-medium">
                        {bg.name || t("backgrounds.untitled", { defaultValue: "Untitled" })}
                      </div>
                      <div className="truncate text-[10.5px] text-muted-foreground">
                        {bg.isDefault
                          ? t("backgrounds.isDefault", { defaultValue: "Shown by default" })
                          : bg.scene?.trim()
                            ? t("backgrounds.aiPicks", { defaultValue: "AI picks it" })
                            : t("backgrounds.manual", { defaultValue: "Not shown yet" })}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[12px] disabled:opacity-50"
              >
                <Upload className="h-3.5 w-3.5" />
                {t("backgrounds.upload", { defaultValue: "Upload one" })}
              </button>
              <button
                type="button"
                onClick={addFromCover}
                disabled={!coverUrl}
                className="flex items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[12px] disabled:opacity-40"
              >
                <Plus className="h-3.5 w-3.5" />
                {t("backgrounds.cover", { defaultValue: "Cover" })}
              </button>
            </div>
          </>
        )}
      </div>

      {/* Detail */}
      {selected && (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
          {/* Back to the list — mobile list mode hides the list while a
              background is open (same breakpoint as the list's md:flex). */}
          {mobileListMode && (
            <button
              type="button"
              onClick={() => setSelectedId(null)}
              className="flex items-center gap-1.5 self-start text-xs text-muted-foreground hover:text-foreground md:hidden"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              {t("sceneImages.back")}
            </button>
          )}
          <BackgroundPreview
            url={previewUrl(selected)}
            blur={selected.blur ?? DEFAULT_BACKGROUND_BLUR}
            dim={selected.dim ?? DEFAULT_BACKGROUND_DIM}
            opacity={selected.opacity ?? DEFAULT_BACKGROUND_OPACITY}
            position={selected.position ?? "center"}
            sentence={t(PREVIEW_SENTENCE_KEY, {
              defaultValue: "The rain pressed the whole city low. She did not look back — she only tilted the umbrella your way.",
            })}
          />

          <div className="grid gap-3">
            <Slider
              label={t("backgrounds.blur", { defaultValue: "Blur" })}
              value={selected.blur ?? DEFAULT_BACKGROUND_BLUR}
              min={0} max={20} suffix="px"
              onChange={(n) => updateBackground(selected.id, { blur: n })}
            />
            <Slider
              label={t("backgrounds.dim", { defaultValue: "Dim" })}
              value={selected.dim ?? DEFAULT_BACKGROUND_DIM}
              min={0} max={80} suffix="%"
              onChange={(n) => updateBackground(selected.id, { dim: n })}
            />
            <Slider
              label={t("backgrounds.opacity", { defaultValue: "Opacity" })}
              value={selected.opacity ?? DEFAULT_BACKGROUND_OPACITY}
              min={10} max={100} suffix="%"
              onChange={(n) => updateBackground(selected.id, { opacity: n })}
            />
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t("backgrounds.dimVsOpacity", {
                defaultValue: "Dim lays black over everything and is what buys legibility. Opacity fades the picture into the card's own background instead.",
              })}
            </p>
            <div className="flex items-center gap-3 text-[12px]">
              <span className="w-14 shrink-0 text-muted-foreground">
                {t("backgrounds.position", { defaultValue: "Crop" })}
              </span>
              <div className="flex gap-1.5">
                {(["center", "top", "bottom"] as const).map((pos) => (
                  <button
                    key={pos}
                    type="button"
                    onClick={() => updateBackground(selected.id, { position: pos })}
                    className={cn(
                      "rounded-lg border px-2.5 py-1 text-[11.5px]",
                      (selected.position ?? "center") === pos
                        ? "border-primary/50 bg-primary/10 text-foreground"
                        : "border-border text-muted-foreground",
                    )}
                  >
                    {t(`backgrounds.pos.${pos}`, { defaultValue: pos })}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="grid gap-2">
            <label className="text-[11px] font-medium text-muted-foreground">
              {t("backgrounds.name", { defaultValue: "Name" })}
            </label>
            <input
              className={inputClass}
              value={selected.name}
              onChange={(e) => updateBackground(selected.id, { name: e.target.value })}
              placeholder={t("backgrounds.namePlaceholder", { defaultValue: "Rainy rooftop" })}
            />
          </div>

          <div className="grid gap-2">
            <label className="text-[11px] font-medium text-muted-foreground">
              {t("backgrounds.when", { defaultValue: "When the AI should switch to it" })}
            </label>
            <textarea
              className={cn(inputClass, "min-h-[64px] resize-y")}
              maxLength={SCENE_MAX}
              value={selected.scene ?? ""}
              onChange={(e) => updateBackground(selected.id, { scene: e.target.value || undefined })}
              placeholder={t("backgrounds.whenPlaceholder", {
                defaultValue: "A rainy night, or any scene outdoors and high up",
              })}
            />
            <p className="text-[10.5px] leading-relaxed text-muted-foreground">
              {t("backgrounds.whenHint", {
                defaultValue: "Leave empty and the AI never picks this one — an opening or the default flag shows it instead.",
              })}
            </p>
          </div>

          <div className="grid gap-2">
            <StyledCheckbox
              checked={Boolean(selected.isDefault)}
              onChange={(v) => updateBackground(selected.id, { isDefault: v || undefined })}
              label={t("backgrounds.defaultLabel", { defaultValue: "Show this one before anything else picks" })}
            />
            {greetings.length > 1 && (
              <div className="grid gap-1.5">
                <span className="text-[11px] font-medium text-muted-foreground">
                  {t("backgrounds.openings", { defaultValue: "Only on these openings" })}
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {greetings.map((g) => {
                    const on = (selected.greetingIds ?? []).includes(g.id);
                    return (
                      <button
                        key={g.id}
                        type="button"
                        onClick={() => {
                          const cur = selected.greetingIds ?? [];
                          const next = on ? cur.filter((x) => x !== g.id) : [...cur, g.id];
                          updateBackground(selected.id, { greetingIds: next.length ? next : undefined });
                        }}
                        className={cn(
                          "max-w-[180px] truncate rounded-lg border px-2.5 py-1 text-[11.5px]",
                          on ? "border-primary/50 bg-primary/10 text-foreground" : "border-border text-muted-foreground",
                        )}
                      >
                        {g.name || t("backgrounds.untitled", { defaultValue: "Untitled" })}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <div className="pt-1">
            <TwoTapDeleteButton
              onConfirm={() => {
                removeBackground(selected.id);
                setSelectedId(null);
              }}
              className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[12px] text-muted-foreground"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t("backgrounds.remove", { defaultValue: "Remove" })}
            </TwoTapDeleteButton>
          </div>
        </div>
      )}
    </div>
  );
}

/** Original and processed side by side, with a real sentence over the
 *  processed half. The comparison is the whole argument for the sliders. */
function BackgroundPreview({
  url, blur, dim, opacity, position, sentence,
}: {
  url: string | null; blur: number; dim: number; opacity: number; position: "center" | "top" | "bottom"; sentence: string;
}) {
  const { t } = useTranslation("editor");
  const objectPosition = position === "top" ? "50% 0%" : position === "bottom" ? "50% 100%" : "50% 50%";

  if (!url) {
    return (
      <div className="flex h-32 items-center justify-center rounded-xl border border-dashed border-border text-[12px] text-muted-foreground">
        {t("backgrounds.noPicture", { defaultValue: "No picture yet" })}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border">
      <div className="relative h-36 overflow-hidden bg-background">
        <img src={url} alt="" className="h-full w-full object-cover" style={{ objectPosition }} />
        <span className="absolute left-2 top-2 rounded bg-black/50 px-1.5 py-0.5 font-mono text-[9px] text-white/80">
          {t("backgrounds.before", { defaultValue: "Original" })}
        </span>
      </div>
      <div className="relative h-36 overflow-hidden bg-background">
        <img
          src={url}
          alt=""
          className="h-full w-full object-cover"
          style={{
            objectPosition,
            filter: blur > 0 ? `blur(${blur}px)` : undefined,
            transform: blur > 0 ? `scale(${1 + Math.min(0.3, (blur * 2) / 100)})` : undefined,
            // On `bg-background`, so turning this down shows the card's own
            // ground — which is the difference between this and Dim, and the
            // reason the comparison has to be drawn rather than explained.
            opacity: opacity / 100,
          }}
        />
        <div className="absolute inset-0" style={{ background: `rgba(0,0,0,${dim / 100})` }} />
        <span className="absolute left-2 top-2 rounded bg-black/50 px-1.5 py-0.5 font-mono text-[9px] text-white/80">
          {t("backgrounds.after", { defaultValue: "Processed" })}
        </span>
        <p className="absolute inset-x-2.5 bottom-2.5 text-[11.5px] leading-relaxed text-white [text-shadow:0_1px_3px_rgba(0,0,0,.6)]">
          {sentence}
        </p>
      </div>
    </div>
  );
}
