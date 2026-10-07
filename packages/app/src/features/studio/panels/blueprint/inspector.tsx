import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Bot, Check as CheckIcon, ChevronRight, Copy, FolderOpen, History, Images, Maximize2, MoreHorizontal, Trash2, Upload, X } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Check, Field, Group, More, OpenToolButton, Row, Segmented, Stepper, Switch, inputClass, labelClass, rowControl } from "./controls";
import { resolveImageUrl } from "@/lib/asset-url";
import { feedback } from "@/lib/feedback";
import { ANY_MODULE, UNPLACED_WORLDBOOK_ID, deriveSectionDefaultsForEntry, sceneImageEmbed, type WorkerTrigger } from "@yumina/engine";
import type { CardGraph, Condition, GraphNode, GraphPatch, ModuleContextInput, SceneImage, Variable, WorldDefinition, WorldEntry } from "@yumina/engine";
import { AssetPicker } from "@/features/editor/asset-picker";
import { uploadSceneImageFiles } from "@/features/editor/sections/scene-image-upload";
import { isSceneImageAuto, useSceneImageMode } from "@/features/editor/sections/scene-image-auto";
import { ImageInsertButton, useImageInsert } from "@/features/editor/components/image-insert";
import { useEditorStore } from "@/stores/editor";
import { DebouncedInput, DebouncedTextarea } from "@/features/editor/components/debounced-field";
import { useTemplateContentPlaceholder } from "@/features/editor/template-placeholders";
import { cn } from "@/lib/utils";
import { confirmAction } from "@/components/ui/global-confirm-dialog";
import { getSendAsOptions, SECONDARY_LOGIC_OPTIONS } from "@/lib/entry-constants";
import { KIND_STYLE } from "./style";
import { showVariableOnScreen } from "../../lib/show-on-screen";
import { isVariableOnScreen } from "../../lib/variable-on-screen";
import { ConditionSentences, EffectSentences, WhenSentence } from "./behavior-sentence";
import { VariableValueField } from "./variable-value-field";
import { VariableActivationEditor } from "@/features/editor/components/variable-activation-editor";
import { VariableIdEditor, VariableNameReferenceHint } from "@/features/editor/components/variable-id-editor";
import { OptionsEditor, suggestedDelta } from "@/features/editor/components/precise-tracking";
import { CONTINUITY_MAX_OPTIONS } from "@yumina/engine";
import { getEntryDeliverySummary } from "./entry-delivery";
import { ModuleConsole, ModuleMemorySettings } from "@/features/editor/components/module/module-console";
import { aiRoster, hasSeveralAis, placeGivesTo, voiceOf, type AiVoice } from "./ai-roster";
import { aiTypeOf } from "./place-ais";
import { AiCustomForm } from "./ai-custom-form";
import { ReplyRulesForm } from "./reply-rules-form";
import type { AiType } from "./add-ai";
import { ModuleActivationEditor } from "@/features/editor/components/module-activation-editor";
import { ModuleContents } from "@/features/editor/components/module-contents";
import { ShareModuleButton } from "@/edition/slots";
import { EntryPortraitField } from "@/features/editor/components/entry-portrait-field";
import { EntryPortraitVideoField } from "@/features/editor/components/entry-portrait-video-field";
import { VoiceField } from "@/features/editor/components/voice-field";
import { VariantTabBar } from "@/features/editor/variant-tab-bar";
import { OverviewSection } from "@/features/editor/sections/overview";

/** Emit-chain edges are derived from an upstream behavior's emit effect plus
 *  the downstream WHEN pattern — they carry no payload of their own and are
 *  edited through the behaviors involved, never deleted directly. */
export function isChainEdge(edgeId: string): boolean {
  return edgeId.startsWith("e:reaction:") && edgeId.includes("->reaction:");
}

/** Wires the projection derives from structure rather than from a stored
 *  relationship. Nothing in the draft holds them, so "remove" would be a
 *  button that silently does nothing — these are read-only by construction. */
export function isDerivedEdge(edgeId: string): boolean {
  return (
    isChainEdge(edgeId) ||
    edgeId.startsWith("e:world->") ||
    // variable → frontend: read from the card's TSX, not stored anywhere
    edgeId.endsWith("->frontend:read") ||
    // module → module context wiring and worker triggers: both are
    // projections of the module console, never stored as edges
    /^e:module:.+->module:.+:(memory|worker|variables|transcript|trigger)(:.+)?$/.test(edgeId)
  );
}

/** The four delivery zones, in prompt order. */
const SECTION_OPTIONS = [
  { value: "system-presets", labelKey: "entries.sections.systemPresets" },
  { value: "examples", labelKey: "entries.sections.examples" },
  { value: "chat-history", labelKey: "entries.sections.chatHistory" },
  { value: "post-history", labelKey: "entries.sections.postHistory" },
] as const satisfies ReadonlyArray<{ value: WorldEntry["section"]; labelKey: string }>;

const apiBase = import.meta.env.VITE_API_URL || "";
/** An entry's body, when the column is where it is written. Settings fields
 *  are 12px because they are labels with values; prose is not, and this is the
 *  same size and leading the board's own editor sets it in. */
const proseClass = "flex-1 resize-none text-[15px] leading-[26px] placeholder:whitespace-pre-line";

// ── Per-kind forms ──────────────────────────────────────────────────

const pickButton =
  "studio-control flex items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-[11px] font-medium text-foreground/80 transition-colors hover:bg-white/[0.07] hover:text-foreground disabled:opacity-40";

/**
 * A scene image, edited where it was clicked. The column holds everything
 * the editor page holds — picture, the "when" sentence, AI control, scope —
 * so a row on the board is one click from done, not a doorway to another
 * screen. The page link at the bottom is for the list view, not for editing.
 */
/** A track's own settings, beside the board: what kind of sound it is and
 *  the one sentence that lets the judge play it. A click on a track used to
 *  land on a single button to the Audio page, which read as "this row has
 *  nothing in it". Playlists and conditional rules stay on that page — they
 *  are about the card's music as a whole, not this track. */
export function AudioTrackForm({ trackId, onDrill }: { trackId: string; onDrill: (panelId: string) => void }) {
  const { t } = useTranslation("editor");
  const track = useEditorStore((s) => s.worldDraft.audioTracks.find((item) => item.id === trackId));
  const updateAudioTrack = useEditorStore((s) => s.updateAudioTrack);
  if (!track) return null;
  const isSfx = track.type === "sfx";
  const hasCue = Boolean(track.aiNote?.trim());
  const kinds = (["bgm", "ambient", "sfx"] as const).map((kind) => ({ value: kind, label: t(`audio.trackTypes.${kind}` as never) as string }));
  return (
    <div className="space-y-1">
      <Group title="">
        <Row label={t("audio.trackType")} hint={t("blueprint.tips.audioType")} wide>
          <Segmented value={track.type} options={kinds} label={t("audio.trackType")} onChange={(type) => updateAudioTrack(trackId, { type })} />
        </Row>
        <Check label={t("audio.allowAiControl")} hint={t("blueprint.tips.audioAi")} checked={track.allowAiControl !== false} onChange={(allowed) => updateAudioTrack(trackId, { allowAiControl: allowed ? undefined : false })} />
      </Group>
      {/* One sentence is the whole setting: a track with a cue is played by
          the judge when the story matches it; an empty cue keeps it out. */}
      <Group title={t(isSfx ? "audio.aiNoteSfxLabel" : "audio.aiNoteLabel")} hint={t(isSfx ? "audio.aiPickSfxHelp" : "audio.aiPickHelp")}>
        <DebouncedInput
          type="text"
          aria-label={t(isSfx ? "audio.aiNoteSfxLabel" : "audio.aiNoteLabel")}
          value={track.aiNote ?? ""}
          maxLength={200}
          onCommit={(aiNote) => updateAudioTrack(trackId, { aiNote: aiNote.trim() ? aiNote : undefined })}
          placeholder={t(isSfx ? "audio.aiNoteSfxPlaceholder" : "audio.aiNotePlaceholder")}
          className={inputClass}
        />
        <p className={cn("pt-1 text-[11px]", hasCue ? "text-[#f0c674]/80" : "text-foreground/46")}>{t(hasCue ? "audio.aiPickOn" : "audio.aiPickOff")}</p>
      </Group>
      <div className="pt-4"><OpenToolButton labelKey="studio.panels.audio" onOpen={() => onDrill("audio")} /></div>
    </div>
  );
}

/** Who places the card's scene images — a card-wide choice, so it appears
 *  both on one image and on the whole block; the Scene Images page carries
 *  the same control. The chosen option's help rides in the hint. */
function SceneImageModeGroup() {
  const { t } = useTranslation("editor");
  const { mode, locked, setMode } = useSceneImageMode();
  return (
    <Group title={t("sceneImages.modeTitle")} hint={locked ? undefined : t(mode === "judge" ? "sceneImages.modeJudgeHelp" : "sceneImages.modeNarratorHelp")}>
      {locked ? (
        <p className="text-[11px] leading-relaxed text-foreground/55">{t("sceneImages.modeLocked")}</p>
      ) : (
        <Segmented
          label={t("sceneImages.modeTitle")}
          value={mode}
          onChange={setMode}
          options={[
            { value: "judge", label: t("sceneImages.modeJudgeShort"), hint: t("sceneImages.modeJudgeHelp") },
            { value: "narrator", label: t("sceneImages.modeNarratorShort"), hint: t("sceneImages.modeNarratorHelp") },
          ]}
        />
      )}
    </Group>
  );
}

