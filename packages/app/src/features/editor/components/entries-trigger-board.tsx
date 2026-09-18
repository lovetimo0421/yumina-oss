import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Zap,
  Hash,
  Variable,
  Monitor,
  ChevronRight,
  Sparkles,
} from "lucide-react";
import {
  estimateTokens,
  getEntryBoundSlotId,
  type EntryTriggerCategory,
  type WorldEntry,
} from "@yumina/engine";
import { cn } from "@/lib/utils";
import { useEditorStore } from "@/stores/editor";
import {
  formatConditionLabel,
  normalizeLoreUiBindingsList,
} from "../lib/lore-ui-bindings";

type TriggerKind = EntryTriggerCategory;
type BoardCategory = TriggerKind | "combined";

const CATEGORY_META: Record<
  BoardCategory,
  {
    icon: typeof Zap;
    gradient: string;
    ring: string;
    badge: string;
    labelKey: string;
    hintKey: string;
  }
> = {
  combined: {
    icon: Sparkles,
    gradient: "from-rose-500/20 via-rose-500/5 to-transparent",
    ring: "ring-rose-500/25",
    badge: "bg-rose-500/15 text-rose-600 dark:text-rose-300",
    labelKey: "entries.triggerBoard.combined",
    hintKey: "entries.triggerBoard.combinedHint",
  },
  "always-send": {
    icon: Zap,
    gradient: "from-amber-500/20 via-amber-500/5 to-transparent",
    ring: "ring-amber-500/25",
    badge: "bg-amber-500/15 text-amber-600 dark:text-amber-300",
    labelKey: "entries.triggerBoard.alwaysSend",
    hintKey: "entries.triggerBoard.alwaysSendHint",
  },
  keywords: {
    icon: Hash,
    gradient: "from-sky-500/20 via-sky-500/5 to-transparent",
    ring: "ring-sky-500/25",
    badge: "bg-sky-500/15 text-sky-600 dark:text-sky-300",
    labelKey: "entries.triggerBoard.keywords",
    hintKey: "entries.triggerBoard.keywordsHint",
  },
  variables: {
    icon: Variable,
    gradient: "from-violet-500/20 via-violet-500/5 to-transparent",
    ring: "ring-violet-500/25",
    badge: "bg-violet-500/15 text-violet-600 dark:text-violet-300",
    labelKey: "entries.triggerBoard.variables",
    hintKey: "entries.triggerBoard.variablesHint",
  },
  frontend: {
    icon: Monitor,
    gradient: "from-emerald-500/20 via-emerald-500/5 to-transparent",
    ring: "ring-emerald-500/25",
    badge: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300",
    labelKey: "entries.triggerBoard.frontend",
    hintKey: "entries.triggerBoard.frontendHint",
  },
};

const CATEGORY_ORDER: BoardCategory[] = [
  "combined",
  "frontend",
  "variables",
  "keywords",
  "always-send",
];

function getTriggerKinds(
  entry: WorldEntry,
  slotId: string | null,
): TriggerKind[] {
  if (entry.alwaysSend && !slotId && (entry.conditions?.length ?? 0) === 0) {
    return ["always-send"];
  }

  const kinds: TriggerKind[] = [];
  if (slotId) kinds.push("frontend");
  if ((entry.conditions?.length ?? 0) > 0 || entry.variableBound === true) {
    kinds.push("variables");
  }
  if ((entry.keywords ?? []).length > 0) kinds.push("keywords");
  if (kinds.length === 0) kinds.push("keywords");
  return kinds;
}

function getBoardCategory(kinds: TriggerKind[]): BoardCategory {
  const meaningfulKinds = kinds.filter((kind) => kind !== "always-send");
  if (meaningfulKinds.length > 1) return "combined";
  return kinds[0] ?? "keywords";
}

function conditionSummary(
  entry: WorldEntry,
  variables: ReturnType<typeof useEditorStore.getState>["worldDraft"]["variables"],
): string {
  if ((entry.conditions?.length ?? 0) === 0) return "";
  const vars = variables ?? [];
  const first = entry.conditions![0]!;
  const more = entry.conditions!.length - 1;
  const label = formatConditionLabel(first, vars);
  return more > 0 ? `${label} +${more}` : label;
}

