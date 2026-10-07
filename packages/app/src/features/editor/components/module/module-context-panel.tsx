import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDownLeft, ArrowUpRight, Boxes, Layers, X } from "lucide-react";
import { ANY_MODULE, isAnyModule, WILDCARD_INPUT_KINDS } from "@yumina/engine";
import type { ModuleContextInput, Worldbook } from "@yumina/engine";
import { useEditorStore } from "@/stores/editor";
import { cn } from "@/lib/utils";
import { formatTokens } from "../../lib/context-budget";
import { contextBadgeFor, moduleContextView, type ContextGroup } from "../../lib/module-context";

/**
 * What this module's AI sees — written down, on the module.
 *
 * "A module is another AI" was true in the engine and invisible in the editor:
 * the only thing on screen was a list of context wires, under a heading, under
 * a classifier, and it named the wires WITHOUT naming everything else that
 * reaches the same turn. So a creator could not answer the question the whole
 * feature exists for — what does the AI inside dungeon B know that the one
 * inside dungeon A does not.
 *
 * Two halves, usable apart:
 *   · the SUMMARY prices everything that reaches this module's turn, grouped
 *     by where it comes from. The canvas inspector wants it; the module page
 *     lists the actual objects instead and does not.
 *   · the WIRES are the context drawn from other modules, declared here on
 *     the module doing the reading, plus who reads this one. The direction
 *     is the layout: "B reads A's run, A never reads B's" is two panels that
 *     differ, not one setting with an arrow to get backwards.
 */

const CARD = "space-y-2 rounded-lg border border-border px-2.5 py-2";
const LABEL = "text-[11px] font-semibold text-foreground";
const HINT = "text-[10px] leading-relaxed text-muted-foreground";
const INPUT =
  "w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-primary/50";