export function SceneImageForm({ sceneImageId, onDrill }: { sceneImageId: string; onDrill: (panelId: string) => void }) {
  const { t } = useTranslation("editor");
  const image = useEditorStore((s) => (s.worldDraft.sceneImages ?? []).find((img) => img.id === sceneImageId));
  const entries = useEditorStore((s) => s.worldDraft.entries);
  const serverWorldId = useEditorStore((s) => s.serverWorldId);
  const saveDraft = useEditorStore((s) => s.saveDraft);
  const updateSceneImage = useEditorStore((s) => s.updateSceneImage);
  const greetings = useMemo(() => entries.filter((e) => e.role === "greeting"), [entries]);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [picker, setPicker] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const { mode } = useSceneImageMode();
  if (!image) return null;

  const commit = (updates: Partial<SceneImage>) => updateSceneImage(sceneImageId, updates);
  const auto = isSceneImageAuto(image);
  const held = image.allowAiControl === false;
  const scope = image.greetingIds ?? [];
  const src = image.url ? resolveImageUrl(image.url) : undefined;

  const openPicker = async () => {
    if (!serverWorldId) {
      await saveDraft();
      if (!useEditorStore.getState().serverWorldId) return;
    }
    setPicker(true);
  };
  const pickerWorldId = serverWorldId ?? useEditorStore.getState().serverWorldId;

  return (
    <div className="space-y-3">

      <div className="overflow-hidden rounded-lg border border-white/[0.06] bg-black/30 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
        {src ? (
          <img src={src} alt="" className="block max-h-[220px] w-full object-contain" />
        ) : (
          <div className="flex h-[120px] items-center justify-center text-foreground/30">
            <Images className="h-6 w-6" />
          </div>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={() => fileRef.current?.click()} className={pickButton}>
          <Upload className="h-3.5 w-3.5" />
          {progress ? t("sceneImages.uploading", progress) : t("sceneImages.uploadFiles")}
        </button>
        <button type="button" onClick={() => void openPicker()} className={pickButton}>
          <FolderOpen className="h-3.5 w-3.5" />
          {t("sceneImages.browseAssets")}
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) {
            void uploadSceneImageFiles({
              files: e.target.files,
              selectedId: sceneImageId,
              onProgress: (done, total) => setProgress({ done, total }),
              onFailed: (name) => feedback.error(t("sceneImages.uploadFailed", { name })),
            }).then(() => setProgress(null));
          }
          e.target.value = "";
        }}
      />
      <Field label={t("sceneImages.urlLabel")} hint={t("blueprint.tips.imageUrl")}>
        <DebouncedInput
          value={image.url}
          onCommit={(url) => commit({ url })}
          syncKey={sceneImageId}
          placeholder={t("sceneImages.urlPlaceholder")}
          className={inputClass}
        />
      </Field>

      {/* The "when" sentence is the image's one switch, as on a track. */}
      <Group title={t("sceneImages.sceneLabel")} hint={t(mode === "judge" ? "sceneImages.autoHelpJudge" : "sceneImages.autoHelpNarrator")}>
        <DebouncedTextarea
          value={image.scene}
          onCommit={(scene) => commit({ scene })}
          syncKey={sceneImageId}
          maxLength={200}
          aria-label={t("sceneImages.sceneLabel")}
          placeholder={t("sceneImages.scenePlaceholder")}
          className={cn(inputClass, "min-h-20 resize-y")}
        />
        <p className={cn("pt-1 text-[11px] leading-relaxed", auto ? "text-[#f0c674]/80" : "text-foreground/46")}>
          {held ? t("sceneImages.autoHeld") : auto ? t("sceneImages.autoOn") : image.scene.trim() ? t("sceneImages.autoNoPicture") : t("sceneImages.autoOff")}
          {held && (
            <button type="button" onClick={() => commit({ allowAiControl: undefined })} className="ml-1.5 font-medium text-[#f5d48a] hover:underline">
              {t("sceneImages.autoReenable")}
            </button>
          )}
        </p>
      </Group>

      <Field label={t("sceneImages.hintLabel")} hint={t("sceneImages.hintHelp")}>
        <DebouncedInput
          value={image.hint ?? ""}
          onCommit={(hint) => commit({ hint: hint.trim() ? hint : undefined })}
          syncKey={sceneImageId}
          maxLength={80}
          placeholder={t("sceneImages.hintPlaceholder")}
          className={inputClass}
        />
      </Field>

      <Group title={t("sceneImages.scopeLabel")} hint={t("blueprint.tips.imageScope")}>
        {greetings.length === 0 ? (
          <p className="text-[11px] leading-relaxed text-foreground/45">{t("sceneImages.scopeNoGreetings")}</p>
        ) : (
          <div className="space-y-1.5">
            <Check
              label={t("sceneImages.scopeAll")}
              checked={scope.length === 0}
              onChange={(v) => commit({ greetingIds: v || !greetings[0] ? undefined : [greetings[0].id] })}
            />
            {scope.length > 0 &&
              greetings.map((g, i) => (
                <Check
                  key={g.id}
                  label={g.name || t("sceneImages.greetingFallback", { index: i + 1 })}
                  checked={scope.includes(g.id)}
                  onChange={() => {
                    const next = scope.includes(g.id) ? scope.filter((x) => x !== g.id) : [...scope, g.id];
                    commit({ greetingIds: next.length ? next : undefined });
                  }}
                />
              ))}
          </div>
        )}
      </Group>

      <SceneImageModeGroup />

      <Group title={t("sceneImages.idLabel")} hint={t("sceneImages.idHelp")}>
        <div className="flex items-center gap-2">
          <code className="studio-control min-w-0 flex-1 truncate rounded-lg border px-2 py-1.5 font-mono text-[11px] text-foreground">{image.id}</code>
          <button
            type="button"
            disabled={!image.url}
            title={t("sceneImages.copyCode")}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(sceneImageEmbed(image));
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1200);
              } catch {
                feedback.error(t("sceneImages.copyFailed"));
              }
            }}
            className={cn(pickButton, "shrink-0")}
          >
            {copied ? <CheckIcon className="h-3.5 w-3.5 text-[#f5d48a]" /> : <Copy className="h-3.5 w-3.5" />}
            {t("sceneImages.copyCode")}
          </button>
        </div>
      </Group>

      <OpenToolButton labelKey="studio.panels.sceneImages" onOpen={() => onDrill("scene-images")} />

      {picker && pickerWorldId && (
        <AssetPicker
          worldId={pickerWorldId}
          filterType="image"
          onSelect={(ref) => {
            commit({ url: ref });
            setPicker(false);
          }}
          onClose={() => setPicker(false)}
        />
      )}
    </div>
  );
}

export function GreetingForm({ entryId, onDrill }: { entryId: string; onDrill: (panelId: string) => void }) {
  const { t } = useTranslation("editor");
  const entry = useEditorStore((s) => s.worldDraft.entries.find((e) => e.id === entryId));
  const variables = useEditorStore((s) => s.worldDraft.variables);
  const updateEntry = useEditorStore((s) => s.updateEntry);
  const guidance = useTemplateContentPlaceholder(entry ?? { tags: undefined });
  const contentRef = useRef<HTMLDivElement>(null);
  const imageInsert = useImageInsert(() => contentRef.current?.querySelector("textarea") ?? null);
  if (!entry) return null;
  const seeded = Object.keys(entry.initialVariables ?? {}).length;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {/* Settings above the writing, in one line.

          What sat below used to be a read-only list of the variables this
          opening seeds, a paragraph explaining that it could not be edited
          there, and a link to where it could. Three blocks of furniture under
          the text, none of them actionable — and the writing surface pushed
          up out of the way to make room. The count and the way in are the
          whole of it; the list itself lives where it can be changed. */}
      {(variables.length > 0 || seeded > 0) && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-white/[0.06] bg-white/[0.035] px-2.5 py-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
          <span className="text-[11px] text-foreground/55">{t("firstMessage.initialVarsTitle")}</span>
          {seeded === 0
            ? <span className="text-[11px] text-foreground/40">{t("firstMessage.noInitialVars")}</span>
            : <dl className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                {Object.entries(entry.initialVariables ?? {}).map(([variableId, value]) => {
                  const variable = variables.find((v) => v.id === variableId) ?? variables.find((v) => v.name === variableId);
                  return (
                    <span key={variableId} className="inline-flex items-baseline gap-1 rounded bg-sky-500/12 px-1.5 py-0.5">
                      <dt className="text-[10.5px] text-sky-200/80">{variable?.name ?? variableId}</dt>
                      <dd className="font-mono text-[10.5px] text-sky-100">
                        {typeof value === "boolean" ? t(value ? "firstMessage.true" : "firstMessage.false") : String(value)}
                      </dd>
                    </span>
                  );
                })}
              </dl>}
          <button
            type="button"
            onClick={() => onDrill("variables")}
            className="studio-control ml-auto shrink-0 rounded-md border px-2 py-1 text-[10.5px] text-foreground/60 transition-colors hover:text-foreground"
          >
            {t("firstMessage.editInVariables")}
          </button>
        </div>
      )}
      {/* The column IS the writing surface, so the text takes the height it
          leaves rather than a fixed twelve rows with the settings stacked in
          the space below. */}
      <div ref={contentRef} className="flex min-h-[240px] flex-1 flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={`studio-opening-content-${entryId}`} className={labelClass}>{t("entries.content")}</label>
          <ImageInsertButton insert={imageInsert} />
        </div>
        <DebouncedTextarea
          id={`studio-opening-content-${entryId}`}
          value={entry.content}
          onCommit={(content) => updateEntry(entryId, { content })}
          syncKey={entryId}
          placeholder={guidance || t("blueprint.insp.openingPlaceholder")}
          {...imageInsert.dropProps}
          className={cn(inputClass, proseClass, "min-h-40", imageInsert.dragOver && "border-amber-400/70 ring-2 ring-amber-400/40")}
        />
        {imageInsert.overlays}
      </div>
    </div>
  );
}

function EntryDeliverySummary({ entry }: { entry: WorldEntry }) {
  const { t } = useTranslation("editor");
  const worldbooks = useEditorStore((s) => s.worldDraft.worldbooks);
  const loreUiBindings = useEditorStore((s) => s.worldDraft.loreUiBindings);
  const delivery = getEntryDeliverySummary(entry, { worldbooks, loreUiBindings });
  const hasScope = delivery.moduleScoped || delivery.frontendScoped;
  // Inside an AI's frame an entry is what that one AI knows: say whose it
  // is, not "the story AI" and "while its situation is on".
  const owner = entry.worldbookId ? (worldbooks ?? []).find((b) => b.id === entry.worldbookId) : undefined;
  const aiName = owner?.station ? owner.station.name?.trim() || owner.name : null;
  let summary: string;
  switch (delivery.mode) {
    case "unplaced":
      summary = t("blueprint.entry.deliveryUnplaced");
      break;
    case "disabled":
      summary = t("blueprint.entry.deliveryDisabled", { defaultValue: "已停用，不会自动提供给故事 AI。" });
      break;
    case "always":
      summary = aiName
        ? t("blueprint.entry.deliveryAiAlways", { name: aiName })
        : hasScope
        ? t("blueprint.entry.deliveryAlwaysScoped", { defaultValue: "在下方范围内，每次回复都会提供给故事 AI。" })
        : t("blueprint.entry.deliveryAlways", { defaultValue: "每次回复都会提供给故事 AI。" });
      break;
    case "keywords":
      summary = t("blueprint.entry.deliveryKeywords", { defaultValue: "匹配到关键词时，提供给故事 AI。" });
      break;
    case "conditions":
      summary = delivery.conditionLogic === "any"
        ? t("blueprint.entry.deliveryConditionsAny", { count: delivery.conditionCount, defaultValue: "{{count}} 个变量条件中，任意一个满足时提供给故事 AI。" })
        : t("blueprint.entry.deliveryConditionsAll", { count: delivery.conditionCount, defaultValue: "{{count}} 个变量条件全部满足时，提供给故事 AI。" });
      break;
    case "keywords-and-conditions":
      summary = delivery.conditionLogic === "any"
        ? t("blueprint.entry.deliveryKeywordsConditionsAny", { count: delivery.conditionCount, defaultValue: "关键词匹配，且 {{count}} 个变量条件中任意一个满足时，提供给故事 AI。" })
        : t("blueprint.entry.deliveryKeywordsConditionsAll", { count: delivery.conditionCount, defaultValue: "关键词匹配，且 {{count}} 个变量条件全部满足时，提供给故事 AI。" });
      break;
    case "frontend":
      summary = t("blueprint.entry.deliveryFrontend", { defaultValue: "由前端中对应的元素控制是否提供给故事 AI。" });
      break;
    default:
      summary = t("blueprint.entry.deliveryUnconfigured", { defaultValue: "尚未设置自动发送方式。可开启始终发送，或设置关键词、变量条件或前端连接。" });
  }
  return (
    <div className="space-y-1 rounded-lg border border-white/[0.06] bg-white/[0.035] px-2.5 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]" aria-live="polite">
      <p className="text-xs leading-relaxed text-foreground/85">{summary}</p>
      {delivery.mode !== "disabled" && delivery.moduleScoped && (
        <p className="text-[11px] leading-relaxed text-foreground/45">{aiName
          ? t("blueprint.entry.deliveryAiOnly", { name: aiName })
          : t("blueprint.entry.deliveryModuleScope", { defaultValue: "仅在所属模块生效期间发送。" })}</p>
      )}
      {delivery.mode !== "disabled" && delivery.frontendScoped && (
        <p className="text-[11px] leading-relaxed text-foreground/45">{delivery.frontendConditions
          ? t("blueprint.entry.deliveryFrontendConditions", { defaultValue: "还需对应前端元素激活，并满足连接上的条件。" })
          : t("blueprint.entry.deliveryFrontendScope", { defaultValue: "仅在对应前端元素激活期间发送。" })}</p>
      )}
      {delivery.secondaryKeywords && (
        <p className="text-[11px] leading-relaxed text-foreground/45">{t("blueprint.entry.deliverySecondary", { defaultValue: "同时遵循辅助关键词与匹配设置。" })}</p>
      )}
    </div>
  );
}

