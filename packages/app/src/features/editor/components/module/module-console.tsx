import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { ANY_MODULE, diagnoseStation, type ModuleStation, type Worldbook } from "@yumina/engine";
import { useModelsStore } from "@/stores/models";
import { useEditorStore } from "@/stores/editor";
import { ConditionEditor } from "../condition-editor";
import { LogicToggle } from "../module-activation-editor";
import { DebouncedInput, DebouncedTextarea } from "../debounced-field";
import { cn } from "@/lib/utils";
import { ModuleContextSummary, ModuleContextWires } from "./module-context-panel";
import { MemoryPoolPicker } from "./memory-pool-picker";
import { StationActivity } from "./station-activity";
import { InfoTip } from "@/components/ui/info-tip";

/**
 * 模块总控 — one panel for everything a module is.
 *
 * It used to be three unrelated boxes in two different screens: a rose "副本模式"
 * toggle, a summary-instruction field that appeared under it, and a sky-blue
 * list of memory subscriptions somewhere below. Each was a separate idea a
 * creator had to discover, and together they still could not express "this
 * module is its own AI".
 *
 * They are one question now — what IS this module — and the answer opens only
 * the fields that answer follows from. A content module shows nothing at all,
 * which is right: that is what almost every module on almost every card is.
 */

const CARD = "space-y-2 rounded-lg border border-border px-2.5 py-2";
const LABEL = "text-[11px] font-semibold text-foreground";
const HINT = "text-[10px] leading-relaxed text-muted-foreground";
const INPUT =
  "w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-primary/50";

type Kind = "content" | "narrator" | "worker";

const kindOf = (book: Worldbook): Kind => book.station?.kind ?? "content";

