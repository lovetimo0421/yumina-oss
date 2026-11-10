/**
 * The card's Context and its AI, in the inspector column.
 *
 * Context is everything the story AI is given each turn. The form says that
 * in the order it happens — the history window first, since that is the
 * choice with teeth, then the budget, a preview of the assembled turn, then 自定义 — the AI calls the card's own code makes, each
 * with a context of its own — and under a fold the things few cards touch
 * (how far the keyword scan looks, cascading triggers, how much state the AI
 * is shown).
 *
 * The AI's own form (CardNarratorForm) is where the judge lives: 智能追踪 is
 * a second AI checking the first one's work after each reply, which is a
 * fact about the AI, not about what it reads.
 */
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { HISTORY_LIMIT_MAX, blockId, extractAiCallsFromFiles } from "@yumina/engine";
import { Check, Field, Group, More, Row, Segmented, Stepper, inputClass } from "./controls";
import { CustomContextPanel } from "./custom-implementation";
import { DebouncedTextarea } from "@/features/editor/components/debounced-field";
import { useEditorStore } from "@/stores/editor";
import { computeContextBudget, formatTokens } from "@/features/editor/lib/context-budget";
import { cn } from "@/lib/utils";
import { historyModeSettings, historyWindowOf, type HistoryMode } from "@/features/editor/lib/history-mode";
import { contextPreviewCounts } from "./entry-delivery";
import { StoryAiSettings } from "./story-ai-settings";
import { AiTypePicker } from "./ai-contract";

/**
 * The history window: 全部 / 最新 N 条 / 摘要 + 最新 N 条, the count, and the
 * summary's one line of focus. The card's own form and the Context form both
 * show this one control, read and written through history-mode.ts, so the two
 * can never show different windows for the same card.
 */
export function HistoryWindowControl() {
  const { t } = useTranslation("editor");
  const settings = useEditorStore((s) => s.worldDraft.settings);
  const setSettings = useEditorStore((s) => s.setSettings);
  const { mode, count } = historyWindowOf(settings);

  const setMode = (next: HistoryMode) => {
    const write = historyModeSettings(settings, next);
    if (write.historyLimit === settings?.historyLimit && JSON.stringify(write.storySummary) === JSON.stringify(settings?.storySummary)) return;
    // Both halves as one edit: one undo puts the whole window back.
    const store = useEditorStore.getState();
    store.beginBatch();
    try {
      setSettings("historyLimit", write.historyLimit);
      setSettings("storySummary", write.storySummary);
    } finally {
      store.commitBatch();
    }
  };

  return (
    <>
      {/* Three choices need the whole line: in a settings row's right-hand
          column the third one was cut off. */}
      <div className="pb-1.5">
        <Segmented<HistoryMode>
          label={t("blueprint.insp.historyLimit")}
          value={mode}
          onChange={setMode}
          options={[
            { value: "all", label: t("blueprint.insp.historyAll") },
            { value: "latest", label: t("blueprint.insp.historyLatestShort") },
            { value: "summary", label: t("blueprint.insp.historySummaryShort"), hint: t("blueprint.insp.historySummaryHint") },
          ]}
        />
      </div>
      {mode !== "all" && (
        <Row label={t("blueprint.insp.historyLatestCount")}>
          <Stepper
            label={t("blueprint.insp.historyLatestCount")}
            value={count}
            min={1}
            max={HISTORY_LIMIT_MAX}
            onChange={(v) => setSettings("historyLimit", v)}
          />
        </Row>
      )}
      {mode === "summary" && (
        <div className="space-y-2 pt-1">
          <Field label={t("blueprint.insp.summaryFocus")} hint={t("blueprint.insp.summaryFocusHint")}>
            <DebouncedTextarea
              value={settings?.storySummary?.focus ?? ""}
              onCommit={(next) => setSettings("storySummary", { enabled: true, focus: next.trim() || undefined })}
              placeholder={t("blueprint.insp.summaryFocusPlaceholder")}
              rows={2}
              className={cn(inputClass, "min-h-[56px] resize-y")}
            />
          </Field>
          <p className="text-[11px] leading-relaxed text-foreground/50">{t("blueprint.insp.summaryCost")}</p>
        </div>
      )}
    </>
  );
}

