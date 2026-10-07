/**
 * The card's Context and its AI, in the inspector column.
 *
 * Context is everything the story AI is given each turn. The form says that
 * in the order it happens — the history window first, since that is the
 * choice with teeth, then the pinned note, the budget, a preview of the
 * assembled turn, and under a fold the things few cards touch (how far the
 * keyword scan looks, cascading triggers, how much state the AI is shown).
 *
 * The AI's own form (CardNarratorForm) is where the judge lives: 智能追踪 is
 * a second AI checking the first one's work after each reply, which is a
 * fact about the AI, not about what it reads.
 */
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { blockId, estimateTokens, type WorldSettings } from "@yumina/engine";
import { Check, Field, Group, More, Row, Segmented, Stepper, inputClass } from "./controls";
import { DebouncedTextarea } from "@/features/editor/components/debounced-field";
import { useEditorStore } from "@/stores/editor";
import { computeContextBudget, formatTokens } from "@/features/editor/lib/context-budget";
import { cn } from "@/lib/utils";

type HistoryMode = "all" | "latest" | "summary";

function historyModeOf(settings: WorldSettings | undefined): HistoryMode {
  if (settings?.storySummary?.enabled) return "summary";
  return settings?.historyLimit ? "latest" : "all";
}

const DEFAULT_LATEST = 20;
const DEFAULT_SUMMARY_LATEST = 30;