export function EntryForm({ entryId }: { entryId: string }) {
  const { t } = useTranslation("editor");
  const entry = useEditorStore((s) => s.worldDraft.entries.find((e) => e.id === entryId));
  const updateEntry = useEditorStore((s) => s.updateEntry);
  // The same per-entry guidance the board and the classic editor show.
  const guidance = useTemplateContentPlaceholder(entry ?? { tags: undefined });
  const liveCanonOn = useLiveCanonAllowed(useEditorStore((s) => s.serverWorldId));
  if (!entry) return null;
  // Only once the card lets players edit their run (or this setting already
  // says it may be edited): on every other card it was a switch on every
  // setting for an extension the card does not use.
  const liveCanonEligible = (entry.role === "lore" || entry.role === "plot" || entry.role === "custom")
    && (liveCanonOn || entry.sessionEditPolicy === "content");
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {/* What governs this text, above the text.

          It all used to sit underneath: a read-only line saying when the
          entry reaches the AI, and the controls that decide it folded away
          below that. A setting a creator has to scroll past the thing it
          governs to reach, and then expand, reads as something the board
          would rather they did not touch — and "when does this reach the
          AI" is the one question every entry has to answer. */}
      <div className="space-y-2">
        <EntryDeliverySummary entry={entry} />
          {/* Shut for the common case (every turn, nothing to explain) and open
            the moment the answer is anything else: an entry gated on keywords
            or conditions is exactly the one whose creator needs to see the
            gate without hunting for it. */}
        <div data-learn="entry-delivery"><More
          key={entryId}
          label={t("blueprint.entry.adjustDelivery", { defaultValue: "调整生效方式" })}
          defaultOpen={!entry.alwaysSend || entry.enabled === false}
        >
          <Group title={t("blueprint.insp.reachesPrompt")} hint={t("blueprint.tips.reaches")}>
            <Row label={t("blueprint.rowEdit.sectionLabel")} hint={t("blueprint.tips.section")}>
              <select
                aria-label={t("blueprint.rowEdit.sectionLabel")}
                value={entry.section ?? "system-presets"}
                onChange={(e) => {
                  const section = e.target.value as WorldEntry["section"];
                  updateEntry(entryId, { section, ...deriveSectionDefaultsForEntry(entry, section) });
                }}
                className={rowControl}
              >
                {SECTION_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{t(o.labelKey as never)}</option>
                ))}
              </select>
            </Row>
            <Check label={t("entries.alwaysSend")} hint={t("blueprint.tips.alwaysSend")} checked={Boolean(entry.alwaysSend)} onChange={(alwaysSend) => updateEntry(entryId, { alwaysSend })} />
            <Field label={t("blueprint.insp.keywords")} hint={t("blueprint.tips.keywords")}>
              <DebouncedInput
                aria-label={t("blueprint.insp.keywords")}
                value={(entry.keywords ?? []).join(", ")}
                onCommit={(raw) =>
                  updateEntry(entryId, { keywords: raw.split(/[,，]/).map((k) => k.trim()).filter(Boolean) })
                }
                syncKey={entryId}
                placeholder={t("blueprint.insp.keywordsPlaceholder")}
                className={inputClass}
              />
            </Field>
            {(entry.conditions?.length ?? 0) > 0 && (
              <Row label={t("blueprint.insp.conditionsWired", { count: entry.conditions.length })} wide>
                {entry.conditions.length > 1 && (
                  <Segmented<"all" | "any">
                    label={t("blueprint.insp.conditionsWired", { count: entry.conditions.length })}
                    value={entry.conditionLogic === "any" ? "any" : "all"}
                    onChange={(conditionLogic) => updateEntry(entryId, { conditionLogic })}
                    options={[{ value: "all", label: t("blueprint.sentence.logicAll") }, { value: "any", label: t("blueprint.sentence.logicAny") }]}
                  />
                )}
              </Row>
            )}
          </Group>

          <More>
            <Field label={t("entries.secondaryKeywords")} hint={t("blueprint.tips.secondary")}>
              <DebouncedInput
                value={(entry.secondaryKeywords ?? []).join(", ")}
                onCommit={(raw) =>
                  updateEntry(entryId, {
                    secondaryKeywords: raw.split(/[,，]/).map((k) => k.trim()).filter(Boolean),
                  })
                }
                syncKey={entryId}
                placeholder={t("entries.secondaryKeywordsPlaceholder")}
                className={inputClass}
              />
            </Field>
            {(entry.secondaryKeywords?.length ?? 0) > 0 && (
              <Row label={t("entries.secondaryLogicLabel")} hint={t("blueprint.tips.secondaryLogic")}>
                <select
                  value={entry.secondaryKeywordLogic ?? "AND_ANY"}
                  onChange={(e) =>
                    updateEntry(entryId, {
                      secondaryKeywordLogic: e.target.value as NonNullable<WorldEntry["secondaryKeywordLogic"]>,
                    })
                  }
                  className={rowControl}
                >
                  {SECONDARY_LOGIC_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </Row>
            )}
            <Check label={t("entries.wholeWord")} hint={t("blueprint.tips.wholeWord")} checked={Boolean(entry.matchWholeWords)} onChange={(matchWholeWords) => updateEntry(entryId, { matchWholeWords })} />
            <Check label={t("entries.preventRecursion")} hint={t("blueprint.tips.preventRecursion")} checked={Boolean(entry.preventRecursion)} onChange={(preventRecursion) => updateEntry(entryId, { preventRecursion })} />
            <Check label={t("entries.excludeRecursion")} hint={t("blueprint.tips.excludeRecursion")} checked={Boolean(entry.excludeRecursion)} onChange={(excludeRecursion) => updateEntry(entryId, { excludeRecursion })} />
            <Row label={t("entries.depth")} hint={t("entries.depthHint")}>
              <input
                type="number"
                min={0}
                max={100}
                value={entry.depth ?? 0}
                onChange={(e) => updateEntry(entryId, { depth: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })}
                className={cn(rowControl, "w-20")}
              />
            </Row>
            <Row label={t("entries.sendAs")} hint={t("blueprint.tips.sendAs")}>
              <select
                value={entry.apiRole ?? "system"}
                onChange={(e) => updateEntry(entryId, { apiRole: e.target.value as NonNullable<WorldEntry["apiRole"]> })}
                className={rowControl}
              >
                {getSendAsOptions(t).map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </Row>
          </More>
          </More></div>
      </div>

      <div className="flex min-h-[240px] flex-1 flex-col gap-1.5">
        <label htmlFor={`studio-entry-content-${entryId}`} className={labelClass}>{t("entries.content")}</label>
        <DebouncedTextarea
          id={`studio-entry-content-${entryId}`}
          value={entry.content}
          onCommit={(content) => updateEntry(entryId, { content })}
          syncKey={entryId}
          placeholder={guidance || t("blueprint.rowEdit.bodyPlaceholder")}
          className={cn(inputClass, proseClass, "min-h-32")}
        />
      </div>

      {/* A character's portrait, moving portrait and voice: the one place on
          the board to set them (the simple and full editors mount the same
          fields). Under the text — a creator opens 角色 to write who the
          character is, and three media pickers above the box pushed it
          below the fold. */}
      {entry.role === "character" && (
        <EntryPortraitField
          variant="row"
          value={entry.portrait}
          onChange={(portrait) => updateEntry(entryId, { portrait })}
        />
      )}
      {entry.role === "character" && (
        <EntryPortraitVideoField
          value={entry.portraitVideo}
          onChange={(portraitVideo) => updateEntry(entryId, { portraitVideo })}
        />
      )}
      {entry.role === "character" && (
        <VoiceField
          label={t("voiceField.characterLabel")}
          title={t("blueprint.voice.character", { name: entry.name })}
          value={entry.voice}
          onChange={(voice) => updateEntry(entryId, { voice })}
        />
      )}

      {liveCanonEligible && <Group title={t("blueprint.insp.liveCanon")} hint={t("blueprint.tips.liveCanon")}>
        <Check
          label={t("blueprint.insp.liveCanonEntryEditable")}
          hint={t("blueprint.insp.liveCanonEntryEditableHint")}
          checked={entry.sessionEditPolicy === "content"}
          onChange={(editable) => updateEntry(entryId, { sessionEditPolicy: editable ? "content" : "locked" })}
        />
      </Group>}

    </div>
  );
}