function keywordSummary(entry: WorldEntry): string {
  const keywords = entry.keywords ?? [];
  if (keywords.length === 0) return "";
  const preview = keywords.slice(0, 3).join(", ");
  const more = keywords.length - 3;
  return more > 0 ? `${preview} +${more}` : preview;
}

function TriggerChips({
  entry,
  kinds,
  slotId,
  variables,
  t,
}: {
  entry: WorldEntry;
  kinds: TriggerKind[];
  slotId: string | null;
  variables: ReturnType<typeof useEditorStore.getState>["worldDraft"]["variables"];
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const conditionText = conditionSummary(entry, variables);
  const keywordText = keywordSummary(entry);

  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {kinds.includes("frontend") && (
        <span className="max-w-full truncate rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-300">
          {slotId
            ? t("entries.triggerBoard.frontendChip", { slot: slotId })
            : t("entries.triggerBoard.frontend")}
        </span>
      )}
      {kinds.includes("variables") && (
        <span className="max-w-full truncate rounded-full bg-violet-500/10 px-2 py-0.5 text-[10px] font-medium text-violet-600 dark:text-violet-300">
          {conditionText
            ? t("entries.triggerBoard.variableChip", { condition: conditionText })
            : t("entries.triggerBoard.variables")}
        </span>
      )}
      {kinds.includes("keywords") && (
        <span className="max-w-full truncate rounded-full bg-sky-500/10 px-2 py-0.5 text-[10px] font-medium text-sky-600 dark:text-sky-300">
          {keywordText
            ? t("entries.triggerBoard.keywordChip", { keywords: keywordText })
            : t("entries.triggerBoard.noKeywordsYet")}
        </span>
      )}
      {kinds.includes("always-send") && (
        <span className="max-w-full truncate rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-300">
          {t("entries.triggerBoard.everyTurn")}
        </span>
      )}
    </div>
  );
}