function GroupRow({
  icon: Icon,
  name,
  group,
  tint,
}: {
  icon: typeof Boxes;
  name: string;
  group: ContextGroup;
  tint: string;
}) {
  const { t } = useTranslation("editor");
  const parts: string[] = [];
  if (group.alwaysEntries) {
    parts.push(
      `${t("blueprint.ctx.lore", { count: group.alwaysEntries })} ~${formatTokens(group.alwaysTokens)}`,
    );
  }
  if (group.vars) {
    parts.push(`${t("blueprint.ctx.vars", { count: group.vars })} ~${formatTokens(group.varTokens)}`);
  }
  if (group.behaviors) parts.push(t("blueprint.ctx.behaviors", { count: group.behaviors }));
  return (
    <div className="flex items-start gap-2">
      <Icon className={cn("mt-0.5 h-3 w-3 shrink-0", tint)} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] font-semibold text-foreground/85">{name}</div>
        <div className="text-[10px] text-muted-foreground">
          {parts.length > 0 ? parts.join(" · ") : t("blueprint.ctx.nothing")}
          {group.standbyEntries > 0 && (
            <span className="ml-1 text-muted-foreground/70">
              {t("blueprint.ctx.standby", { count: group.standbyEntries })}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** Everything that reaches this module's turn, grouped and priced. */
export function ModuleContextSummary({ book }: { book: Worldbook }) {
  const { t } = useTranslation("editor");
  const world = useEditorStore((s) => s.worldDraft);
  const view = useMemo(() => moduleContextView(world, book), [world, book]);
  return (
    <div className={CARD}>
      <div className="flex items-baseline justify-between gap-2">
        <span className={LABEL}>
          {view.narrates ? t("blueprint.ctx.title") : t("blueprint.ctx.titleContent")}
        </span>
        <span className="shrink-0 text-[10px] font-bold tabular-nums text-amber-400/80">
          {t("blueprint.ctx.perTurn", {
            // A module that narrates is billed for the whole turn it assembles;
            // one that only contributes is billed for what it contributes.
            n: formatTokens(
              view.narrates ? view.perTurnTokens : view.own.alwaysTokens + view.own.varTokens,
            ),
          })}
        </span>
      </div>

      <div className="space-y-1.5">
        <GroupRow icon={Boxes} name={t("blueprint.ctx.own")} group={view.own} tint="text-amber-400" />
        {/* Everything else in the turn is listed only for a module that has a
            turn. A content module contributes its own shelf and nothing else —
            listing the card's core under "what this module hands over" would
            be claiming credit for content it does not own. */}
        {view.narrates && (
          <GroupRow icon={Layers} name={t("blueprint.ctx.core")} group={view.core} tint="text-zinc-400" />
        )}
        {view.narrates && view.alsoAlwaysOn.map((m) => (
          <div key={m.id} className="flex items-start gap-2">
            <Layers className="mt-0.5 h-3 w-3 shrink-0 text-zinc-500" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[11px] font-semibold text-foreground/70">
                {t("blueprint.ctx.alsoOn", { name: m.name })}
              </div>
              <div className="text-[10px] text-muted-foreground">
                ~{formatTokens(m.alwaysTokens)}
                {m.vars > 0 ? ` · ${t("blueprint.ctx.vars", { count: m.vars })}` : ""}
              </div>
            </div>
          </div>
        ))}
        {view.narrates && view.gatedElsewhere > 0 && (
          <p className={HINT}>{t("blueprint.ctx.gated", { count: view.gatedElsewhere })}</p>
        )}
      </div>

      {/* A module that does not narrate has no context of its own — it is
          content the narrator reads. Saying so is the difference between "I
          understand this module" and "why is half this panel missing". */}
    </div>
  );
}

/** The context drawn from other modules, and who draws from this one. Only a
 *  station has wires; a plain module is content that joins whoever narrates. */
export function ModuleContextWires({
  book,
  otherBooks,
  onChange,
}: {
  book: Worldbook;
  otherBooks: Worldbook[];
  onChange: (patch: Partial<Worldbook>) => void;
}) {
  const { t } = useTranslation("editor");
  const world = useEditorStore((s) => s.worldDraft);
  const view = useMemo(() => moduleContextView(world, book), [world, book]);
  // Who reads THIS module, and what a wire out of here does not carry. Both
  // are facts about other modules, so neither can come from `view`.
  const badge = useMemo(
    () => contextBadgeFor(book, world.worldbooks ?? [book, ...otherBooks]),
    [book, otherBooks, world.worldbooks],
  );
  const readers = badge.links.filter((l) => l.gives.length > 0);
  const station = book.station;
  const inputs = useMemo(() => station?.inputs ?? [], [station]);
  if (!station) return null;

  const patchStation = (patch: Partial<NonNullable<Worldbook["station"]>>) => {
    onChange({ station: { ...station, ...patch } });
  };
  const setInput = (index: number, next: ModuleContextInput) => {
    const list = [...inputs];
    list[index] = next;
    patchStation({ inputs: list });
  };

  return (
    <div className={CARD}>
      {/* Any station, not only a narrator.
          Gating this on "narrates" left a WORKER with no way to say which
          module it reads — and reading another module's transcript is the
          entire job of a worker. The engine has always served both
          (`resolveInputs` asks for a station, not for a narrator); the studio
          simply had no door for half of them. */}
      <div className="space-y-1.5">
        <span className={LABEL}>{t("blueprint.ctx.history")}</span>
        {view.narrates && (
          <div className="text-[10px] leading-relaxed text-muted-foreground">
            {t("blueprint.ctx.ownRun")}
            {" — "}
            {t(view.onClose === "keep" ? "blueprint.ctx.ownRunKeep" : "blueprint.ctx.ownRunArchive")}
          </div>
        )}
        {station.kind === "narrator" && (
          <label className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
            <span className="min-w-0 flex-1">{t("blueprint.station.historyLimit")}</span>
            <span className="flex shrink-0 items-center gap-1">
              <select
                value={station.historyLimit ? "latest" : "card"}
                onChange={(e) => patchStation({ historyLimit: e.target.value === "latest" ? (station.historyLimit ?? 20) : undefined })}
                className="rounded border border-border bg-background px-1 py-0.5 text-[10px] text-foreground"
              >
                <option value="card">{t("blueprint.station.historyLimitCard")}</option>
                <option value="latest">{t("blueprint.insp.historyLatest")}</option>
              </select>
              {station.historyLimit ? (
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={station.historyLimit}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n) && n >= 1) patchStation({ historyLimit: Math.min(500, Math.floor(n)) });
                  }}
                  aria-label={t("blueprint.insp.historyLatestCount")}
                  className="w-12 rounded border border-border bg-background px-1 py-0.5 text-right text-[10px] tabular-nums text-foreground"
                />
              ) : null}
            </span>
          </label>
        )}

        {inputs.map((input, i) => (
          <div key={i} className="space-y-1 rounded-md border border-border/60 p-1.5">
            <div className="flex items-center gap-1">
              <ArrowDownLeft className="h-3 w-3 shrink-0 text-sky-400" />
              <select
                value={input.kind}
                onChange={(e) => {
                  const nextKind = e.target.value as ModuleContextInput["kind"];
                  // "All of them" is not a thing every kind can answer, so a
                  // wire switched to one that cannot falls back to a real
                  // module rather than keeping a reference that reads empty.
                  const from =
                    isAnyModule(input.from) && !WILDCARD_INPUT_KINDS.has(nextKind)
                      ? (otherBooks[0]?.id ?? ANY_MODULE)
                      : input.from;
                  setInput(
                    i,
                    nextKind === "transcript"
                      ? { kind: "transcript", from, limit: 10, as: input.as }
                      : ({ kind: nextKind, from, as: input.as } as ModuleContextInput),
                  );
                }}
                className={cn(INPUT, "min-w-0 flex-1")}
              >
                {(["memory", "worker", "variables", "transcript"] as const).map((k) => (
                  <option key={k} value={k}>
                    {t(`blueprint.station.inputKind.${k}` as never)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => {
                  const list = inputs.filter((_, j) => j !== i);
                  patchStation({ inputs: list.length ? list : undefined });
                }}
                className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="flex items-center gap-1">
              <select
                value={input.from}
                onChange={(e) => setInput(i, { ...input, from: e.target.value } as ModuleContextInput)}
                className={cn(INPUT, "min-w-0 flex-1")}
              >
                {/* The card itself gives its variables, and to an AI behind
                    the scenes its whole conversation's tail (a narrator has
                    that already); the others need a module that has a
                    history to give. */}
                {(input.kind === "variables" || (input.kind === "transcript" && station.kind === "worker")) && <option value="core">{t("blueprint.station.core")}</option>}
                {/* One wire instead of twenty-one: the head archivist reads
                    every dungeon's record without naming them one by one. */}
                {WILDCARD_INPUT_KINDS.has(input.kind) && (
                  <option value={ANY_MODULE}>
                    {t(`blueprint.station.any.${input.kind}` as never)}
                  </option>
                )}
                {otherBooks.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
              <select
                value={input.as ?? "history"}
                onChange={(e) =>
                  setInput(i, {
                    ...input,
                    as: e.target.value === "lore" ? "lore" : "history",
                  } as ModuleContextInput)
                }
                className={cn(INPUT, "w-24 shrink-0")}
              >
                <option value="history">{t("blueprint.station.asHistory")}</option>
                <option value="lore">{t("blueprint.station.asLore")}</option>
              </select>
            </div>
            {input.kind === "transcript" && (
              <label className="flex items-center gap-1.5">
                <span className={HINT}>{t("blueprint.station.transcriptLimit")}</span>
                <input
                  type="number"
                  min={1}
                  max={40}
                  value={input.limit}
                  onChange={(e) => {
                    const limit = Math.max(1, Math.min(40, Number(e.target.value) || 1));
                    setInput(i, { ...input, limit });
                  }}
                  className={cn(INPUT, "w-16")}
                />
              </label>
            )}
            {view.imported[i]?.missing && (
              <p className="text-[10px] text-rose-400">{t("blueprint.ctx.missingSource")}</p>
            )}
          </div>
        ))}

        {otherBooks.length > 0 ? (
          <button
            type="button"
            onClick={() => patchStation({ inputs: [...inputs, { kind: "memory", from: otherBooks[0]!.id }] })}
            className="w-full rounded-md border border-border py-1 text-[11px] text-muted-foreground/80 transition-colors hover:border-primary/50 hover:text-foreground"
          >
            {t("blueprint.station.addInput")}
          </button>
        ) : (
          <p className={HINT}>{t("blueprint.station.noOtherModules")}</p>
        )}

        {/* One hop, said out loud.
            `buildInputBlocksFor` walks this station's own inputs and does
            not recurse, so a chain A -> B -> C leaves C without A. Wiring
            two modules and assuming the third inherits is the mistake this
            model invites, and the only place to catch it is here. */}
        {badge.indirect.map((x, i) => (
          <p key={i} className="text-[10px] leading-relaxed text-amber-300/80">
            {t("blueprint.ctx.chainTrap", { via: x.viaName, source: x.sourceName })}
          </p>
        ))}
      </div>

      {/* The other end of every wire.
          An input is stored on the module doing the reading, so a source
          module used to say nothing at all about being read — and "B sees A,
          A never sees B" was two panels to open and compare. Read-only on
          purpose: it is edited where it is declared. */}
      <div className="space-y-1 border-t border-border/60 pt-2">
        <span className={LABEL}>{t("blueprint.ctx.readBy")}</span>
        {readers.length === 0 ? (
          <p className={HINT}>{t("blueprint.ctx.noReaders")}</p>
        ) : (
          readers.map((l) => (
            <div key={l.otherId} className="flex items-start gap-1.5">
              <ArrowUpRight className="mt-px h-3 w-3 shrink-0 text-violet-400" />
              <span className="text-[10px] leading-relaxed text-muted-foreground">
                {t(l.dir === "both" ? "blueprint.ctx.mutualHint" : "blueprint.ctx.readByHint", {
                  other: l.otherName,
                  reads: l.reads.map((f) => t(`blueprint.ctx.flow.${f.kind}` as never, {
                    n: f.limit ?? 0,
                    as: t(`blueprint.ctx.as.${f.as}` as never),
                  })).join(String(t("blueprint.ctx.flowJoin"))),
                  gives: l.gives.map((f) => t(`blueprint.ctx.flow.${f.kind}` as never, {
                    n: f.limit ?? 0,
                    as: t(`blueprint.ctx.as.${f.as}` as never),
                  })).join(String(t("blueprint.ctx.flowJoin"))),
                })}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** Both halves, for the canvas inspector. */
export function ModuleContextPanel(props: { book: Worldbook; otherBooks: Worldbook[]; onChange: (patch: Partial<Worldbook>) => void }) {
  return (
    <>
      <ModuleContextSummary book={props.book} />
      <ModuleContextWires {...props} />
    </>
  );
}