export function VariableForm({ variableId }: { variableId: string }) {
  const { t } = useTranslation("editor");
  const worldDraft = useEditorStore((s) => s.worldDraft);
  const index = useEditorStore((s) => s.worldDraft.variables.findIndex((v) => v.id === variableId));
  const variable = useEditorStore((s) => s.worldDraft.variables.find((v) => v.id === variableId));
  const updateVariableAt = useEditorStore((s) => s.updateVariableAt);
  const allVariables = useEditorStore((s) => s.worldDraft.variables);
  const entries = useEditorStore((s) => s.worldDraft.entries);
  const variables = useMemo(() => allVariables.filter((v) => !v.internal), [allVariables]);
  const greetings = useMemo(() => entries.filter((entry) => entry.role === "greeting"), [entries]);
  if (!variable || index < 0) return null;
  const commit = (updates: Partial<Variable>) => {
    // Debounced inputs may finish after the variable list was reordered.
    const currentIndex = useEditorStore.getState().worldDraft.variables.findIndex((v) => v.id === variableId);
    if (currentIndex >= 0) updateVariableAt(currentIndex, updates);
  };
  const types = (["number", "string", "boolean", "json"] as const).map((ty) => ({ value: ty, label: t(`blueprint.row.varType.${ty}` as never) as string, hint: t(`blueprint.insp.typeHint.${ty}`) as string }));
  const preciseAllowed = variable.type === "number" || variable.type === "boolean" || (variable.type === "string" && (variable.options?.length ?? 0) > 0);
  const precise = variable.precise === true;
  const down = Math.max(0, Math.floor(variable.deltaDown ?? 0));
  const up = Math.max(0, Math.floor(variable.deltaUp ?? 0));
  const tooWide = down + up + 1 > CONTINUITY_MAX_OPTIONS;
  const setPrecise = (next: boolean) => {
    if (!next) { commit({ precise: undefined }); return; }
    const updates: Partial<Variable> = { precise: true };
    if (variable.type === "number" && variable.deltaDown === undefined && variable.deltaUp === undefined) {
      const d = suggestedDelta(variable);
      updates.deltaDown = d;
      updates.deltaUp = d;
    }
    commit(updates);
  };
  // The one live fact under precise tracking: what the judge may do a turn.
  let preciseFact: { text: string; warn: boolean } | null = null;
  if (precise && variable.type === "number") {
    if (tooWide) preciseFact = { text: t("variables.preciseTooWide", { max: CONTINUITY_MAX_OPTIONS - 1 }), warn: true };
    else if (down === 0 && up === 0) preciseFact = { text: t("variables.preciseZero"), warn: true };
    else if (down === 0) preciseFact = { text: t("variables.preciseUpOnly", { up }), warn: false };
    else if (up === 0) preciseFact = { text: t("variables.preciseDownOnly", { down }), warn: false };
    else preciseFact = { text: t("variables.preciseRange", { down, up }), warn: false };
  }
  const numberField = (value: number | undefined, onCommit: (next: number | undefined) => void, label: string) => (
    <input
      type="number"
      aria-label={label}
      value={value ?? ""}
      onChange={(e) => onCommit(e.target.value === "" ? undefined : Number(e.target.value))}
      className={cn(rowControl, "w-[72px] text-center tabular-nums")}
    />
  );

  return (
    <div className="space-y-1">
      {/* What it is: the kind, in a row of four so the other three are seen;
          where it starts; the range a number lives in. */}
      <div data-learn="var-basics"><Group title="">
        <Row label={t("blueprint.insp.type")} hint={t(`blueprint.insp.typeHint.${variable.type}`)} wide>
          <Segmented
            value={variable.type}
            options={types}
            label={t("blueprint.insp.type")}
            onChange={(type) => {
              const defaultValue = type === "number" ? 0 : type === "boolean" ? false : type === "json" ? {} : "";
              commit({ type, defaultValue });
            }}
          />
        </Row>
        <VariableValueField key={variable.id} variable={variable} onCommit={(defaultValue) => commit({ defaultValue })} compact />
        {variable.type === "number" && (
          <Row label={t("blueprint.insp.range", { defaultValue: "Range" })} hint={t("blueprint.tips.range")}>
            {numberField(variable.min, (min) => commit({ min }), t("variables.min"))}
            <span className="text-foreground/40">{t("blueprint.insp.rangeTo", { defaultValue: "to" })}</span>
            {numberField(variable.max, (max) => commit({ max }), t("variables.max"))}
          </Row>
        )}
        {/* From the variable straight to the screen: a number becomes a
            meter, a list a list, the rest a line — one click, no binding.
            Once something shows it, the button says so instead of offering
            to add it again (taking it off is the player-screen editor's). */}
        {isVariableOnScreen(worldDraft.uiDoc, variable.id) ? (
          <p data-testid="on-screen" className="mt-1 rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-2.5 py-1.5 text-center text-[11.5px] font-medium text-emerald-300/90">
            {t("blueprint.insp.onScreen")}
          </p>
        ) : <button
          type="button"
          data-testid="show-on-screen"
          onClick={() => {
            const placed = showVariableOnScreen(variable.id, {
              chatPageName: String(t("studio.pageTemplates.chatPageName")),
              lineLabel: (name) => String(t("blueprint.insp.showOnScreenLine", { name })),
            });
            if (placed) feedback.notice(t("blueprint.insp.shownOnScreen", { name: variable.name }));
          }}
          className="studio-control mt-1 w-full rounded-lg border px-2.5 py-1.5 text-[11.5px] font-medium text-foreground/80 transition-colors hover:text-foreground"
        >
          {t("blueprint.insp.showOnScreen")}
        </button>}
      </Group></div>

      {/* The variable's own description — when it changes and how. The one
          field that says what the number means; the row on the board shows
          its first line. */}
      <div data-learn="var-rules"><Group title={t("variables.behaviorRules")} hint={t("variables.behaviorRulesHint")}>
        <DebouncedTextarea
          value={variable.behaviorRules ?? variable.updateHints ?? ""}
          onCommit={(behaviorRules) => commit({ behaviorRules: behaviorRules.trim() ? behaviorRules : undefined })}
          syncKey={variableId}
          rows={3}
          placeholder={t("blueprint.insp.rulesPlaceholder", { defaultValue: "When it goes up and when it goes down, in one sentence" })}
          className={cn(inputClass, "resize-y text-[13px] leading-relaxed")}
        />
      </Group></div>

      {variable.type === "string" && (
        <Group title={t("variables.optionsLabel")} hint={t("variables.optionsHint")}>
          <OptionsEditor
            key={variable.id}
            values={variable.options ?? []}
            onChange={(options) => commit({ options: options.length > 0 ? options : undefined })}
            addLabel={t("variables.optionsAdd")}
            placeholder={t("variables.optionsPlaceholder")}
          />
        </Group>
      )}

      {/* Precise tracking: the switch is on the heading; the two steppers
          and the one fact only when it is on. */}
      {preciseAllowed && (
        <div data-learn="var-precise"><Group
          title={t("variables.preciseLabel")}
          hint={variable.type === "string" ? t("variables.preciseStringHint") : t("variables.preciseHint")}
          right={<Switch checked={precise} onChange={setPrecise} label={t("variables.preciseLabel")} />}
        >
          {precise && variable.type === "number" && (
            <>
              <Row label={t("variables.preciseDown")} hint={t("blueprint.tips.preciseStep")}><Stepper value={down} onChange={(deltaDown) => commit({ deltaDown })} label={t("variables.preciseDown")} /></Row>
              <Row label={t("variables.preciseUp")} hint={t("blueprint.tips.preciseStep")}><Stepper value={up} onChange={(deltaUp) => commit({ deltaUp })} label={t("variables.preciseUp")} /></Row>
            </>
          )}
          {/* Only when something is wrong: the plain "−10 to +10 a turn"
              restated the two steppers right above it. */}
          {preciseFact?.warn && <p className="pt-1 text-[11px] text-destructive">{preciseFact.text}</p>}
        </Group></div>
      )}

      {/* 公式数值: worked out by the engine from other values, after every
          change; the AI reads it and never writes it. */}
      {variable.type === "number" && (
        <More key={`formula:${variableId}`} label={t("blueprint.insp.formula")} defaultOpen={!!variable.formula}>
          <input
            value={variable.formula ?? ""}
            data-var-formula=""
            placeholder={t("blueprint.insp.formulaPlaceholder")}
            onChange={(e) => commit({ formula: e.target.value.trim() ? e.target.value : undefined })}
            className="w-full rounded-md border border-white/10 bg-background px-2 py-1.5 font-mono text-xs outline-none focus:border-sky-400/60"
          />
        </More>
      )}
      <More key={`ai:${variableId}`} label={t("blueprint.insp.aiUse")} defaultOpen={variable.persist === "player"}>
        {/* 跨存档保留: kept for the player across every playthrough. */}
        <Check label={t("blueprint.insp.persistPlayer")} checked={variable.persist === "player"} onChange={(on) => commit({ persist: on ? "player" : undefined })} />
        <Row label={t("variables.aiAccessLabel")} hint={t("blueprint.tips.aiAccess")}>
          <select
            value={variable.aiAccess ?? "write"}
            onChange={(e) =>
              commit({ aiAccess: e.target.value === "write" ? undefined : (e.target.value as Variable["aiAccess"]) })
            }
            className={rowControl}
          >
            {(["write", "read", "none"] as const).map((v) => (
              <option key={v} value={v}>{t(`variables.aiAccessOptions.${v}` as never)}</option>
            ))}
          </select>
        </Row>
        <Field label={t("blueprint.insp.varWhenExposed")} hint={t("blueprint.tips.varWhen")}>
          <VariableActivationEditor key={variable.id} variable={variable} variables={variables} greetings={greetings} onChange={commit} />
        </Field>
      </More>

      <More>
        <Check
          label={t("blueprint.insp.liveCanonVariableEditable")}
          hint={t("blueprint.insp.liveCanonVariableEditableHint")}
          checked={variable.liveCanonEditable === true}
          onChange={(editable) => commit({ liveCanonEditable: editable || undefined })}
        />
        <Check
          label={t("blueprint.insp.varInternal")}
          hint={t("blueprint.insp.varInternalHint")}
          checked={Boolean(variable.internal)}
          onChange={(internal) => commit({ internal: internal || undefined })}
        />
        <VariableNameReferenceHint world={worldDraft} variable={variable} />
        <VariableIdEditor key={variableId} world={worldDraft} variable={variable} onCommit={(id) => {
          commit({ id });
          return useEditorStore.getState().worldDraft.variables[index]?.id ?? variable.id;
        }} />
      </More>


    </div>
  );
}

export function BehaviorForm({ reactionId }: { reactionId: string }) {
  const { t } = useTranslation("editor");
  const reaction = useEditorStore((s) => (s.worldDraft.reactions ?? []).find((r) => r.id === reactionId));
  const allVariables = useEditorStore((s) => s.worldDraft.variables);
  const entries = useEditorStore((s) => s.worldDraft.entries);
  const audioTracks = useEditorStore((s) => s.worldDraft.audioTracks) ?? [];
  const allReactions = useEditorStore((s) => s.worldDraft.reactions) ?? [];
  const updateReaction = useEditorStore((s) => s.updateReaction);
  // Same picker rule as the full behaviors panel: engine-managed vars stay hidden.
  const variables = useMemo(() => allVariables.filter((v) => !v.internal), [allVariables]);
  // The condition editor can make the variable it needs right there, and go
  // to the one it reads — the round trip through the Variables block is what
  // a tester called "you can't change the variable from here".
  const createVariable = ({ name, type }: { name: string; type: Variable["type"] }) => {
    const store = useEditorStore.getState();
    const defaultValue: Variable["defaultValue"] = type === "number" ? 0 : type === "boolean" ? false : type === "json" ? {} : "";
    const id = store.ensureVariableByName(name, type, defaultValue);
    return useEditorStore.getState().worldDraft.variables.find((v) => v.id === id);
  };
  const jumpToVariable = (id: string) => window.dispatchEvent(new CustomEvent("yumina:studio-canvas-focus", { detail: { objId: `var:${id}` } }));
  if (!reaction) return null;
  const logic = reaction.conditionLogic ?? "all";
  return (
    <div className="space-y-1">
      {/* A behaviour is one sentence — when THIS, if THAT, do THIS — so the
          column is that sentence in three headed groups, each line of it a
          line of text with small glass slots where the changeable parts
          are. The housekeeping (priority, cooldown, chance) folds away. */}
      <div data-learn="rx-when"><Group title={t("blueprint.insp.whenFires")} hint={t("blueprint.tips.whenFires")}>
        <WhenSentence reaction={reaction} variables={variables} onUpdate={(u) => updateReaction(reactionId, u)} />
      </Group></div>
      <div data-learn="rx-if"><Group
        title={t("behaviors.onlyIf")}
        hint={t("blueprint.tips.onlyIf")}
        right={(reaction.conditions?.length ?? 0) > 1 ? (
          <Segmented<"all" | "any">
            label={t("behaviors.onlyIf")}
            value={logic}
            onChange={(conditionLogic) => updateReaction(reactionId, { conditionLogic })}
            options={[{ value: "all", label: t("blueprint.sentence.logicAll") }, { value: "any", label: t("blueprint.sentence.logicAny") }]}
          />
        ) : undefined}
      >
        <ConditionSentences
          conditions={reaction.conditions}
          variables={variables}
          empty={t("blueprint.editing.noExtraConditions", { defaultValue: "No extra conditions. This behavior can run whenever its trigger matches." })}
          onCreateVariable={createVariable}
          onJumpToVariable={jumpToVariable}
          onChange={(conditions) => updateReaction(reactionId, { conditions })}
        />
      </Group></div>
      <div data-learn="rx-then"><Group title={t("blueprint.insp.effects")} hint={t("blueprint.tips.effects")}>
        <EffectSentences
          effects={reaction.then}
          variables={variables}
          entries={entries}
          audioTracks={audioTracks}
          allReactions={allReactions}
          onCreateVariable={createVariable}
          onChange={(then) => updateReaction(reactionId, { then })}
        />
      </Group></div>
      {/* Said to the player when the event happens but the conditions do
          not hold: 「金币不够，还差 {参数.价格}」. */}
      {(reaction.conditions?.length ?? 0) > 0 && (
        <Group title={t("blueprint.insp.elseMessage")}>
          <input
            value={reaction.elseMessage ?? ""}
            data-rx-else=""
            placeholder={t("blueprint.insp.elseMessagePlaceholder")}
            onChange={(e) => updateReaction(reactionId, { elseMessage: e.target.value || undefined })}
            className="w-full rounded-md border border-white/10 bg-background px-2 py-1.5 text-xs outline-none focus:border-amber-400/60"
          />
        </Group>
      )}
      <Group title={t("behaviors.stopWhen")} hint={t("behaviors.stopWhenNote")}>
        <ConditionSentences
          conditions={reaction.stopConditions}
          variables={variables}
          empty={t("behaviors.stopWhenHint")}
          onCreateVariable={createVariable}
          onJumpToVariable={jumpToVariable}
          onChange={(stopConditions) => updateReaction(reactionId, { stopConditions: stopConditions.length ? stopConditions : undefined })}
        />
      </Group>
      <More>
        <Row label={t("behaviors.priority")} hint={t("behaviors.priorityHint")}>
          <Stepper label={t("behaviors.priority")} min={-999} value={reaction.priority ?? 0} onChange={(v) => updateReaction(reactionId, { priority: v })} />
        </Row>
        <Row label={t("behaviors.cooldown")} hint={t("blueprint.tips.cooldown")}>
          <Stepper label={t("behaviors.cooldown")} value={reaction.cooldownTurns ?? 0} onChange={(v) => updateReaction(reactionId, { cooldownTurns: v > 0 ? v : undefined })} />
        </Row>
        <Row label={t("behaviors.maxFireCount")} hint={t("blueprint.tips.maxFire")}>
          <Stepper label={t("behaviors.maxFireCount")} value={reaction.maxFireCount ?? 0} onChange={(v) => updateReaction(reactionId, { maxFireCount: v > 0 ? v : undefined })} />
        </Row>
        {/* 代码行为: what the sentences above cannot say, as the creator's
            own code, run in the card's sandbox when this fires. */}
        <Field label={t("blueprint.insp.code")}>
          <textarea
            rows={reaction.code ? 8 : 3}
            spellCheck={false}
            data-rx-code=""
            value={reaction.code ?? ""}
            placeholder={'ctx.add("金币", 10)\nconst a = await ctx.callAi("对手", "轮到你")'}
            onChange={(e) => updateReaction(reactionId, { code: e.target.value.trim() ? e.target.value : undefined })}
            className="w-full resize-y rounded-md border border-white/10 bg-[#0c0b10] px-2 py-1.5 font-mono text-[11px] leading-relaxed outline-none focus:border-amber-400/60"
          />
        </Field>
        <Row label={t("behaviors.chance")} hint={t("behaviors.chanceHint")}>
          <input
            type="number"
            min={0}
            max={100}
            aria-label={t("behaviors.chance")}
            value={reaction.chance ?? 100}
            onChange={(e) => {
              const n = Math.max(0, Math.min(100, Number(e.target.value) || 0));
              updateReaction(reactionId, { chance: n >= 100 ? undefined : n });
            }}
            className={cn(rowControl, "w-16 text-right tabular-nums")}
          />
        </Row>
      </More>
    </div>
  );
}

