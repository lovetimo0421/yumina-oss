import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2, ChevronDown, ShieldAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEditorStore } from "@/stores/editor";
import { ConditionEditor } from "./condition-editor";
import { StyledCheckbox } from "./styled-checkbox";
import { NumberInput } from "@/components/ui/number-input";
import type { BGMTriggerType } from "@yumina/engine";
import { TwoTapDeleteButton } from "@/components/ui/two-tap-delete-button";

const TRIGGER_TYPE_OPTIONS: { value: BGMTriggerType; labelKey: string }[] = [
  { value: "variable", labelKey: "audio.triggerTypes.variable" },
  { value: "ai-keyword", labelKey: "audio.triggerTypes.aiKeyword" },
  { value: "keyword", labelKey: "audio.triggerTypes.keyword" },
  { value: "turn-count", labelKey: "audio.triggerTypes.turnCount" },
  { value: "session-start", labelKey: "audio.triggerTypes.sessionStart" },
];

const PLAY_MODES = [
  { value: "loop", labelKey: "audio.playModes.loop" },
  { value: "shuffle", labelKey: "audio.playModes.shuffle" },
  { value: "sequential", labelKey: "audio.playModes.sequential" },
] as const;

/**
 * World-level BGM configuration: default playlist + conditional rules.
 * Lives outside the per-track detail because both apply to the world,
 * not to any single track.
 */