export function CardContextForm() {
  const { t } = useTranslation("editor");
  const worldDraft = useEditorStore((s) => s.worldDraft);
  const settings = worldDraft.settings;
  const setSettings = useEditorStore((s) => s.setSettings);
  const { mode, count } = historyWindowOf(settings);
  const variablesMode = settings?.variablesToAi ?? "all";

  // The assembled turn, as the engine orders it: the always-on setting, the
  // examples, the summary and history, then the state. A line that has to sit
  // near the end of the history every turn is an always-on entry placed in
  // the conversation at a depth; it is counted with the setting above. The
  // numbers are the board's own estimate (~), the same one the tiles show.
  const budget = useMemo(() => computeContextBudget(worldDraft), [worldDraft]);
  const counts = useMemo(
    () => contextPreviewCounts(worldDraft.entries, { worldbooks: worldDraft.worldbooks, loreUiBindings: worldDraft.loreUiBindings }),
    [worldDraft.entries, worldDraft.worldbooks, worldDraft.loreUiBindings],
  );
  const alwaysTokens = counts.alwaysIds.reduce((sum, id) => sum + (budget.rows.get(`entry:${id}`)?.tokens ?? 0), 0);
  const { exampleCount, waitingCount: waiting } = counts;
  const files = worldDraft.rootComponent?.files;
  const codeCalls = useMemo(() => (files ? extractAiCallsFromFiles(files).length : 0), [files]);
  const preview: Array<{ key: string; text: string; sub?: string; quiet?: boolean }> = [
    { key: "lore", text: t("blueprint.insp.previewLore", { count: counts.alwaysIds.length }), sub: `~${formatTokens(alwaysTokens)}` },
    ...(exampleCount ? [{ key: "examples", text: t("blueprint.insp.previewExamples", { count: exampleCount }) }] : []),
    ...(mode === "summary" ? [{ key: "summary", text: t("blueprint.insp.previewSummary") }] : []),
    {
      key: "history",
      text: count === undefined ? t("blueprint.turnCtx.historyAll") : t("blueprint.insp.previewHistoryLatest", { count }),
    },
    ...(waiting ? [{ key: "waiting", text: t("blueprint.insp.previewTriggered", { count: waiting }), quiet: true }] : []),
    ...(variablesMode !== "none" && budget.stateVarCount
      ? [{
          key: "vars",
          text: `${t("blueprint.insp.previewVars", { count: budget.stateVarCount })}${variablesMode === "changed" ? ` · ${t("blueprint.insp.variablesChanged")}` : ""}`,
          sub: variablesMode === "all" ? `~${formatTokens(budget.stateTokens)}` : undefined,
        }]
      : []),
    // Not part of this turn: the calls the card's code makes on its own.
    // Said here so the list does not read as everything the card's AI sees.
    ...(codeCalls ? [{ key: "code", text: t("blueprint.insp.previewCode", { count: codeCalls }), quiet: true }] : []),
  ];

  return (
    <div className="space-y-1">
      <Group title={t("blueprint.insp.historyLimit")} hint={t("blueprint.insp.historyLimitHint")}>
        <HistoryWindowControl />
      </Group>

      <Group title={t("blueprint.insp.budget")}>
        <Row label={t("blueprint.insp.budgetValue", { tokens: formatTokens(settings?.maxContext ?? 200000) })}>
          <span className="text-[11px] text-foreground/50">
            {settings?.contextPolicy === "author" ? t("blueprint.insp.budgetAuthor") : t("blueprint.insp.budgetPlayer")}
          </span>
        </Row>
        <Check
          label={t("blueprint.insp.budgetLock")}
          hint={t("blueprint.insp.contextLockHint", { tokens: settings?.maxContext ?? 200000 })}
          checked={settings?.contextPolicy === "author"}
          onChange={(locked) => setSettings("contextPolicy", locked ? "author" : "player")}
        />
      </Group>

      <Group title={t("blueprint.insp.previewTitle")} hint={t("blueprint.insp.previewHint")}>
        <ol className="mt-1 divide-y divide-white/[0.05] rounded-lg border border-white/[0.06]">
          {preview.map((row, i) => (
            <li key={row.key} className={cn("flex items-center gap-2.5 px-2.5 py-1.5 text-[11.5px]", row.quiet ? "text-foreground/45" : "text-foreground/80")}>
              <span className="w-4 shrink-0 text-right tabular-nums text-foreground/35">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate">{row.text}</span>
              {row.sub && <span className="shrink-0 tabular-nums text-foreground/40">{row.sub}</span>}
            </li>
          ))}
        </ol>
      </Group>

      <Group title={t("blueprint.custom.mode_custom")}>
        <CustomContextPanel />
      </Group>

      <More>
        <Row label={t("blueprint.insp.scanDepth")} hint={t("blueprint.insp.scanDepthHint")}>
          <Stepper
            label={t("blueprint.insp.scanDepth")}
            value={settings?.lorebookScanDepth ?? 2}
            min={1}
            max={50}
            onChange={(v) => setSettings("lorebookScanDepth", v)}
          />
        </Row>
        <Row label={t("blueprint.insp.recursionDepth")} hint={t("blueprint.insp.recursionDepthHint")}>
          <Stepper
            label={t("blueprint.insp.recursionDepth")}
            value={settings?.lorebookRecursionDepth ?? 0}
            min={0}
            max={10}
            onChange={(v) => setSettings("lorebookRecursionDepth", v)}
          />
        </Row>
        <Field label={t("blueprint.insp.variablesToAi")} hint={t("blueprint.insp.variablesToAiHint")}>
          <Segmented<"all" | "changed" | "none">
            label={t("blueprint.insp.variablesToAi")}
            value={variablesMode}
            onChange={(v) => setSettings("variablesToAi", v === "all" ? undefined : v)}
            options={[
              { value: "all", label: t("blueprint.insp.variablesAll") },
              { value: "changed", label: t("blueprint.insp.variablesChanged") },
              { value: "none", label: t("blueprint.insp.variablesNone") },
            ]}
          />
        </Field>
      </More>
    </div>
  );
}