/** The card itself — everything the old 概览 page held, so the canvas
 *  needs no detour: its variants on top (switch, add a language, set the
 *  primary), then name, cover and crop, gallery, blurb, language, update
 *  history and import. A secondary variant's public face belongs to its
 *  primary, so there it says so instead, as the variants page does. */
function WorldForm({ onDrill }: { onDrill: (panel: string) => void }) {
  const { t } = useTranslation("editor");
  const settings = useEditorStore((s) => s.worldDraft.settings);
  const setSettings = useEditorStore((s) => s.setSettings);
  const secondary = useEditorStore((s) => s.variants.find((v) => v.id === s.serverWorldId)?.isPrimaryVariant === false);
  return (
    <div className="space-y-3">
      <div data-learn="card-variants" className="-mx-1 overflow-hidden rounded-lg border border-border/60">
        <VariantTabBar compact destination="/app/studio/$worldId" />
      </div>
      {secondary
        ? <p className="text-[13px] leading-relaxed text-muted-foreground">{t("studio.workspace.primaryMetadata")}</p>
        : <OverviewSection embedded />}
      <button
        type="button"
        onClick={() => onDrill("assets")}
        className="studio-control flex w-full items-center justify-center gap-1.5 rounded-lg border px-2.5 py-2 text-xs font-medium text-foreground/70 transition-colors hover:text-foreground hover:bg-accent hover:text-foreground"
      >
        <Images className="h-3.5 w-3.5" />
        {t("blueprint.insp.openAssets")}
      </button>

      {/* What the story AI reads each turn. These used to be the player's
          settings only; the author had no say in how much of the past the
          AI carries. */}
      <Group title={t("blueprint.insp.contextTitle")}>
        <HistoryLimitRow
          value={settings.historyLimit}
          onChange={(v) => setSettings("historyLimit", v)}
          hint={t("blueprint.insp.historyLimitHint")}
        />
        <Check
          label={t("blueprint.insp.contextLock")}
          hint={t("blueprint.insp.contextLockHint", { tokens: settings.maxContext ?? 200000 })}
          checked={settings.contextPolicy === "author"}
          onChange={(locked) => setSettings("contextPolicy", locked ? "author" : "player")}
        />
      </Group>

      <ReplyRulesForm />

      <LiveCanonGroup />
    </div>
  );
}

/** The card-level Lore Shift switches. They are columns on the world row,
 *  not part of the draft, so they read and write through the worlds API the
 *  way the publish dialog does — the same two flags, one source of truth.
 *  Until now the only way to turn them on was to leave the blueprint for the
 *  publish dialog, while the per-entry and per-variable switches sat right
 *  here doing nothing without them. */
/** Whether this card lets players edit their run (Lore Shift), shared so a
 *  setting only offers its own switch once the card does. */
const liveCanonAllowed = new Map<string, boolean>();
const LIVE_CANON_EVENT = "yumina:live-canon-flags";
function useLiveCanonAllowed(worldId: string | null): boolean {
  const [allowed, setAllowed] = useState(() => (worldId ? liveCanonAllowed.get(worldId) ?? false : false));
  useEffect(() => {
    if (!worldId) return;
    const sync = () => setAllowed(liveCanonAllowed.get(worldId) ?? false);
    sync();
    if (!liveCanonAllowed.has(worldId)) {
      fetch(`${apiBase}/api/worlds/${worldId}?forEdit=1`, { credentials: "include" })
        .then((r) => (r.ok ? r.json() : null))
        .then((body: { data?: { allowLiveCanon?: boolean } } | null) => {
          if (!body) return;
          liveCanonAllowed.set(worldId, Boolean(body.data?.allowLiveCanon));
          window.dispatchEvent(new Event(LIVE_CANON_EVENT));
        })
        .catch(() => {});
    }
    window.addEventListener(LIVE_CANON_EVENT, sync);
    return () => window.removeEventListener(LIVE_CANON_EVENT, sync);
  }, [worldId]);
  return allowed;
}