export function ModuleConsole({
  book,
  otherBooks,
  onChange,
  summary = true,
  showMemory = true,
  kindControl = true,
  triggerPicker = true,
}: {
  book: Worldbook;
  /** Every other module on the card — the sources a wire can point at. */
  otherBooks: Worldbook[];
  onChange: (patch: Partial<Worldbook>) => void;
  /** Whether to price what reaches this module's turn. The canvas inspector
   *  wants the numbers; the module page lists the objects themselves and
   *  does not. */
  summary?: boolean;
  /** Studio gives memory its own canvas node and inspector. Other editors keep it inline. */
  showMemory?: boolean;
  /** The switch between a plain situation, one with its own AI and a
   *  background writer. Off where the AI itself is being edited: there the
   *  question is already answered. */
  kindControl?: boolean;
  /** The worker's 「什么时候跑」 list. Off where the AI's own form asks it,
   *  with every way an AI can run in one list; the details stay here. */
  triggerPicker?: boolean;
}) {
  const { t } = useTranslation("editor");
  const models = useModelsStore((s) => s.models);
  // The model box is an <input list>, and the list was always empty here:
  // nothing outside the chat ever asked for the roster, so an author pinning a
  // module to a model had to know an exact id by heart. fetchModels dedupes and
  // caches, so asking on mount costs one request per editor visit at most.
  useEffect(() => {
    void useModelsStore.getState().fetchModels();
  }, []);
  const kind = kindOf(book);
  const station = book.station;
  // A worker's "when a condition holds" trigger carries its own conditions
  // (WorkerTrigger, read by dueWorkers) — not the module's activation. The
  // editor for them lives here, on the trigger, or it lives nowhere.
  const variables = useEditorStore((s) => s.worldDraft.variables);
  const conditionVariables = useMemo(() => variables.filter((v) => !v.internal), [variables]);
  // The inputs editor used to sit in a "History" fold at the bottom, below
  // memory and activity, where a creator setting up "when it runs" never
  // saw it. It answers the same question as the trigger and the task —
  // what this AI works from — so it opens from that group.
  const [inputsOpen, setInputsOpen] = useState(false);

  // Only arrangements that can never work — a wire whose source produces
  // nothing, a worker with no job. Silence is this feature's failure mode, so
  // the console says the thing the play session never will.
  const problems = useMemo(
    () => diagnoseStation(book, [book, ...otherBooks]),
    [book, otherBooks],
  );

  const patchStation = (patch: Partial<ModuleStation>) => {
    if (!station) return;
    onChange({ station: { ...station, ...patch } });
  };

  const setKind = (next: Kind) => {
    if (next === "content") {
      // Dropping the station keeps the module and its entries; only the
      // machinery goes. Nothing a creator wrote in a field is worth a
      // confirmation dialog they will click through anyway.
      onChange({ station: undefined });
      return;
    }
    onChange({
      station: {
        ...(station ?? {}),
        kind: next,
        ...(next === "narrator" && !station?.onClose ? { onClose: "archive" as const } : {}),
      },
    });
  };

  return (
    <div className="space-y-2">
      {/* One switch, not a taxonomy.
          This used to be a three-way pick — 内容 / 叙述工位 / 后台工位 — put in
          front of a creator whose module was four seconds old. It asked for an
          architecture decision before they had written a single entry, in words
          that mean nothing outside this file, and the answer for almost every
          module on almost every card is the first one.
          So the default is silent, and the only question left is the one that
          actually changes what the player experiences. A worker stays off that
          switch — it is the rare, deliberate one — but it was reachable ONLY
          from the blueprint canvas, which is experimental and which a phone
          cannot draw. One quiet line under the switch is the whole difference
          between rare and unavailable. */}
      {!kindControl ? null : kind === "worker" ? (
        <div className={CARD}>
          <div className="flex items-center justify-between gap-2">
            <span className={LABEL}>{t("blueprint.station.isWorker")}</span>
            <button
              type="button"
              onClick={() => setKind("content")}
              className="shrink-0 rounded-md border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
            >
              {t("blueprint.station.stopBeingWorker")}
            </button>
          </div>
        </div>
      ) : (
        <>
          <label className={cn(CARD, "block cursor-pointer")}>
            <div className="flex items-center justify-between gap-2">
              <span className={cn(LABEL, "flex items-center gap-1.5")}>{t("blueprint.station.takeOver")}<InfoTip text={t("blueprint.station.takeOverHint")} /></span>
              <input
                type="checkbox"
                checked={kind === "narrator"}
                onChange={(e) => setKind(e.target.checked ? "narrator" : "content")}
                className="h-4 w-4 shrink-0 accent-amber-500"
              />
            </div>
          </label>
          {kind === "content" && (
            <button
              type="button"
              onClick={() => setKind("worker")}
              className="px-0.5 text-left text-[10px] leading-relaxed text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
            >
              {t("blueprint.station.makeWorker")}
            </button>
          )}
        </>
      )}

      {problems.length > 0 && (
        <div className="space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-2.5 py-2">
          {problems.map((d, i) => (
            <div key={i} className="flex items-start gap-1.5">
              <AlertTriangle
                className={cn(
                  "mt-px h-3 w-3 shrink-0",
                  d.level === "error" ? "text-rose-400" : "text-amber-400",
                )}
              />
              <span className="text-[10px] leading-relaxed text-foreground/80">
                {t(`blueprint.station.problem.${d.code}` as never, d.params ?? {})}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Always, not only for stations. A plain module still has to answer
          "what does this contribute to the turn" — it is the same question,
          and hiding it behind the switch is what made a module unreadable. */}
      {showMemory && summary && <ModuleContextSummary book={book} />}

      {station && (
        <>
          <details key={book.id} open={Boolean(station.model)} className={CARD}>
            <summary className="cursor-pointer text-[11px] font-semibold text-foreground">{t("blueprint.station.model")}<span className="ml-2 font-normal text-muted-foreground">{station.model || t("blueprint.station.modelInherit")}</span></summary>
            <input
              list={`station-models-${book.id}`}
              value={station.model ?? ""}
              onChange={(e) => patchStation({ model: e.target.value.trim() || undefined })}
              placeholder={t("blueprint.station.modelInherit")}
              className={INPUT}
              spellCheck={false}
            />
            <datalist id={`station-models-${book.id}`}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name || m.id}
                </option>
              ))}
            </datalist>
          </details>

          <div className={CARD} data-testid="station-inputs-entry">
            <div className="flex items-center justify-between gap-2">
              <span className={LABEL}>{t("blueprint.station.inputs")}</span>
              <button
                type="button"
                onClick={() => setInputsOpen((v) => !v)}
                aria-expanded={inputsOpen}
                className="rounded-md border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {t(inputsOpen ? "blueprint.station.inputsDone" : "blueprint.station.inputsEdit")}
              </button>
            </div>
            <p className={HINT}>
              {station.inputs?.length
                ? t("blueprint.station.inputsSummary", { count: station.inputs.length })
                : t("blueprint.station.inputsNone")}
            </p>
            {inputsOpen && <ModuleContextWires book={book} otherBooks={otherBooks} onChange={onChange} />}
          </div>

          {station.kind === "worker" && (
            <>
              <div className={CARD}>
                {triggerPicker && <span className={LABEL}>{t("blueprint.station.trigger")}</span>}
                {triggerPicker && <select
                  value={station.trigger?.on ?? ""}
                  onChange={(e) => {
                    const on = e.target.value;
                    if (!on) return patchStation({ trigger: undefined });
                    if (on === "module-closed")
                      // "Whoever just closed" by default: on a card with one
                      // dungeon it means that dungeon, and on a card with
                      // twenty-two it is the only answer that stays right as
                      // more are added. The old default pointed at whichever
                      // module happened to sort first — or, on a card with
                      // none, at this module itself, which never fires.
                      return patchStation({ trigger: { on: "module-closed", from: ANY_MODULE } });
                    if (on === "turns") return patchStation({ trigger: { on: "turns", every: 5 } });
                    if (on === "after") return patchStation({ trigger: { on: "after", from: otherBooks.find((b) => b.station?.kind === "narrator")?.id ?? "" } });
                    if (on === "quiet") return patchStation({ trigger: { on: "quiet", seconds: 60 } });
                    return patchStation({ trigger: { on: "conditions", conditions: [] } });
                  }}
                  className={INPUT}
                >
                  <option value="">{t("blueprint.station.triggerNever")}</option>
                  <option value="module-closed">{t("blueprint.station.triggerClosed")}</option>
                  <option value="turns">{t("blueprint.station.triggerTurns")}</option>
                  <option value="conditions">{t("blueprint.station.triggerConditions")}</option>
                  <option value="after">{t("blueprint.station.triggerAfter")}</option>
                  <option value="quiet">{t("blueprint.station.triggerQuiet")}</option>
                </select>}
                {station.trigger?.on === "conditions" && (
                  <div className="space-y-2" data-testid="station-trigger-conditions">
                    <div className="rounded-lg border border-sky-500/20 bg-sky-500/5 p-2">
                      <ConditionEditor
                        conditions={station.trigger.conditions}
                        variables={conditionVariables}
                        onChange={(conditions) =>
                          patchStation({
                            trigger: {
                              on: "conditions",
                              conditions,
                              conditionLogic:
                                station.trigger?.on === "conditions" ? station.trigger.conditionLogic : undefined,
                            },
                          })
                        }
                      />
                      {conditionVariables.length === 0 && (
                        <p className="mt-1 text-[10px] text-amber-500/80">{t("modules.noVars")}</p>
                      )}
                    </div>
                    {station.trigger.conditions.length > 1 && (
                      <LogicToggle
                        value={station.trigger.conditionLogic === "any" ? "any" : "all"}
                        onChange={(conditionLogic) =>
                          patchStation({
                            trigger: {
                              on: "conditions",
                              conditions: station.trigger?.on === "conditions" ? station.trigger.conditions : [],
                              conditionLogic,
                            },
                          })
                        }
                      />
                    )}
                  </div>
                )}
                {station.trigger?.on === "module-closed" && (
                  <select
                    value={station.trigger.from}
                    onChange={(e) => patchStation({ trigger: { on: "module-closed", from: e.target.value } })}
                    className={INPUT}
                  >
                    <option value={ANY_MODULE}>{t("blueprint.station.any.closed")}</option>
                    {otherBooks.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                )}
                {station.trigger?.on === "after" && (
                  <select
                    value={station.trigger.from}
                    onChange={(e) => patchStation({ trigger: { on: "after", from: e.target.value } })}
                    className={INPUT}
                    data-testid="station-trigger-after"
                  >
                    {!otherBooks.some((b) => b.id === (station.trigger?.on === "after" ? station.trigger.from : "") && b.station?.kind === "narrator") && (
                      <option value={station.trigger.from}>{t("blueprint.station.afterPick")}</option>
                    )}
                    {otherBooks.filter((b) => b.station?.kind === "narrator").map((b) => (
                      <option key={b.id} value={b.id}>{t("blueprint.station.afterWho", { name: b.name })}</option>
                    ))}
                  </select>
                )}
                {station.trigger?.on === "turns" && (
                  <label className="flex items-center gap-1.5">
                    <span className={HINT}>{t("blueprint.station.everyTurns")}</span>
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={station.trigger.every}
                      onChange={(e) =>
                        patchStation({
                          trigger: { on: "turns", every: Math.max(1, Math.min(100, Number(e.target.value) || 1)) },
                        })
                      }
                      className={cn(INPUT, "w-16")}
                    />
                  </label>
                )}
                {station.trigger?.on === "quiet" && (
                  <label className="flex items-center gap-1.5">
                    <span className={HINT}>{t("blueprint.station.quietSeconds")}</span>
                    <input
                      type="number"
                      min={15}
                      max={3600}
                      step={5}
                      value={station.trigger.seconds}
                      onChange={(e) =>
                        patchStation({
                          trigger: { on: "quiet", seconds: Math.max(15, Math.min(3600, Math.round(Number(e.target.value) || 15))) },
                        })
                      }
                      className={cn(INPUT, "w-20")}
                    />
                    <span className={HINT}>{t("blueprint.station.quietSecondsUnit")}</span>
                  </label>
                )}
              </div>

              <div className={CARD}>
                <span className={cn(LABEL, "flex items-center gap-1.5")}>{t("blueprint.station.task")}<InfoTip text={t("blueprint.station.taskHint")} /></span>
                <DebouncedTextarea
                  value={station.task ?? ""}
                  onCommit={(v) => patchStation({ task: v.trim() ? v : undefined })}
                  syncKey={book.id}
                  rows={3}
                  placeholder={t("blueprint.station.taskPlaceholder")}
                  className={cn(INPUT, "resize-y")}
                />
              </div>
            </>
          )}
          {/* What this AI reads from other modules, and who reads it — after
              the AI's own settings, because a wire is something you draw once
              you know what is on each end. */}
          {/* wires={false}: the station card above already hosts the inputs
              editor, and one screen gets one editor for the same list. */}
          {showMemory && <ModuleMemorySettings book={book} otherBooks={otherBooks} onChange={onChange} summary={false} wires={false} />}
        </>
      )}
    </div>
  );
}

/** The independent memory inspector reuses the same station fields as the full editor. */
export function ModuleMemorySettings({ book, otherBooks, onChange, summary = true, wires = true }: {
  book: Worldbook;
  otherBooks: Worldbook[];
  onChange: (patch: Partial<Worldbook>) => void;
  summary?: boolean;
  /** Whether the inputs editor is folded in here. The memory inspector
   *  stands alone and keeps it; the module console hosts it beside the
   *  trigger and the task instead. */
  wires?: boolean;
}) {
  const { t } = useTranslation("editor");
  const station = book.station;
  const patchStation = (patch: Partial<ModuleStation>) => {
    if (station) onChange({ station: { ...station, ...patch } });
  };
  return <div className="space-y-3">
    {station && <>
          {/* Which memory this AI shares. The card's, a pool of its own, or a
              pool with named others — "A and B share one memory, C and D
              another". It is a VIEW: nothing is deleted, and once you leave,
              what was said inside still joins the transcript for everyone. */}
          {station.kind === "narrator" && (
            <div data-ai-memory>
              <MemoryPoolPicker book={book} allBooks={[book, ...otherBooks]} onChange={onChange} />
            </div>
          )}

          {station.kind === "narrator" && (
            <div className={CARD}>
              <span className={LABEL}>{t("blueprint.station.onClose")}</span>
              <div className="flex gap-1">
                {(["archive", "keep"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => patchStation({ onClose: option })}
                    className={cn(
                      "flex-1 rounded-md px-1.5 py-1 text-[11px] font-medium transition-colors",
                      (station.onClose ?? "archive") === option
                        ? "bg-primary text-primary-foreground"
                        : "border border-border text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {t(`blueprint.station.onClose_${option}` as never)}
                  </button>
                ))}
              </div>
              {(station.onClose ?? "archive") === "archive" && (
                <DebouncedTextarea
                  value={station.archivePrompt ?? ""}
                  onCommit={(v) => patchStation({ archivePrompt: v.trim() ? v : undefined })}
                  syncKey={book.id}
                  rows={2}
                  placeholder={t("blueprint.station.archivePromptPlaceholder")}
                  className={cn(INPUT, "resize-y")}
                />
              )}
            </div>
          )}

      {wires && (
        <details className={CARD}>
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">{t("blueprint.ctx.history")}{Boolean(station.inputs?.length) && <span className="ml-2 tabular-nums">{station.inputs!.length}</span>}</summary>
          <ModuleContextWires book={book} otherBooks={otherBooks} onChange={onChange} />
        </details>
      )}
      <details className={CARD}>
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">{t(station.kind === "worker" ? "blueprint.station.activityWorker" : "blueprint.station.activityRuns")}</summary>
        <StationActivity bookId={book.id} kind={station.kind} />
      </details>
    </>}
    {summary && <details className={CARD}>
      <summary className="cursor-pointer text-xs font-medium text-muted-foreground">{t("blueprint.ctx.title")}</summary>
      <ModuleContextSummary book={book} />
    </details>}
  </div>;
}

export { DebouncedInput };