export function BgmConfigPanel() {
  const { t } = useTranslation("editor");
  const worldDraft = useEditorStore((s) => s.worldDraft);
  const updateBgmPlaylist = useEditorStore((s) => s.updateBgmPlaylist);
  const addConditionalBGM = useEditorStore((s) => s.addConditionalBGM);
  const updateConditionalBGM = useEditorStore((s) => s.updateConditionalBGM);
  const removeConditionalBGM = useEditorStore((s) => s.removeConditionalBGM);

  const audioTracks = worldDraft.audioTracks ?? [];
  const bgmPlaylist = worldDraft.bgmPlaylist;
  const conditionalBGM = worldDraft.conditionalBGM ?? [];
  const bgmTracks = audioTracks.filter((track) => track.type === "bgm");

  return (
    <div className="p-8 lg:p-12">
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="space-y-1">
          <h2 className="text-[22px] font-bold text-foreground tracking-tight">
            {t("audio.bgmConfigTitle")}
          </h2>
          <p className="text-xs text-muted-foreground">{t("audio.bgmConfigDesc")}</p>
        </div>

        {/* ── Default Playlist ── */}
        <div className="rounded-2xl border border-border bg-card p-6">
          <h3 className="text-[15px] font-bold text-foreground tracking-wide mb-6">
            {t("audio.defaultPlaylist")}
          </h3>

          {bgmTracks.length === 0 ? (
            <p className="text-sm text-muted-foreground/50 italic">
              {t("audio.addBgmFirst")}
            </p>
          ) : (
            <div className="space-y-6">
              {/* Track checkboxes */}
              <div className="space-y-2">
                {bgmTracks.map((track) => {
                  const inPlaylist = (bgmPlaylist?.tracks ?? []).includes(track.id);
                  return (
                    <StyledCheckbox
                      key={track.id}
                      checked={inPlaylist}
                      onChange={(v) => {
                        const current = bgmPlaylist?.tracks ?? [];
                        const next = v
                          ? [...current, track.id]
                          : current.filter((id) => id !== track.id);
                        updateBgmPlaylist({ tracks: next });
                      }}
                      label={track.name}
                    />
                  );
                })}
              </div>

              {/* Play Mode */}
              <div className="flex items-center justify-between pt-2 border-t border-border">
                <h4 className="text-[13px] font-bold text-foreground">
                  {t("audio.playMode")}
                </h4>
                <div className="flex rounded-lg border border-border bg-accent/30 p-1">
                  {PLAY_MODES.map((pm) => (
                    <button
                      key={pm.value}
                      onClick={() => updateBgmPlaylist({ playMode: pm.value })}
                      className={cn(
                        "rounded-md px-4 py-1.5 text-xs font-bold transition-colors",
                        (bgmPlaylist?.playMode ?? "loop") === pm.value
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {t(pm.labelKey as any)}
                    </button>
                  ))}
                </div>
              </div>

              {/* Auto-play + Wait for first message */}
              <div className="flex items-center gap-8 pt-2">
                <StyledCheckbox
                  checked={bgmPlaylist?.autoPlay ?? true}
                  onChange={(v) => updateBgmPlaylist({ autoPlay: v })}
                  label={t("audio.autoPlay")}
                />
                <StyledCheckbox
                  checked={bgmPlaylist?.waitForFirstMessage ?? false}
                  onChange={(v) => updateBgmPlaylist({ waitForFirstMessage: v })}
                  label={t("audio.waitForFirstMessage")}
                />
              </div>

              {/* Gap */}
              <div className="space-y-2 flex max-w-[200px] flex-col pt-2">
                <label className="text-[13px] font-bold text-foreground">
                  {t("audio.gapBetweenTracks")}
                </label>
                <NumberInput
                  min={0}
                  max={30}
                  step={1}
                  value={bgmPlaylist?.gapSeconds ?? 0}
                  onChange={(val) =>
                    updateBgmPlaylist({
                      gapSeconds: val === "" ? 0 : Math.max(0, Math.min(30, val)),
                    })
                  }
                />
              </div>
            </div>
          )}
        </div>

        {/* ── Conditional BGM ── */}
        <div className="rounded-2xl border border-border bg-card p-6">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-primary" />
              <h3 className="text-[15px] font-bold text-foreground tracking-wide">
                {t("audio.conditionalBGM")}
              </h3>
            </div>
            {bgmTracks.length > 0 && (
              <button
                onClick={addConditionalBGM}
                className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-4 py-1.5 text-xs font-bold text-primary transition-colors hover:bg-primary/20"
              >
                <Plus className="h-3.5 w-3.5" />
                {t("audio.addConditionalRule")}
              </button>
            )}
          </div>

          {bgmTracks.length === 0 ? (
            <p className="text-sm text-muted-foreground/50 italic">
              {t("audio.addBgmFirst")}
            </p>
          ) : conditionalBGM.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border py-8 text-center">
              <ShieldAlert className="mx-auto h-8 w-8 text-muted-foreground/20" />
              <p className="mt-2 text-sm font-medium text-muted-foreground/50">
                {t("audio.noConditionalRules")}
              </p>
              <p className="mt-1 text-xs text-muted-foreground/40 max-w-sm mx-auto">
                {t("audio.noConditionalRulesDesc")}
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {conditionalBGM.map((rule) => (
                <div
                  key={rule.id}
                  className="rounded-xl border border-border bg-accent/30 p-5 shadow-inner"
                >
                  {/* Rule name + delete */}
                  <div className="flex items-center justify-between mb-5">
                    <input
                      type="text"
                      value={rule.name}
                      onChange={(e) =>
                        updateConditionalBGM(rule.id, { name: e.target.value })
                      }
                      className="bg-transparent text-[14px] font-bold text-primary focus:outline-none focus:border-b focus:border-primary/50 px-1 w-64"
                    />
                    <TwoTapDeleteButton
                      onConfirm={() => removeConditionalBGM(rule.id)}
                      className="text-muted-foreground hover:text-destructive transition-colors"
                      armedClassName="rounded-md p-1 bg-destructive text-destructive-foreground"
                      armedTitle={t("twoTapConfirm")}
                    >
                      <Trash2 className="h-4 w-4" />
                    </TwoTapDeleteButton>
                  </div>

                  <div className="space-y-5">
                    {/* WHEN: trigger type selector */}
                    <div className="flex items-center gap-3">
                      <span className="text-[12px] font-bold text-muted-foreground w-12">
                        {t("audio.when")}
                      </span>
                      <div className="relative flex-1">
                        <select
                          value={rule.triggerType ?? "variable"}
                          onChange={(e) =>
                            updateConditionalBGM(rule.id, {
                              triggerType: e.target.value,
                            })
                          }
                          className="w-full rounded-lg border border-border bg-card px-3 py-2 text-[13px] text-foreground appearance-none cursor-pointer focus:outline-none focus:border-primary/50 [&>option]:bg-popover"
                        >
                          {TRIGGER_TYPE_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {t(opt.labelKey as any)}
                            </option>
                          ))}
                        </select>
                        <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                      </div>
                    </div>

                    {/* Trigger-specific inputs */}
                    <div className="pl-[60px]">
                      {(rule.triggerType ?? "variable") === "variable" && (
                        <>
                          <div className="mb-3">
                            <div className="relative inline-block">
                              <select
                                value={rule.conditionLogic}
                                onChange={(e) =>
                                  updateConditionalBGM(rule.id, {
                                    conditionLogic: e.target.value,
                                  })
                                }
                                className="rounded-lg border border-border bg-card px-3 py-1.5 text-[12px] text-foreground appearance-none cursor-pointer focus:outline-none focus:border-primary/50 pr-7 [&>option]:bg-popover"
                              >
                                <option value="all">{t("audio.allConditionsMet")}</option>
                                <option value="any">{t("audio.anyConditionMet")}</option>
                              </select>
                              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                            </div>
                          </div>
                          <ConditionEditor
                            conditions={rule.conditions}
                            variables={worldDraft.variables}
                            onChange={(conditions) =>
                              updateConditionalBGM(rule.id, { conditions })
                            }
                            label=""
                          />
                          {worldDraft.variables.length === 0 && (
                            <p className="text-xs text-amber-500/70 mt-2">
                              {t("audio.defineVariablesHint")}
                            </p>
                          )}
                        </>
                      )}

                      {((rule.triggerType ?? "variable") === "ai-keyword" ||
                        (rule.triggerType ?? "variable") === "keyword") && (
                        <KeywordInput
                          keywords={rule.keywords ?? []}
                          matchWholeWords={rule.matchWholeWords ?? false}
                          helperText={
                            (rule.triggerType ?? "variable") === "ai-keyword"
                              ? t("audio.triggerAiKeywordHint")
                              : t("audio.triggerPlayerKeywordHint")
                          }
                          onChange={(keywords) =>
                            updateConditionalBGM(rule.id, { keywords })
                          }
                          onToggleWholeWords={(v) =>
                            updateConditionalBGM(rule.id, { matchWholeWords: v })
                          }
                        />
                      )}

                      {(rule.triggerType ?? "variable") === "turn-count" && (
                        <div className="space-y-3">
                          <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-1.5">
                              <label className="text-[12px] font-bold text-muted-foreground">
                                {t("audio.atTurn")}
                              </label>
                              <input
                                type="number"
                                min={1}
                                value={rule.atTurn ?? ""}
                                onChange={(e) =>
                                  updateConditionalBGM(rule.id, {
                                    atTurn: e.target.value ? Number(e.target.value) : undefined,
                                  })
                                }
                                placeholder="e.g. 5"
                                className="w-full rounded-lg border border-border bg-card px-3 py-2 text-[13px] text-foreground focus:outline-none focus:border-primary/50"
                              />
                            </div>
                            <div className="space-y-1.5">
                              <label className="text-[12px] font-bold text-muted-foreground">
                                {t("audio.everyNTurns")}
                              </label>
                              <input
                                type="number"
                                min={1}
                                value={rule.everyNTurns ?? ""}
                                onChange={(e) =>
                                  updateConditionalBGM(rule.id, {
                                    everyNTurns: e.target.value ? Number(e.target.value) : undefined,
                                  })
                                }
                                placeholder="e.g. 10"
                                className="w-full rounded-lg border border-border bg-card px-3 py-2 text-[13px] text-foreground focus:outline-none focus:border-primary/50"
                              />
                            </div>
                          </div>
                          <p className="text-[11px] text-muted-foreground/60">
                            {t("audio.turnCountHint")}
                          </p>
                        </div>
                      )}

                      {(rule.triggerType ?? "variable") === "session-start" && (
                        <p className="text-[12px] text-muted-foreground/60 italic">
                          {t("audio.sessionStartHint")}
                        </p>
                      )}
                    </div>

                    {/* Play track */}
                    <div className="flex items-center gap-3 pt-3">
                      <span className="text-[12px] font-bold text-muted-foreground w-12">
                        {t("audio.play")}
                      </span>
                      <div className="relative flex-1">
                        <select
                          value={rule.targetTrackId}
                          onChange={(e) =>
                            updateConditionalBGM(rule.id, {
                              targetTrackId: e.target.value,
                            })
                          }
                          className="w-full rounded-lg border border-border bg-card px-3 py-2 text-[13px] text-foreground appearance-none cursor-pointer focus:outline-none focus:border-primary/50 [&>option]:bg-popover"
                        >
                          <option value="">{t("audio.selectTrack")}</option>
                          {bgmTracks.map((tr) => (
                            <option key={tr.id} value={tr.id}>
                              {tr.name}
                            </option>
                          ))}
                        </select>
                        <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                      </div>
                    </div>

                    {/* Priority / Fade */}
                    <div className="pt-4 border-t border-border grid grid-cols-1 gap-4 sm:grid-cols-3 sm:gap-6">
                      <div className="space-y-1.5 flex flex-col">
                        <label className="text-[12px] font-bold text-muted-foreground">
                          {t("audio.priority")}
                        </label>
                        <NumberInput
                          min={0}
                          value={rule.priority}
                          onChange={(val) =>
                            updateConditionalBGM(rule.id, {
                              priority: val === "" ? 0 : val,
                            })
                          }
                        />
                      </div>
                      <div className="space-y-1.5 flex flex-col">
                        <label className="text-[12px] font-bold text-muted-foreground">
                          {t("audio.fadeIn")}
                        </label>
                        <NumberInput
                          min={0}
                          step={0.5}
                          value={rule.fadeInDuration}
                          onChange={(val) =>
                            updateConditionalBGM(rule.id, {
                              fadeInDuration: val === "" ? 0 : val,
                            })
                          }
                        />
                      </div>
                      <div className="space-y-1.5 flex flex-col">
                        <label className="text-[12px] font-bold text-muted-foreground">
                          {t("audio.fadeOut")}
                        </label>
                        <NumberInput
                          min={0}
                          step={0.5}
                          value={rule.fadeOutDuration}
                          onChange={(val) =>
                            updateConditionalBGM(rule.id, {
                              fadeOutDuration: val === "" ? 0 : val,
                            })
                          }
                        />
                      </div>
                    </div>

                    {/* On end */}
                    <div className="pt-2">
                      <div className="flex items-center gap-3">
                        <span className="text-[12px] font-bold text-muted-foreground w-12">
                          {t("audio.onEnd")}
                        </span>
                        <div className="relative flex-1">
                          <select
                            value={rule.fallback}
                            onChange={(e) =>
                              updateConditionalBGM(rule.id, {
                                fallback: e.target.value,
                              })
                            }
                            className="w-full rounded-lg border border-border bg-card px-3 py-2 text-[13px] text-foreground appearance-none cursor-pointer focus:outline-none focus:border-primary/50 [&>option]:bg-popover"
                          >
                            <option value="default">{t("audio.returnToDefault")}</option>
                            <option value="previous">{t("audio.returnToPrevious")}</option>
                            {bgmTracks.map((tr) => (
                              <option key={tr.id} value={tr.id}>
                                Play: {tr.name}
                              </option>
                            ))}
                          </select>
                          <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                        </div>
                      </div>
                    </div>

                    {/* Stop previous BGM */}
                    <div className="pt-2">
                      <StyledCheckbox
                        checked={rule.stopPreviousBGM ?? false}
                        onChange={(v) =>
                          updateConditionalBGM(rule.id, { stopPreviousBGM: v })
                        }
                        label={t("audio.stopPreviousBGM")}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="pb-20" />
      </div>
    </div>
  );
}

/** Tag-style keyword input for keyword trigger types */
function KeywordInput({
  keywords,
  matchWholeWords,
  helperText,
  onChange,
  onToggleWholeWords,
}: {
  keywords: string[];
  matchWholeWords: boolean;
  helperText: string;
  onChange: (keywords: string[]) => void;
  onToggleWholeWords: (value: boolean) => void;
}) {
  const { t } = useTranslation("editor");
  const [input, setInput] = useState("");

  function addKeyword() {
    const trimmed = input.trim();
    if (trimmed && !keywords.includes(trimmed)) {
      onChange([...keywords, trimmed]);
    }
    setInput("");
  }

  function removeKeyword(kw: string) {
    onChange(keywords.filter((k) => k !== kw));
  }

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-muted-foreground/60">{helperText}</p>

      {/* Tags */}
      <div className="flex flex-wrap gap-1.5">
        {keywords.map((kw) => (
          <span
            key={kw}
            className="inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-2 py-0.5 text-[12px] font-medium text-primary"
          >
            {kw}
            <button
              onClick={() => removeKeyword(kw)}
              className="text-primary/60 hover:text-primary"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>

      {/* Input */}
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            addKeyword();
          }
        }}
        onBlur={addKeyword}
        placeholder={t("audio.keywordPlaceholder")}
        className="w-full rounded-lg border border-border bg-card px-3 py-2 text-[13px] text-foreground focus:outline-none focus:border-primary/50"
      />

      {/* Whole word toggle */}
      <StyledCheckbox
        checked={matchWholeWords}
        onChange={onToggleWholeWords}
        label={t("audio.matchWholeWords")}
      />
    </div>
  );
}