function LiveCanonGroup() {
  const { t } = useTranslation("editor");
  const worldId = useEditorStore((s) => s.serverWorldId);
  const readOnly = useEditorStore((s) => s.readOnlyInspect || s.guestMode);
  const [flags, setFlags] = useState<{ allow: boolean; additions: boolean } | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!worldId) return;
    let cancelled = false;
    setFailed(false);
    fetch(`${apiBase}/api/worlds/${worldId}?forEdit=1`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body: { data?: { allowLiveCanon?: boolean; allowLiveCanonAdditions?: boolean } }) => {
        if (cancelled) return;
        setFlags({
          allow: Boolean(body.data?.allowLiveCanon),
          additions: Boolean(body.data?.allowLiveCanonAdditions),
        });
        liveCanonAllowed.set(worldId, Boolean(body.data?.allowLiveCanon));
        window.dispatchEvent(new Event(LIVE_CANON_EVENT));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [worldId, attempt]);
  if (!worldId || readOnly) return null;
  // A read that failed used to leave this null for good, so the group simply
  // never appeared and nothing said why. Say so, and offer the read again.
  if (!flags) {
    if (!failed) return null;
    return (
      <Group title={t("blueprint.insp.liveCanon")} hint={t("blueprint.tips.liveCanon")}>
        <p className="text-[10px] leading-relaxed text-destructive">
          {t("blueprint.insp.liveCanonLoadFailed", { defaultValue: "Could not load the Lore Shift settings." })}
        </p>
        <button
          type="button"
          onClick={() => setAttempt((n) => n + 1)}
          className="self-start rounded-md px-1.5 py-0.5 text-[11px] text-foreground/70 transition-colors hover:bg-white/[0.07] hover:text-foreground"
        >
          {t("versionHistory.retry")}
        </button>
      </Group>
    );
  }

  const save = async (next: { allow: boolean; additions: boolean }) => {
    const previous = flags;
    // Turning the master switch off takes additions with it — the server
    // enforces the same rule, so the panel never shows a state it cannot hold.
    const settled = next.allow ? next : { allow: false, additions: false };
    setFlags(settled);
    if (worldId) { liveCanonAllowed.set(worldId, settled.allow); window.dispatchEvent(new Event(LIVE_CANON_EVENT)); }
    setFailed(false);
    try {
      const res = await fetch(`${apiBase}/api/worlds/${worldId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ allowLiveCanon: settled.allow, allowLiveCanonAdditions: settled.additions }),
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      setFlags(previous);
      setFailed(true);
    }
  };

  return (
    <Group title={t("blueprint.insp.liveCanon")} hint={t("blueprint.tips.liveCanon")}>
      <Check
        label={t("blueprint.insp.allowLiveCanon")}
        hint={t("blueprint.insp.allowLiveCanonHint")}
        checked={flags.allow}
        onChange={(allow) => void save({ allow, additions: flags.additions })}
      />
      {flags.allow && (
        <Check
          label={t("blueprint.insp.allowLiveCanonAdditions")}
          hint={t("blueprint.insp.allowLiveCanonAdditionsHint")}
          checked={flags.additions}
          onChange={(additions) => void save({ allow: true, additions })}
        />
      )}
      {failed && (
        <p className="text-[10px] leading-relaxed text-destructive">{t("blueprint.insp.liveCanonSaveFailed")}</p>
      )}
    </Group>
  );
}

/** "All" or "the latest N messages" — one row, shaped like the other settings. */
function HistoryLimitRow({ value, onChange, hint }: { value: number | undefined; onChange: (v: number | undefined) => void; hint?: string }) {
  const { t } = useTranslation("editor");
  const limited = typeof value === "number" && value > 0;
  return (
    <Row label={t("blueprint.insp.historyLimit")} hint={hint}>
      <div className="flex w-full items-center justify-end gap-1.5">
        <select
          value={limited ? "latest" : "all"}
          onChange={(e) => onChange(e.target.value === "latest" ? (limited ? value : 20) : undefined)}
          className={cn(inputClass, "w-auto min-w-0 flex-1")}
        >
          <option value="all">{t("blueprint.insp.historyAll")}</option>
          <option value="latest">{t("blueprint.insp.historyLatest")}</option>
        </select>
        {limited && (
          <input
            type="number"
            min={1}
            max={500}
            value={value}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n >= 1) onChange(Math.min(500, Math.floor(n)));
            }}
            aria-label={t("blueprint.insp.historyLatestCount")}
            className={cn(inputClass, "w-16 shrink-0 text-right tabular-nums")}
          />
        )}
      </div>
    </Row>
  );
}


type Translate = (key: string, opts?: Record<string, unknown>) => string;

/**
 * A frame's settings. An AI and a place are set differently because they are
 * different things: an AI is who talks, when it is there, what it knows and
 * remembers; a place is when it applies and what it hands to whoever talks.
 */
function ModuleForm({ worldbookId, onOpenObject }: { worldbookId: string; onOpenObject?: (objectId: string) => void }) {
  const book = useEditorStore((s) => (s.worldDraft.worldbooks ?? []).find((w) => w.id === worldbookId));
  if (!book) return null;
  return book.station
    ? <AiFrameForm worldbookId={worldbookId} onOpenObject={onOpenObject} />
    : <PlaceForm worldbookId={worldbookId} onOpenObject={onOpenObject} />;
}

/** The note and the share button: the same under both. */
function FrameAdvanced({ worldbookId }: { worldbookId: string }) {
  const { t } = useTranslation("editor");
  const book = useEditorStore((s) => (s.worldDraft.worldbooks ?? []).find((w) => w.id === worldbookId));
  const updateWorldbook = useEditorStore((s) => s.updateWorldbook);
  if (!book) return null;
  return (
    <More key={`advanced:${worldbookId}`} label={t("blueprint.insp.situationAdvanced")} defaultOpen={Boolean(book.note?.trim())}>
      <details open={Boolean(book.note?.trim())} className="rounded-lg border border-white/[0.06] px-2.5 py-2">
        <summary className="cursor-pointer text-xs font-medium text-foreground/60 hover:text-foreground">{t("blueprint.insp.note")}</summary>
        <div className="pt-2">
        <DebouncedTextarea
          value={book.note ?? ""}
          onCommit={(note) => updateWorldbook(worldbookId, { note: note.trim() ? note : undefined })}
          syncKey={worldbookId}
          placeholder={t("blueprint.insp.notePlaceholder")}
          className={cn(inputClass, "min-h-[72px] resize-y")}
        />
        </div>
      </details>
      <ShareModuleButton book={book} />
    </More>
  );
}

function PlaceForm({ worldbookId, onOpenObject }: { worldbookId: string; onOpenObject?: (objectId: string) => void }) {
  const { t } = useTranslation("editor");
  const world = useEditorStore((s) => s.worldDraft);
  const book = useEditorStore((s) => (s.worldDraft.worldbooks ?? []).find((w) => w.id === worldbookId));
  const updateWorldbook = useEditorStore((s) => s.updateWorldbook);
  const roster = useMemo(() => aiRoster(world, t as Translate), [world, t]);
  if (!book) return null;
  return (
    <div className="space-y-3">
      {/* When this place applies. It used to be a read-only line with a
          paragraph about drawing a wire; the one property that decides
          whether a module ever runs has to be settable here. */}
      <Field label={t("blueprint.insp.whenOpen")}>
        <ModuleActivationEditor
          book={book}
          onChange={(activation) => updateWorldbook(worldbookId, { activation })}
        />
        {hasSeveralAis(roster) && <p className="pt-1.5 text-[11.5px] text-muted-foreground" data-place-gives>{placeGivesTo(roster, t as Translate)}</p>}
      </Field>
      {/* What is inside, by name — each a jump to its own page. */}
      <details open className="rounded-lg border border-white/[0.06] px-2.5 py-2">
        <summary className="cursor-pointer text-xs font-medium text-foreground/60 hover:text-foreground">{t("modules.contents")}</summary>
        <div className="pt-2"><ModuleContents book={book} editVia="studio" ownOnly onOpenObject={onOpenObject} /></div>
      </details>
      <div className="border-t border-white/[0.06] pt-2">
        <Check label={t("blueprint.insp.enabled")} hint={t("blueprint.tips.situationEnabled")} checked={book.enabled !== false} onChange={(enabled) => updateWorldbook(worldbookId, { enabled })} />
      </div>
      <FrameAdvanced worldbookId={worldbookId} />
    </div>
  );
}

export function AiFrameForm({ worldbookId, onOpenObject }: { worldbookId: string; onOpenObject?: (objectId: string) => void }) {
  const { t } = useTranslation("editor");
  const book = useEditorStore((s) => (s.worldDraft.worldbooks ?? []).find((w) => w.id === worldbookId));
  const allBooks = useEditorStore((s) => s.worldDraft.worldbooks);
  const updateWorldbook = useEditorStore((s) => s.updateWorldbook);
  if (!book?.station) return null;
  const station = book.station;
  const voice = voiceOf(station);
  // A new AI waits for words that are not written yet, so it does not reply
  // in the narrator's place before the creator says when. Behind the scenes
  // it runs on its own trigger: still waiting for those words, it never would.
  const activation = book.activation;
  const waitingForWords = activation?.mode === "keywords" && !(activation.keywords ?? []).some((k) => k.trim());
  const behindActivation = waitingForWords ? { activation: { mode: "always" as const } } : {};
  const setVoice = (next: AiVoice) => {
    if (next === voice) return;
    // One that replies has the conversation already: the wire behind the
    // scenes reads it through goes. One going behind the scenes gets that
    // wire if it has none, or it would have nothing to work from.
    const coreTranscript = (i: ModuleContextInput) => i.kind === "transcript" && i.from === "core";
    if (next === "reply") {
      const inputs = (station.inputs ?? []).filter((i) => !coreTranscript(i));
      updateWorldbook(worldbookId, { station: { ...station, kind: "narrator", trigger: undefined, task: undefined, onClose: station.onClose ?? "keep", inputs: inputs.length ? inputs : undefined } });
    } else if (next === "quiet") {
      updateWorldbook(worldbookId, { ...behindActivation, station: { ...station, kind: "worker", trigger: { on: "quiet", seconds: 60 } } });
    } else {
      const inputs = station.inputs?.length ? station.inputs : [{ kind: "transcript" as const, from: "core", limit: 20 }];
      updateWorldbook(worldbookId, { ...behindActivation, station: { ...station, kind: "worker", trigger: { on: "turns", every: 3 }, inputs } });
    }
  };
  // Every way an AI can run, in one list: answering the player is one of
  // them, not a separate kind of thing chosen first. The details each needs
  // (how many seconds, every how many turns, which condition, which AI) open
  // under it, in the console below.
  type RunWhen = "reply" | "quiet" | "turns" | "conditions" | "after" | "module-closed" | "ui";
  const runWhen: RunWhen = station.kind === "narrator" ? "reply" : ((station.trigger?.on as RunWhen | undefined) ?? "turns");
  const setRunWhen = (next: RunWhen) => {
    if (next === runWhen) return;
    if (next === "reply" || next === "quiet") return setVoice(next);
    const trigger: WorkerTrigger = next === "ui" ? { on: "ui" }
      : next === "turns" ? { on: "turns", every: 3 }
      : next === "conditions" ? { on: "conditions", conditions: [] }
      : next === "after" ? { on: "after", from: (allBooks ?? []).find((b) => b.id !== worldbookId && b.station?.kind === "narrator")?.id ?? "" }
      : { on: "module-closed", from: ANY_MODULE };
    // Behind the scenes it has nothing to work from but what is wired in; the
    // conversation is wired in unless something already is.
    const inputs = station.inputs?.length ? station.inputs : [{ kind: "transcript" as const, from: "core", limit: 20 }];
    updateWorldbook(worldbookId, { ...behindActivation, station: { ...station, kind: "worker", trigger, inputs } });
  };
  void voice;
  // The three kinds first (owner, 10/6), by what calls it; then, inside the
  // kind, exactly when.
  const type = aiTypeOf(station);
  const RUNS: Record<AiType, RunWhen[]> = { turn: ["reply", "turns", "after"], ui: [], code: ["conditions", "module-closed", "quiet"] };
  return (
    <div className="space-y-3" data-ai-form>
      <Field label={t("blueprint.aiForm.type")}>
        <div className="grid grid-cols-3 gap-1" role="radiogroup" data-ai-type-pick="">
          {(["turn", "ui", "code"] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={type === k}
              data-ai-type-option={k}
              onClick={() => { if (k !== type) setRunWhen(RUNS[k][0] ?? "ui"); }}
              className={cn(
                "rounded-md border px-2 py-1.5 text-[11.5px] font-semibold transition-colors",
                type === k ? "border-pink-400/60 bg-pink-400/[0.12] text-foreground" : "border-white/10 text-muted-foreground hover:text-foreground",
              )}
            >
              {t(`blueprint.aiType.${k}`)}
            </button>
          ))}
        </div>
      </Field>
      {RUNS[type].length > 0 ? (
        <Field label={t("blueprint.aiForm.runWhen")}>
          <select
            value={runWhen}
            onChange={(e) => setRunWhen(e.target.value as RunWhen)}
            data-ai-run-when=""
            className="w-full rounded-md border border-white/10 bg-background px-2 py-1.5 text-xs outline-none focus:border-pink-400/60"
          >
            {RUNS[type].map((v) => (
              <option key={v} value={v}>{t(`blueprint.aiForm.run.${v}` as never)}</option>
            ))}
          </select>
        </Field>
      ) : (
        // A UI-based AI runs when a button on the player's screen calls it:
        // the one thing left to do is hook it to one.
        <button
          type="button"
          data-ai-hook-ui=""
          onClick={() => window.dispatchEvent(new CustomEvent("yumina:studio-stage-open-panel", { detail: { panelId: "frontend" } }))}
          className="flex w-full items-center justify-between rounded-md border border-sky-400/30 bg-sky-400/[0.06] px-2.5 py-1.5 text-left text-[11.5px] text-sky-100 hover:border-sky-400/60"
        >
          {t("blueprint.aiForm.hookUi")}
          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        </button>
      )}
      {/* An AI lives somewhere and is in play while that place is: the card,
          a situation, or nowhere yet. One stored the older way (a situation
          that is its own AI) still says when it comes in. Behind the scenes
          too: it runs on its trigger, but only while it is in. */}
      {book.host !== undefined ? (
        <Field label={t("blueprint.aiForm.where")}>
          <select
            value={book.host}
            onChange={(e) => updateWorldbook(worldbookId, { host: e.target.value })}
            data-ai-where=""
            className="w-full rounded-md border border-white/10 bg-background px-2 py-1.5 text-xs outline-none focus:border-pink-400/60"
          >
            <option value="card">{t("blueprint.aiForm.whereCard")}</option>
            {(allBooks ?? [])
              .filter((b) => b.id !== worldbookId && b.id !== UNPLACED_WORLDBOOK_ID && b.host === undefined && b.station?.kind !== "worker")
              .map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            <option value="unplaced">{t("blueprint.aiForm.whereNone")}</option>
          </select>
        </Field>
      ) : (
        <Field label={t("blueprint.aiForm.when")}>
          <ModuleActivationEditor
            book={book}
            onChange={(activation) => updateWorldbook(worldbookId, { activation })}
          />
        </Field>
      )}
      <AiCustomForm worldbookId={worldbookId} />
      <details className="rounded-lg border border-white/[0.06] px-2.5 py-2">
        <summary className="cursor-pointer text-xs font-medium text-foreground/60 hover:text-foreground">{t("blueprint.aiForm.self")}</summary>
        <div className="pt-2"><ModuleContents book={book} editVia="studio" ownOnly onOpenObject={onOpenObject} /></div>
      </details>
      <ModuleConsole
        book={book}
        otherBooks={(allBooks ?? []).filter((b) => b.id !== worldbookId)}
        onChange={(patch) => updateWorldbook(worldbookId, patch)}
        kindControl={false}
        triggerPicker={false}
        summary={false}
      />
      <div className="border-t border-white/[0.06] pt-2">
        <Check label={t("blueprint.insp.enabled")} hint={t("blueprint.tips.situationEnabled")} checked={book.enabled !== false} onChange={(enabled) => updateWorldbook(worldbookId, { enabled })} />
      </div>
      <FrameAdvanced worldbookId={worldbookId} />
      {book.host !== undefined ? (
        // An AI that lives somewhere is not a place to fall back to: removing
        // it takes who it is with it, or its brief would land in the whole
        // card's prompt. Its values and behaviours go back to the card.
        <button
          type="button"
          data-ai-remove
          onClick={() => {
            const store = useEditorStore.getState();
            store.beginBatch();
            try {
              for (const e of store.worldDraft.entries.filter((x) => x.worldbookId === worldbookId)) store.removeEntry(e.id);
              store.removeWorldbook(worldbookId);
            } finally {
              store.commitBatch();
            }
          }}
          className="px-0.5 text-left text-[11.5px] text-muted-foreground underline-offset-2 hover:text-rose-300 hover:underline"
        >
          {t("blueprint.aiForm.remove")}
        </button>
      ) : (
        <button
          type="button"
          data-ai-to-place
          onClick={() => updateWorldbook(worldbookId, { station: undefined })}
          className="px-0.5 text-left text-[11.5px] text-muted-foreground underline-offset-2 hover:text-rose-300 hover:underline"
        >
          {t("blueprint.aiForm.toPlace")}
        </button>
      )}
    </div>
  );
}

// ── Edge payload editing ────────────────────────────────────────────

type EdgePayload =
  | { kind: "condition"; operator: string; value: unknown }
  | { kind: "seed"; value: unknown }
  | { kind: "plain" };

const CONDITION_OPERATORS = ["eq", "neq", "gt", "gte", "lt", "lte", "contains"] as const;

/** Look up the schema payload behind a projected edge id. Mirrors the
 *  compiler's edge-id grammar; stale ids resolve to "plain". */
function resolveEdgePayload(world: WorldDefinition, edgeId: string): EdgePayload {
  let m: RegExpExecArray | null;
  if ((m = /^e:var:(.+?)->module:(.+?):(\d+)$/.exec(edgeId))) {
    const book = (world.worldbooks ?? []).find((b) => b.id === m![2]);
    if (book?.activation.mode === "conditions") {
      const c = book.activation.conditions[parseInt(m[3]!, 10)];
      if (c && c.variableId === m[1]) return { kind: "condition", operator: c.operator, value: c.value };
    }
    return { kind: "plain" };
  }
  if ((m = /^e:var:(.+?)->entry:(.+?):(\d+)$/.exec(edgeId))) {
    const entry = (world.entries ?? []).find((e) => e.id === m![2]);
    const c = entry?.conditions?.[parseInt(m[3]!, 10)];
    if (c && c.variableId === m[1]) return { kind: "condition", operator: c.operator, value: c.value };
    return { kind: "plain" };
  }
  if ((m = /^e:greeting:(.+?)->var:(.+?)$/.exec(edgeId))) {
    const g = (world.entries ?? []).find((e) => e.id === m![1]);
    const value = g?.initialVariables?.[m[2]!];
    if (value !== undefined) return { kind: "seed", value };
    return { kind: "plain" };
  }
  return { kind: "plain" };
}

/** Parse the inspector's free-text value into a sensible JSON value. */
function parseEditedValue(raw: string): unknown {
  const t = raw.trim();
  if (t === "") return "";
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  try { return JSON.parse(t); } catch { return t; }
}

function EdgeForm({ edgeId, world, readOnly, onPatch, describe }: {
  edgeId: string;
  world: WorldDefinition;
  readOnly: boolean;
  onPatch: (patch: GraphPatch) => void;
  describe: string;
}) {
  const { t } = useTranslation("editor");
  const payload = useMemo(() => resolveEdgePayload(world, edgeId), [world, edgeId]);
  const [operator, setOperator] = useState(payload.kind === "condition" ? payload.operator : "eq");
  const [value, setValue] = useState(() =>
    payload.kind === "plain" ? "" : typeof payload.value === "string" ? payload.value : JSON.stringify(payload.value),
  );
  // Resync whenever the stored wire changes, not only when another wire is
  // picked. Keyed on the edge alone, an undo left the old text in the field,
  // and the next blur wrote it straight back over the undo. The field only
  // commits on blur/Enter, so the stored value does not move under the
  // creator while they type.
  const payloadKey = payload.kind === "plain" ? "plain"
    : `${payload.kind}|${payload.kind === "condition" ? payload.operator : ""}|${JSON.stringify(payload.value)}`;
  useEffect(() => {
    setOperator(payload.kind === "condition" ? payload.operator : "eq");
    setValue(payload.kind === "plain" ? "" : typeof payload.value === "string" ? (payload.value as string) : JSON.stringify(payload.value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edgeId, payloadKey]);

  const chain = isChainEdge(edgeId);
  const derived = isDerivedEdge(edgeId);
  const editable = !readOnly && !derived && payload.kind !== "plain";

  // Auto-commit like every other drawer form: operator changes apply at once,
  // value edits apply on blur / Enter. Unchanged commits are skipped so a
  // stray blur never dirties the draft.
  const commit = (op: string, raw: string) => {
    if (!editable) return;
    const parsed = parseEditedValue(raw);
    if (payload.kind === "condition") {
      if (op === payload.operator && JSON.stringify(parsed) === JSON.stringify(payload.value)) return;
      onPatch({ op: "update-edge", edgeId, data: { operator: op as Condition["operator"], value: parsed } });
    } else if (payload.kind === "seed") {
      if (JSON.stringify(parsed) === JSON.stringify(payload.value)) return;
      onPatch({ op: "update-edge", edgeId, data: { value: parsed } });
    }
  };

  return (
    <div className="space-y-3">
      <p className="rounded-lg border border-white/[0.06] bg-white/[0.035] px-2.5 py-2 text-[11px] leading-relaxed text-foreground/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">{describe}</p>
      {chain && (
        <p className="text-[11px] leading-relaxed text-foreground/45">{t("blueprint.insp.chainHint")}</p>
      )}
      {derived && !chain && (
        <p className="text-[11px] leading-relaxed text-foreground/45">{t("blueprint.insp.ownedHint")}</p>
      )}
      {editable && payload.kind === "condition" && (
        <Field label={t("blueprint.inspector.operator")}>
          <select
            value={operator}
            onChange={(e) => {
              setOperator(e.target.value);
              commit(e.target.value, value);
            }}
            className={inputClass}
          >
            {CONDITION_OPERATORS.map((op) => (
              <option key={op} value={op}>{op}</option>
            ))}
          </select>
        </Field>
      )}
      {editable && (
        <Field label={t(payload.kind === "seed" ? "blueprint.inspector.seedValue" : "blueprint.inspector.value")}>
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={() => commit(operator, value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit(operator, value);
            }}
            className={inputClass}
          />
        </Field>
      )}
      {!readOnly && !derived && (
        <button
          type="button"
          onClick={() => onPatch({ op: "remove-edge", edgeId })}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-destructive/40 px-2.5 py-2 text-xs font-semibold text-destructive transition-colors hover:bg-destructive/10"
        >
          <Trash2 className="h-3.5 w-3.5" />
          {t("blueprint.inspector.remove")}
        </button>
      )}
    </div>
  );
}

// ── Drawer shell ────────────────────────────────────────────────────

function ModuleMemoryForm({ worldbookId, onOpenModule }: { worldbookId: string; onOpenModule?: () => void }) {
  const { t } = useTranslation("editor");
  const allBooks = useEditorStore(s => s.worldDraft.worldbooks) ?? [];
  const updateWorldbook = useEditorStore(s => s.updateWorldbook);
  const book = allBooks.find(book => book.id === worldbookId);
  if (!book) return null;
  return <div className="space-y-3">
    <ModuleMemorySettings book={book} otherBooks={allBooks.filter(other => other.id !== worldbookId)} onChange={patch => updateWorldbook(worldbookId, patch)} />
    {onOpenModule && <button type="button" onClick={onOpenModule} className="studio-control flex w-full items-center justify-between rounded-lg border px-2.5 py-2 text-xs text-foreground/70 hover:text-foreground">
      {t("blueprint.insp.openModuleSettings")}<ChevronRight className="h-3.5 w-3.5" />
    </button>}
  </div>;
}

/**
 * The card's own memory, for a card that has no modules.
 *
 * Everything here already existed inside the full lorebook editor, three
 * screens away from the board — which is the same as not existing for anyone
 * who has not gone looking. The board now draws the card's memory as a block
 * whether or not there is anything to say about it, and this is what opens
 * when you click it.
 */
export function CardMemoryForm() {
  const { t } = useTranslation("editor");
  const settings = useEditorStore(s => s.worldDraft.settings);
  const setSettings = useEditorStore(s => s.setSettings);
  const continuityEnabled = useEditorStore(s => s.worldDraft.continuity?.enabled !== false);
  const updateContinuity = useEditorStore(s => s.updateContinuity);
  const limit = settings?.historyLimit;
  return (
    <div className="space-y-4">
      <Group title={t("entries.historyLimit")}>
        <Field>
          <select
            aria-label={t("entries.historyLimit")}
            value={limit ? "latest" : "all"}
            onChange={event => setSettings("historyLimit", event.target.value === "latest" ? (limit ?? 20) : undefined)}
            className={cn(rowControl, "w-full")}
          >
            <option value="all">{t("blueprint.insp.historyAll")}</option>
            <option value="latest">{t("blueprint.insp.historyLatest")}</option>
          </select>
        </Field>
        {limit ? (
          <Row label={t("blueprint.insp.historyLatest")}>
            <DebouncedInput
              type="number"
              min={1}
              max={500}
              aria-label={t("blueprint.insp.historyLatest")}
              value={String(limit)}
              onCommit={raw => {
                const next = Number(raw);
                if (Number.isFinite(next) && next >= 1) setSettings("historyLimit", Math.min(500, Math.floor(next)));
              }}
              className={cn(rowControl, "w-20")}
            />
          </Row>
        ) : null}
      </Group>
      <Check
        label={t("blueprint.insp.contextLock")}
        hint={t("blueprint.insp.contextLockHint", { tokens: settings?.maxContext ?? 200000 })}
        checked={settings?.contextPolicy === "author"}
        onChange={locked => setSettings("contextPolicy", locked ? "author" : "player")}
      />
      {/* The judge's one switch. Also on the Overview page; here because the
          memory block is where the board says what this AI does between
          turns, and this is the third of those things. */}
      <Check
        label={t("overview.continuity")}
        hint={t("overview.continuityDesc")}
        checked={continuityEnabled}
        onChange={enabled => updateContinuity({ enabled: enabled ? undefined : false })}
      />
    </div>
  );
}

export type InspectorTarget =
  | { type: "node"; node: GraphNode; title: string; kindLabel: string; section?: "memory" }
  | { type: "edge"; edgeId: string; describe: string }
  /** A whole list block — everything it holds, for the rows a tile folds
   *  behind "N more". The column is where the long list lives; the tile
   *  stays a tile. */
  | { type: "block"; blockId: string; title: string; rows: Array<{ id: string; title: string; kind: GraphNode["kind"]; hint?: string }> };

/** The list a tile folds: every row, a filter box above once there are
 *  enough to want one, each row a way to the object. */
function BlockListForm({ rows, onOpenObject }: { rows: Array<{ id: string; title: string; kind: GraphNode["kind"]; hint?: string }>; onOpenObject?: (id: string) => void }) {
  const { t } = useTranslation("editor");
  const [query, setQuery] = useState("");
  const filterId = useId();
  const q = query.trim().toLowerCase();
  const shown = q ? rows.filter((row) => row.title.toLowerCase().includes(q) || (row.hint ?? "").toLowerCase().includes(q)) : rows;
  return (
    <div className="space-y-2">
      {rows.length > 8 && (
        <input
          id={filterId}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("blueprint.search.placeholder", { defaultValue: "Search names and text" })}
          className={cn(inputClass, "h-8")}
        />
      )}
      <ul className="divide-y divide-white/[0.05] rounded-md border border-white/[0.06]">
        {shown.map((row) => {
          const style = KIND_STYLE[row.kind];
          return (
            <li key={row.id}>
              <button
                type="button"
                onClick={() => onOpenObject?.(row.id)}
                className="flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-white/[0.05]"
              >
                <span className={cn("h-2 w-2 shrink-0 rounded-full", style.port.replace("!bg-", "bg-"))} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-foreground">{row.title}</span>
                  {row.hint && <span className="block truncate text-[11px] text-foreground/45">{row.hint}</span>}
                </span>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-foreground/40" />
              </button>
            </li>
          );
        })}
        {shown.length === 0 && <li className="px-2.5 py-3 text-xs text-foreground/45">{t("blueprint.search.none", { defaultValue: "Nothing matches" })}</li>}
      </ul>
    </div>
  );
}

export function BlueprintInspector({ target, world, readOnly, onPatch, onDrill, onClose, onExpand, onOpenModule, onOpenObject, autoFocusName = false, width, onResize }: {
  target: InspectorTarget;
  world: WorldDefinition;
  /** The canvas's projection of `world`, handed down so the context strip
   *  does not compile a second one per keystroke. */
  graph?: CardGraph;
  readOnly: boolean;
  onPatch: (patch: GraphPatch) => void;
  onDrill: (panelId: string) => void;
  onClose: () => void;
  /** Open this selection in its full workspace without losing the canvas location. */
  onExpand?: () => void;
  onShowRelations?: (objectId: string) => void;
  onOpenMemory?: (worldbookId: string) => void;
  onOpenModule?: (worldbookId: string) => void;
  /** Go to an object listed in a block's full list. */
  onOpenObject?: (objectId: string) => void;
  /** Focus a newly created variable's name once, without refocusing on edits. */
  autoFocusName?: boolean;
  /** A column of its own, draggable. Omitted when the host lends it one that
   *  is already the right size — on the stage this fills the right column,
   *  which has one width for all three of its occupants. */
  width?: number;
  onResize?: (width: number) => void;
}) {
  const { t } = useTranslation("editor");
  const [dragging, setDragging] = useState(false);
  const nameFieldId = useId();
  const nameContainer = useRef<HTMLDivElement>(null);
  const memoryTarget = target.type === "node" && target.section === "memory";
  const cardMemoryTarget = memoryTarget && target.type === "node" && target.node.kind === "world";
  const targetKey = target.type === "node" ? `${target.node.id}:${target.section ?? "settings"}` : target.type === "edge" ? target.edgeId : target.blockId;
  const isVariable = target.type === "node" && target.node.kind === "variable";

  useEffect(() => {
    if (!autoFocusName || !isVariable || readOnly) return;
    let frame = 0;
    let cancelled = false;
    const deadline = performance.now() + 1500;
    const focusName = () => {
      if (cancelled) return;
      // Stage mounts this portal before its companion column becomes visible.
      // A hidden input ignores focus; retry until it actually owns focus.
      const field = nameContainer.current?.querySelector("input");
      field?.focus({ preventScroll: true });
      if (field && document.activeElement === field) {
        field.select();
        return;
      }
      if (performance.now() < deadline) frame = window.requestAnimationFrame(focusName);
    };
    focusName();
    return () => { cancelled = true; window.cancelAnimationFrame(frame); };
  }, [autoFocusName, isVariable, readOnly, targetKey]);

  // Drag the left edge to widen. Pointer capture on window so the drag
  // survives the cursor crossing the canvas underneath.
  useEffect(() => {
    if (!dragging || !onResize) return;
    const onMove = (e: PointerEvent) => onResize(window.innerWidth - e.clientX);
    const onUp = () => setDragging(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [dragging, onResize]);

  let heading: string;
  let body: React.ReactNode = null;
  /** Set for the kinds whose name is theirs to change, so the title bar can be
   *  the name field instead of duplicating it. */
  let rename: ((next: string) => void) | null = null;
  /** The destructive act, in the header's ⋯ menu rather than as a red bar
   *  standing at the bottom of every form. */
  let remove: { confirm: string; run: () => void } | null = null;

  if (target.type === "edge") {
    heading = t("blueprint.inspector.title");
    body = <EdgeForm edgeId={target.edgeId} world={world} readOnly={readOnly} onPatch={onPatch} describe={target.describe} />;
  } else if (target.type === "block") {
    heading = target.title;
    body = <BlockListForm key={target.blockId} rows={target.rows} onOpenObject={onOpenObject} />;
    // The scene images block: the card-wide choice sits above its list, which
    // is where someone looking at the block as a whole goes to change it.
    if (target.rows.some((row) => row.kind === "image")) body = <div className="space-y-4"><SceneImageModeGroup />{body}</div>;
  } else {
    const g = target.node;
    heading = target.title;
    const id = g.id.slice(g.id.indexOf(":") + 1);
    if (memoryTarget) {
      heading = t("blueprint.blocks.context");
    }
    if (!readOnly && !memoryTarget) {
      const store = useEditorStore.getState;
      if (g.kind === "greeting" || (g.kind === "entry" && !g.id.startsWith("module-entries:") && g.id !== "core-entries")) {
        rename = (name) => store().updateEntry(id, { name });
      } else if (g.kind === "variable") {
        if (store().worldDraft.variables.some((v) => v.id === id)) rename = (name) => {
          const i = store().worldDraft.variables.findIndex((v) => v.id === id);
          if (i >= 0) store().updateVariableAt(i, { name });
        };
      } else if (g.kind === "rule" && g.id.startsWith("reaction:")) {
        rename = (name) => store().updateReaction(id, { name });
      } else if (g.kind === "module") {
        rename = (name) => store().updateWorldbook(id, { name });
      } else if (g.kind === "image") {
        rename = (name) => store().updateSceneImage(id, { name });
      }
      const draft = store().worldDraft;
      const named = (name: string | undefined) => name || heading;
      if (g.kind === "variable") {
        const i = draft.variables.findIndex((v) => v.id === id);
        if (i >= 0) remove = { confirm: t("blueprint.insp.deleteVariableConfirm", { name: named(draft.variables[i]?.name) }), run: () => { const j = store().worldDraft.variables.findIndex((v) => v.id === id); if (j >= 0) store().removeVariableAt(j); } };
      } else if (g.kind === "greeting") {
        remove = { confirm: t("blueprint.insp.deleteGreetingConfirm", { name: heading }), run: () => store().removeEntry(id) };
      } else if (g.kind === "entry" && !g.id.startsWith("module-entries:") && g.id !== "core-entries") {
        remove = { confirm: t("blueprint.insp.deleteEntryConfirm", { name: heading }), run: () => store().removeEntry(id) };
      } else if (g.kind === "rule" && g.id.startsWith("reaction:")) {
        remove = { confirm: t("blueprint.insp.deleteBehaviorConfirm", { name: heading }), run: () => store().removeReaction(id) };
      } else if (g.kind === "audio") {
        remove = { confirm: t("blueprint.insp.deleteTrackConfirm", { name: heading, defaultValue: `Delete the track "${heading}"?` }), run: () => store().removeAudioTrack(id) };
      } else if (g.kind === "image") {
        remove = { confirm: t("blueprint.insp.deleteSceneImageConfirm", { name: heading }), run: () => store().removeSceneImage(id) };
      } else if (g.kind === "module") {
        remove = { confirm: t("blueprint.insp.deleteConfirm", { name: heading }), run: () => store().removeWorldbook(id) };
      }
    }
    if (readOnly) {
      body = <p className="text-xs text-foreground/55">{t("blueprint.insp.readOnly")}</p>;
    } else if (cardMemoryTarget) {
      body = <CardMemoryForm />;
    } else if (memoryTarget) {
      body = <ModuleMemoryForm key={id} worldbookId={id} onOpenModule={onOpenModule ? () => onOpenModule(id) : undefined} />;
    } else if (g.kind === "greeting") {
      body = <GreetingForm key={id} entryId={id} onDrill={onDrill} />;
    } else if (g.kind === "entry" && g.id !== "core-entries" && !g.id.startsWith("module-entries:")) {
      body = <EntryForm key={id} entryId={id} />;
    } else if (g.kind === "variable") {
      body = <VariableForm variableId={id} />;
    } else if (g.kind === "rule" && g.id.startsWith("reaction:")) {
      body = <BehaviorForm reactionId={id} />;
    } else if (g.kind === "module") {
      body = <ModuleForm key={id} worldbookId={id} onOpenObject={onOpenObject} />;
    } else if (g.kind === "world") {
      body = <WorldForm onDrill={onDrill} />;
    } else if (g.id === "core-entries") {
      body = (
        <div className="space-y-3">
          <p className="text-xs leading-relaxed text-foreground/55">{t("blueprint.insp.coreEntriesHint")}</p>
        </div>
      );
    } else if (g.id.startsWith("module-entries:")) {
      body = (
        <div className="space-y-3">
          <p className="text-xs leading-relaxed text-foreground/55">{t("blueprint.insp.moduleEntriesHint")}</p>
        </div>
      );
    } else if (g.kind === "component") {
      const readCount = Array.isArray(g.data.readIds) ? g.data.readIds.length : 0;
      const dynamicReads = typeof g.data.dynamicReads === "number" ? g.data.dynamicReads : 0;
      body = (
        <div className="space-y-3">
          <p className="text-xs leading-relaxed text-foreground/55">
            {t("blueprint.insp.frontendReads", { count: readCount })}
          </p>
          {dynamicReads > 0 && (
            <p className="rounded-lg border border-white/[0.06] bg-white/[0.035] px-2.5 py-2 text-[11px] leading-relaxed text-foreground/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
              {t("blueprint.insp.frontendDynamicReads", { count: dynamicReads })}
            </p>
          )}
          {/* The BUILDER, not the code: since adoption became lossless (the
              existing frontend rides along as the base layer) every road to
              the interface leads to the visual editor, and the code stays one
              button away inside it. This was the last fork left pointing the
              old way. */}
          <OpenToolButton labelKey="studio.stage.tabFrontend" onOpen={() => onDrill("frontend")} />
        </div>
      );
    } else if (g.kind === "rule") {
      // A legacy `rule:`, not a reaction. Nothing on the canvas edits those —
      // the old behaviours panel is the only place they exist, so this is a
      // different tool rather than a fuller copy of this one.
      //
      // The row can only spare a few characters for "broken", so the sentence
      // that explains it lives here, next to the button that goes and fixes it.
      body = (
        <div className="flex flex-col gap-3">
          {Array.isArray(g.data.shapeIssues) && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
              <div className="min-w-0">
                <p className="text-xs font-semibold text-destructive">{t("blueprint.nodes.ruleUnreadableTitle")}</p>
                <p className="mt-1 text-[11px] leading-relaxed text-foreground/45">{t("blueprint.nodes.ruleUnreadableBody")}</p>
              </div>
            </div>
          )}
          <OpenToolButton labelKey="studio.panels.behaviors" onOpen={() => onDrill("rules")} />
        </div>
      );
    } else if (g.kind === "audio") {
      body = <AudioTrackForm key={id} trackId={id} onDrill={onDrill} />;
    } else if (g.kind === "image") {
      body = <SceneImageForm key={id} sceneImageId={id} onDrill={onDrill} />;
    }
  }

  // An AI is a module with a mind: its header wears the AI's colour, the
  // same pink as its frame on the board.
  const aiNode = target.type === "node" && target.node.kind === "module" && Boolean(target.node.data.station);
  const iconStyle = target.type === "node"
    ? aiNode
      ? { ...KIND_STYLE.module, icon: Bot, chip: "bg-pink-500/15 text-pink-300", wash: "bg-[radial-gradient(120%_100%_at_0%_0%,rgba(244,114,182,0.10),transparent_60%)]" }
      : KIND_STYLE[target.node.kind]
    : null;
  const Icon = memoryTarget ? History : iconStyle?.icon;

  return (
    <div
      // Flat, opaque, seamless with the frame — the inspector is a column of
      // the studio, not a sheet of glass hovering near one.
      className={cn(
        "studio-column relative flex h-full flex-col",
        onResize ? "shrink-0 border-l border-border/70" : "min-h-0 w-full",
      )}
      style={onResize ? { width } : undefined}
    >
      {/* Resize grip — the full edge is the target, the visible line is thin.
          Only when this is a column of its own; the stage's right column has
          one width for all three of its occupants. */}
      {onResize && (
        <div
          onPointerDown={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDoubleClick={() => onResize(340)}
          title={t("blueprint.insp.resize")}
          className={cn(
            "group absolute -left-1.5 top-0 z-10 h-full w-3 cursor-col-resize",
            "before:absolute before:left-1.5 before:top-0 before:h-full before:w-px before:bg-transparent before:transition-colors",
            "hover:before:bg-amber-400/60",
            dragging && "before:bg-amber-400",
          )}
        />
      )}
      {/* The object's face: its kind as a tinted tile, its name as a title
          (a field only when you reach for it), and the same chips its row
          on the board wears. The kind's colour also washes the top of the
          column, so the column and the block you clicked read as one. */}
      {iconStyle && <div aria-hidden className={cn("pointer-events-none absolute inset-x-0 top-0 h-40", iconStyle.wash)} />}
      <div className="relative grid grid-cols-[auto_1fr_auto] items-center gap-x-2.5 gap-y-1 border-b border-white/[0.07] px-3.5 pb-3 pt-3.5 [grid-template-areas:'tile_name_acts'_'tile_chips_chips']">
        {Icon && iconStyle && (
          <span className={cn("flex h-[34px] w-[34px] shrink-0 items-center justify-center self-start rounded-[9px] shadow-[inset_0_1px_0_rgba(255,255,255,0.14)] [grid-area:tile]", iconStyle.chip)}>
            <Icon className="h-[17px] w-[17px]" />
          </span>
        )}
        {/* The name IS the heading. Every form used to open with a "NAME"
            field repeating what the title bar already said, one line above it. */}
        <div ref={nameContainer} className="min-w-0 [grid-area:name]">
          {rename ? (
            <DebouncedInput
              key={targetKey}
              id={nameFieldId}
              aria-label={isVariable ? t("blueprint.insp.variableName") : t("entries.name")}
              value={heading}
              onCommit={rename}
              syncKey={targetKey}
              flushOnSave
              className="-ml-1 w-full rounded-md border border-transparent bg-transparent px-1 py-0.5 text-[15px] font-semibold text-foreground hover:border-white/[0.08] hover:bg-white/[0.04] focus:studio-control-focus focus:outline-none"
            />
          ) : (
            <div className="truncate text-[15px] font-semibold text-foreground">{heading}</div>
          )}
        </div>
        {/* No chips under the name: kind, type and "精准" repeated what the
            tile and the fields below already say. */}
        <div className="flex items-center gap-0.5 self-start [grid-area:acts]">
          {onExpand && (
            <button type="button" onClick={onExpand} title={t("blueprint.insp.openPage")} aria-label={t("blueprint.insp.openPage")} className="rounded-md p-1.5 text-foreground/50 transition-colors hover:bg-white/[0.07] hover:text-foreground">
              <Maximize2 className="h-4 w-4" />
            </button>
          )}
          {remove && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" title={t("blueprint.insp.more", { defaultValue: "More" })} aria-label={t("blueprint.insp.more", { defaultValue: "More" })} className="rounded-md p-1.5 text-foreground/50 transition-colors hover:bg-white/[0.07] hover:text-foreground data-[state=open]:bg-white/[0.07] data-[state=open]:text-foreground">
                  <MoreHorizontal className="h-4 w-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[10rem]">
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={() => {
                    const { confirm, run } = remove!;
                    void confirmAction(confirm, { tone: "destructive", confirmLabel: t("blueprint.insp.delete") }).then((ok) => { if (ok) run(); });
                  }}
                >
                  <Trash2 className="mr-2 h-3.5 w-3.5" />
                  {t("blueprint.insp.delete")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <button type="button" onClick={onClose} title={t("blueprint.rowEdit.close")} aria-label={t("blueprint.rowEdit.close")} className="rounded-md p-1.5 text-foreground/50 transition-colors hover:bg-white/[0.07] hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto px-3.5 py-3.5">
        {/* Where it is shared and what refers to it are the wires' business
            (视图 → 全部连线), not two lines above every form. */}
        {body}
      </div>
    </div>
  );
}