/**
 * The card's own AI: the one that answers when no situation has taken over.
 *
 * Laid out like every other AI's form (owner, 10/17): its kind, when it
 * runs, where it is, its model, its judge. On a card with nothing else it is
 * the only AI there is, so its kind switch shows all of them, and picking
 * another adds that AI beside it. What it reads is the Context block's own
 * business, one click away on the board, so the form no longer sends there.
 */
export function CardNarratorForm() {
  const { t } = useTranslation("editor");
  const continuityEnabled = useEditorStore((s) => s.worldDraft.continuity?.enabled !== false);
  const updateContinuity = useEditorStore((s) => s.updateContinuity);
  return (
    <div className="space-y-3" data-card-ai-form="">
      {/* Who sets its settings first (owner, 10/17), then what it is. */}
      <div className="space-y-1">
        {/* Its model and sampling: who decides them, and the way to every
            other AI call on the card. */}
        <StoryAiSettings showAll />
      </div>
      <AiTypePicker value="turn" card />
      <Field label={t("blueprint.aiForm.runWhen")}>
        <p className="studio-control rounded-lg border px-2.5 py-1.5 text-xs text-foreground/80">{t("blueprint.aiForm.run.reply")}</p>
      </Field>
      <Field label={t("blueprint.aiForm.where")}>
        <p className="studio-control rounded-lg border px-2.5 py-1.5 text-xs text-foreground/80">{t("blueprint.aiForm.whereCard")}</p>
      </Field>
      <Group title={t("overview.continuity")} hint={t("overview.continuityDesc")}>
        <Check
          label={t("blueprint.insp.continuityOn")}
          checked={continuityEnabled}
          onChange={(enabled) => updateContinuity({ enabled: enabled ? undefined : false })}
        />
      </Group>
    </div>
  );
}

/** The Context block's inspector id, for the narrator form's way across. */
export const CONTEXT_BLOCK_ID = blockId.context();