export function CardContextForm() {
  const { t } = useTranslation("editor");
  const worldDraft = useEditorStore((s) => s.worldDraft);
  const settings = worldDraft.settings;
  const setSettings = useEditorStore((s) => s.setSettings);
  const mode = historyModeOf(settings);
  const limit = settings?.historyLimit ?? 0;
  const pinned = settings?.pinnedNote;
  const pinnedText = pinned?.content ?? "";
  const variablesMode = settings?.variablesToAi ?? "all";

  const setMode = (next: HistoryMode) => {
    if (next === mode) return;
    if (next === "all") {
      setSettings("historyLimit", undefined);
      setSettings("storySummary", undefined);
      return;
    }
    if (next === "latest") {
      setSettings("storySummary", undefined);
      setSettings("historyLimit", limit || DEFAULT_LATEST);
      return;
    }
    setSettings("historyLimit", limit || DEFAULT_SUMMARY_LATEST);
    setSettings("storySummary", { enabled: true, focus: settings?.storySummary?.focus });
  };

  // The assembled turn, as the engine orders it: the always-on setting, the
  // examples, the summary and history, the pinned note, then the state. The
  // numbers are the board's own estimate (~), the same one the tiles show.
  const budget = useMemo(() => computeContextBudget(worldDraft), [worldDraft]);
  const exampleCount = worldDraft.entries.filter((e) => e.enabled && e.role === "example").length;
  const waiting = Math.max(0, budget.entryCount - budget.alwaysOnCount - exampleCount);
  const pinnedTokens = pinnedText.trim() ? estimateTokens(pinnedText) : 0;
  const preview: Array<{ key: string; text: string; sub?: string; quiet?: boolean }> = [
    { key: "lore", text: t("blueprint.insp.previewLore", { count: budget.alwaysOnCount }), sub: `~${formatTokens(budget.alwaysOnTokens)}` },
    ...(exampleCount ? [{ key: "examples", text: t("blueprint.insp.previewExamples", { count: exampleCount }) }] : []),
    ...(mode === "summary" ? [{ key: "summary", text: t("blueprint.insp.previewSummary") }] : []),
    {
      key: "history",
      text: mode === "all" ? t("blueprint.turnCtx.historyAll") : t("blueprint.insp.previewHistoryLatest", { count: limit }),
    },
    ...(pinnedTokens ? [{ key: "pinned", text: t("blueprint.insp.pinnedNote"), sub: `~${formatTokens(pinnedTokens)}` }] : []),
    ...(waiting ? [{ key: "waiting", text: t("blueprint.insp.previewTriggered", { count: waiting }), quiet: true }] : []),
    ...(variablesMode !== "none" && budget.stateVarCount
      ? [{
          key: "vars",
          text: `${t("blueprint.insp.previewVars", { count: budget.stateVarCount })}${variablesMode === "changed" ? ` · ${t("blueprint.insp.variablesChanged")}` : ""}`,
          sub: variablesMode === "all" ? `~${formatTokens(budget.stateTokens)}` : undefined,
        }]
      : []),
  ];

  return (
    <div className="space-y-1">
      <Group title={t("blueprint.insp.historyLimit")} hint={t("blueprint.insp.historyLimitHint")}>
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
              value={limit}
              min={1}
              onChange={(v) => setSettings("historyLimit", Math.min(500, Math.max(1, v)))}
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
      </Group>

      <Group title={t("blueprint.insp.pinnedNote")} hint={t("blueprint.insp.pinnedNoteHint")}>
        <DebouncedTextarea
          aria-label={t("blueprint.insp.pinnedNote")}
          value={pinnedText}
          onCommit={(next) => setSettings("pinnedNote", next.trim() ? { ...(pinned ?? {}), content: next } : undefined)}
          placeholder={t("blueprint.insp.pinnedNotePlaceholder")}
          rows={2}
          className={cn(inputClass, "min-h-[56px] resize-y")}
        />
        {pinnedText.trim() && (
          <Row label={t("blueprint.insp.pinnedDepth")} hint={t("blueprint.insp.pinnedDepthHint")}>
            <Stepper
              label={t("blueprint.insp.pinnedDepth")}
              value={pinned?.depth ?? 1}
              min={0}
              onChange={(v) => setSettings("pinnedNote", { content: pinnedText, depth: Math.min(50, v) })}
            />
          </Row>
        )}
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

      <More>
        <Row label={t("blueprint.insp.scanDepth")} hint={t("blueprint.insp.scanDepthHint")}>
          <Stepper
            label={t("blueprint.insp.scanDepth")}
            value={settings?.lorebookScanDepth ?? 2}
            min={1}
            onChange={(v) => setSettings("lorebookScanDepth", Math.min(50, v))}
          />
        </Row>
        <Row label={t("blueprint.insp.recursionDepth")} hint={t("blueprint.insp.recursionDepthHint")}>
          <Stepper
            label={t("blueprint.insp.recursionDepth")}
            value={settings?.lorebookRecursionDepth ?? 0}
            min={0}
            onChange={(v) => setSettings("lorebookRecursionDepth", Math.min(10, v))}
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

/** The card's own AI: the one that answers when no situation has taken over.
 *  Its one switch is the judge; what it reads is the Context block's. */
export function CardNarratorForm({ onOpenContext }: { onOpenContext?: () => void }) {
  const { t } = useTranslation("editor");
  const continuityEnabled = useEditorStore((s) => s.worldDraft.continuity?.enabled !== false);
  const updateContinuity = useEditorStore((s) => s.updateContinuity);
  return (
    <div className="space-y-1">
      <p className="pb-2 text-xs leading-relaxed text-foreground/55">{t("blueprint.ctx.row.memoryCardHint")}</p>
      <Group title={t("overview.continuity")} hint={t("overview.continuityDesc")}>
        <Check
          label={t("blueprint.insp.continuityOn")}
          checked={continuityEnabled}
          onChange={(enabled) => updateContinuity({ enabled: enabled ? undefined : false })}
        />
      </Group>
      {onOpenContext && (
        <Group title={t("blueprint.blocks.context")}>
          <button
            type="button"
            onClick={onOpenContext}
            className="studio-control flex w-full items-center justify-between rounded-lg border px-2.5 py-1.5 text-left text-xs text-foreground/80 transition-colors hover:text-foreground"
          >
            <span>{t("blueprint.insp.openContext")}</span>
            <span aria-hidden className="text-foreground/40">›</span>
          </button>
        </Group>
      )}
    </div>
  );
}

/** The Context block's inspector id, for the narrator form's way across. */
export const CONTEXT_BLOCK_ID = blockId.context();