export function EntriesTriggerBoard({
  onSelectEntry,
  onOpenBindings,
}: {
  onSelectEntry: (id: string) => void;
  onOpenBindings: () => void;
}) {
  const { t } = useTranslation("editor");
  const entries = useEditorStore((s) => s.worldDraft.entries);
  const loreUiBindingsRaw = useEditorStore((s) => s.worldDraft.loreUiBindings);
  const variables = useEditorStore((s) => s.worldDraft.variables);

  const bindings = useMemo(
    () => normalizeLoreUiBindingsList(loreUiBindingsRaw),
    [loreUiBindingsRaw],
  );

  const grouped = useMemo(() => {
    const buckets: Record<BoardCategory, WorldEntry[]> = {
      combined: [],
      "always-send": [],
      keywords: [],
      variables: [],
      frontend: [],
    };
    for (const entry of entries ?? []) {
      if (entry.role === "greeting") continue;
      const slotId = getEntryBoundSlotId(entry.id, bindings);
      const kinds = getTriggerKinds(entry, slotId);
      const cat = getBoardCategory(kinds);
      buckets[cat].push(entry);
    }
    for (const key of CATEGORY_ORDER) {
      buckets[key].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    }
    return buckets;
  }, [entries, bindings]);

  const total = CATEGORY_ORDER.reduce((n, k) => n + grouped[k].length, 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">
              {t("entries.triggerBoard.title")}
            </h2>
          </div>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
            {t("entries.triggerBoard.description")}
          </p>
        </div>
        <div className="rounded-full border border-border bg-muted/40 px-3 py-1 text-[11px] font-medium text-muted-foreground">
          {t("entries.triggerBoard.total", { count: total })}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {CATEGORY_ORDER.map((category) => {
          const meta = CATEGORY_META[category];
          const Icon = meta.icon;
          const items = grouped[category];

          return (
            <section
              key={category}
              className={cn(
                "flex min-h-[220px] flex-col overflow-hidden rounded-2xl border border-border/80 bg-card/80 shadow-sm ring-1",
                meta.ring,
              )}
            >
              <div
                className={cn(
                  "border-b border-border/60 bg-gradient-to-br px-4 py-3.5",
                  meta.gradient,
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <span
                      className={cn(
                        "flex h-8 w-8 items-center justify-center rounded-xl",
                        meta.badge,
                      )}
                    >
                      <Icon className="h-4 w-4" />
                    </span>
                    <div>
                      <h3 className="text-sm font-semibold text-foreground">
                        {t(meta.labelKey as any)}
                      </h3>
                      <p className="text-[11px] text-muted-foreground">
                        {t(meta.hintKey as any)}
                      </p>
                    </div>
                  </div>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[10px] font-bold tabular-nums",
                      meta.badge,
                    )}
                  >
                    {items.length}
                  </span>
                </div>
              </div>

              <div className="flex-1 space-y-1.5 overflow-y-auto p-3">
                {items.length === 0 ? (
                  <div className="flex h-full min-h-[120px] flex-col items-center justify-center rounded-xl border border-dashed border-border/70 bg-muted/20 px-4 text-center">
                    <p className="text-xs text-muted-foreground">
                      {category === "frontend"
                        ? t("entries.triggerBoard.frontendEmpty")
                        : category === "combined"
                          ? t("entries.triggerBoard.combinedEmpty")
                        : t("entries.triggerBoard.categoryEmpty")}
                    </p>
                    {category === "frontend" && (
                      <button
                        type="button"
                        onClick={onOpenBindings}
                        className="mt-2 text-xs font-medium text-primary hover:underline"
                      >
                        {t("entries.triggerBoard.openBindings")}
                      </button>
                    )}
                  </div>
                ) : (
                  items.map((entry) => {
                    const slotId = getEntryBoundSlotId(entry.id, bindings);
                    const kinds = getTriggerKinds(entry, slotId);
                    const hasCombinedTriggers = getBoardCategory(kinds) === "combined";
                    const tokens = estimateTokens(entry.content ?? "");

                    return (
                      <button
                        key={entry.id}
                        type="button"
                        onClick={() => {
                          if (category === "frontend") {
                            onOpenBindings();
                          } else {
                            onSelectEntry(entry.id);
                          }
                        }}
                        className="group flex w-full items-start gap-3 rounded-xl border border-transparent bg-background/60 px-3 py-2.5 text-left transition-all hover:border-border hover:bg-accent/50"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-semibold text-foreground">
                              {entry.name || t("entries.unnamed")}
                            </span>
                            {entry.enabled === false && (
                              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase text-muted-foreground">
                                {t("entries.triggerBoard.disabled")}
                              </span>
                            )}
                          </div>
                          {hasCombinedTriggers && (
                            <p className="mt-0.5 text-[11px] font-medium text-muted-foreground">
                              {t("entries.triggerBoard.requiresAll")}
                            </p>
                          )}
                          <TriggerChips
                            entry={entry}
                            kinds={kinds}
                            slotId={slotId}
                            variables={variables}
                            t={t as any}
                          />
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-0.5">
                          <span className="text-[10px] tabular-nums text-muted-foreground/70">
                            ~{tokens} tok
                          </span>
                          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/40 transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </section>
          );
        })}
      </div>

      <div className="rounded-xl border border-border/70 bg-muted/25 px-4 py-3">
        <p className="text-xs font-medium text-foreground">
          {t("entries.triggerBoard.activationTitle")}
        </p>
        <ul className="mt-2 grid gap-1.5 text-[11px] leading-relaxed text-muted-foreground sm:grid-cols-2">
          <li>{t("entries.triggerBoard.activationMount")}</li>
          <li>{t("entries.triggerBoard.activationClick")}</li>
          <li>{t("entries.triggerBoard.activationVariable")}</li>
          <li>{t("entries.triggerBoard.activationTab")}</li>
          <li>{t("entries.triggerBoard.activationScroll")}</li>
          <li>{t("entries.triggerBoard.activationHover")}</li>
        </ul>
      </div>
    </div>
  );
}
