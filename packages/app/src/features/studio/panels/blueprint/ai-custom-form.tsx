import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import type { AiOutputField, AiPromptPiece, Condition, ModuleStation, Variable } from "@yumina/engine";
import { useEditorStore } from "@/stores/editor";
import { cn } from "@/lib/utils";
import { DraftInput, Group, More, NumberInput, Row } from "./controls";
import { parseEditedValue } from "./variable-value";

/**
 * 自定义: what a card's hand-written AI calls do, as settings on the AI.
 *
 * What it sees, the prompt pieces that hold right now, the answer's fields
 * and where each goes, where its words appear, what happens when the model
 * fails. The card's screen calls it with `api.callAi(name, input)` and gets
 * the answer back (server lib/ai-call.ts).
 */

const input = "w-full rounded-md border border-white/10 bg-background px-2 py-1 text-xs outline-none focus:border-pink-400/60";
const small = "rounded-md border border-white/10 bg-background px-1.5 py-1 text-[11px] outline-none focus:border-pink-400/60";
const OPS: Condition["operator"][] = ["gte", "gt", "eq", "neq", "lt", "lte", "contains"];
const OP_SIGN: Record<Condition["operator"], string> = { gte: "≥", gt: ">", eq: "=", neq: "≠", lt: "<", lte: "≤", contains: "∋" };

/** A condition's value as the box shows it. */
const valueText = (value: unknown) => (typeof value === "string" ? value : value === undefined || value === null ? "" : JSON.stringify(value));
/** What a new piece's condition starts at, for the variable it reads. */
const startValue = (v: Variable): Condition["value"] => (v.type === "number" ? 0 : v.type === "boolean" ? true : "");

function lines(text: string): string[] {
  return text.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean);
}

export function AiCustomForm({ worldbookId, open, snippet = true }: { worldbookId: string; open?: boolean; snippet?: boolean }) {
  const { t } = useTranslation("editor");
  const book = useEditorStore((s) => (s.worldDraft.worldbooks ?? []).find((w) => w.id === worldbookId));
  const variables = useEditorStore((s) => s.worldDraft.variables);
  const updateWorldbook = useEditorStore((s) => s.updateWorldbook);
  const station = book?.station;
  if (!book || !station) return null;
  const patch = (next: Partial<ModuleStation>) => updateWorldbook(worldbookId, { station: { ...station, ...next } });
  const varName = (id: string) => variables.find((v) => v.id === id)?.name ?? id;
  const firstVariable = variables[0];

  const sees = station.sees ?? {};
  const pieces = station.pieces ?? [];
  const output = station.output ?? [];
  const say = station.say ?? "story";
  const sayKind = say === "story" || say === "none" ? say : "channel";
  const onError = station.onError ?? {};
  const used = !!(station.sees || station.pieces?.length || station.output?.length || (station.say && station.say !== "story") || station.onError || station.cooldownSec);
  const name = station.name?.trim() || book.name;

  const setPiece = (i: number, next: Partial<AiPromptPiece>) => patch({ pieces: pieces.map((p, j) => (j === i ? { ...p, ...next } : p)) });
  const setField = (i: number, next: Partial<AiOutputField>) => patch({ output: output.map((f, j) => (j === i ? { ...f, ...next } : f)) });

  return (
    <div data-ai-custom="">
    <More label={t("blueprint.aiCustom.title")} defaultOpen={open ?? used}>
      <Group title={t("blueprint.aiCustom.sees")}>
        <div className="flex flex-wrap gap-1">
          {(sees.variables ?? []).map((id) => (
            <span key={id} className="flex items-center gap-1 rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[11px]">
              {varName(id)}
              <button type="button" aria-label={t("blueprint.insp.delete")} onClick={() => patch({ sees: { ...sees, variables: (sees.variables ?? []).filter((x) => x !== id) } })}><X className="h-3 w-3" /></button>
            </span>
          ))}
          <select
            value=""
            data-ai-sees-var=""
            onChange={(e) => e.target.value && patch({ sees: { ...sees, variables: [...(sees.variables ?? []), e.target.value] } })}
            className={small}
          >
            <option value="">{t("blueprint.aiCustom.addVariable")}</option>
            {variables.filter((v) => !(sees.variables ?? []).includes(v.id) && !v.internal).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </div>
        <Row label={t("blueprint.aiCustom.history")}>
          <NumberInput aria-label={t("blueprint.aiCustom.history")} min={0} max={60} integer value={sees.history ?? 0} onCommit={(history) => patch({ sees: { ...sees, history: history ?? 0 } })} className={cn(small, "w-16 text-right")} />
        </Row>
        <Row label={t("blueprint.aiCustom.ownThread")}>
          <input type="checkbox" checked={!!sees.ownThread} onChange={(e) => patch({ sees: { ...sees, ownThread: e.target.checked || undefined } })} />
        </Row>
      </Group>

      {/* A piece holds while a variable says so: with no variable on the card
          there is nothing for it to hang on, and one added anyway was saved
          pointing at no variable at all, a condition that never holds. */}
      <Group title={t("blueprint.aiCustom.pieces")} right={<button type="button" data-ai-piece-add="" disabled={!firstVariable} title={firstVariable ? undefined : t("blueprint.aiCustom.piecesNeedVariable")} onClick={() => firstVariable && patch({ pieces: [...pieces, { conditions: [{ variableId: firstVariable.id, operator: firstVariable.type === "number" ? "gte" : "eq", value: startValue(firstVariable) }], text: "" }] })} className="text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground"><Plus className="h-3.5 w-3.5" /></button>}>
        {!firstVariable && pieces.length === 0 && <p className="text-[11px] text-muted-foreground">{t("blueprint.aiCustom.piecesNeedVariable")}</p>}
        {pieces.map((piece, i) => {
          const c = piece.conditions[0] ?? { variableId: "", operator: "gte" as const, value: "" };
          const setCond = (next: Partial<Condition>) => setPiece(i, { conditions: [{ ...c, ...next }, ...piece.conditions.slice(1)] });
          const condType = variables.find((v) => v.id === c.variableId)?.type;
          return (
            <div key={i} className="space-y-1 rounded-md border border-white/[0.06] p-2">
              <div className="flex items-center gap-1">
                <span className="text-[11px] text-muted-foreground">{t("blueprint.aiCustom.when")}</span>
                <select
                  value={c.variableId}
                  onChange={(e) => {
                    // The value is read as the new variable keeps it: a text
                    // "1" left behind as the number 1 would never match.
                    const nextType = variables.find((v) => v.id === e.target.value)?.type;
                    setCond({ variableId: e.target.value, value: parseEditedValue(valueText(c.value), nextType) as Condition["value"] });
                  }}
                  className={cn(small, "min-w-0 flex-1")}
                >
                  {!variables.some((v) => v.id === c.variableId) && <option value={c.variableId}>{c.variableId || "—"}</option>}
                  {variables.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
                <select value={c.operator} onChange={(e) => setCond({ operator: e.target.value as Condition["operator"] })} className={small}>
                  {OPS.map((op) => <option key={op} value={op}>{OP_SIGN[op]}</option>)}
                </select>
                <DraftInput
                  aria-label={t("blueprint.inspector.value")}
                  value={valueText(c.value)}
                  onCommit={(raw) => setCond({ value: parseEditedValue(raw, condType) as Condition["value"] })}
                  className={cn(small, "w-16")}
                />
                <button type="button" aria-label={t("blueprint.insp.delete")} onClick={() => patch({ pieces: pieces.filter((_, j) => j !== i) })} className="text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
              </div>
              <textarea rows={2} value={piece.text} placeholder={t("blueprint.aiCustom.piecePlaceholder")} onChange={(e) => setPiece(i, { text: e.target.value })} className={cn(input, "resize-y")} />
            </div>
          );
        })}
      </Group>

      <Group title={t("blueprint.aiCustom.output")} right={<button type="button" data-ai-field-add="" onClick={() => patch({ output: [...output, { name: output.length ? `field${output.length + 1}` : "text", type: "text", ...(output.length ? {} : { to: { kind: "say" as const } }) }] })} className="text-muted-foreground hover:text-foreground"><Plus className="h-3.5 w-3.5" /></button>}>
        {output.length === 0 && (station.trigger?.on === "ui" ? (
          // With no fields, a UI AI answers in words or with one JSON object
          // of the shape its job describes, handed back to the interface.
          <div className="space-y-1" data-ai-answer-kind="">
            <div className="flex gap-1">
              {(["text", "json"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  data-ai-answer={k}
                  onClick={() => patch({ answer: k === "json" ? "json" : undefined })}
                  className={cn(small, (station.answer ?? "text") === k ? "border-pink-400/60 text-foreground" : "text-muted-foreground hover:text-foreground")}
                >
                  {t(`blueprint.aiCustom.answerKind.${k}`)}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">{t(station.answer === "json" ? "blueprint.aiCustom.outputJson" : "blueprint.aiCustom.outputText")}</p>
          </div>
        ) : <p className="text-[11px] text-muted-foreground">{t("blueprint.aiCustom.outputText")}</p>)}
        {output.map((f, i) => {
          const to = f.to;
          const toValue = !to ? "" : to.kind === "say" ? "say" : to.kind === "event" ? "event" : `var:${to.variableId}`;
          return (
            <div key={i} className="space-y-1 rounded-md border border-white/[0.06] p-2" data-ai-field={f.name}>
              <div className="flex items-center gap-1">
                <input value={f.name} onChange={(e) => setField(i, { name: e.target.value.replace(/\s+/g, "_") })} className={cn(small, "w-24 font-mono")} />
                <select value={f.type} onChange={(e) => setField(i, { type: e.target.value as AiOutputField["type"] })} className={small}>
                  {(["text", "number", "choice", "list"] as const).map((k) => <option key={k} value={k}>{t(`blueprint.aiCustom.type.${k}`)}</option>)}
                </select>
                <span className="text-[11px] text-muted-foreground">→</span>
                <select
                  value={toValue}
                  onChange={(e) => {
                    const v = e.target.value;
                    setField(i, { to: v === "" ? undefined : v === "say" ? { kind: "say" } : v === "event" ? { kind: "event" } : { kind: "variable", variableId: v.slice(4), op: f.type === "list" ? "push" : f.type === "number" ? "set" : "set" } });
                  }}
                  className={cn(small, "min-w-0 flex-1")}
                >
                  <option value="">{t("blueprint.aiCustom.toNothing")}</option>
                  <option value="say">{t("blueprint.aiCustom.toSay")}</option>
                  <option value="event">{t("blueprint.aiCustom.toEvent")}</option>
                  {variables.filter((v) => !v.internal).map((v) => <option key={v.id} value={`var:${v.id}`}>{t("blueprint.aiCustom.toVariable", { name: v.name })}</option>)}
                </select>
                <button type="button" aria-label={t("blueprint.insp.delete")} onClick={() => patch({ output: output.filter((_, j) => j !== i) })} className="text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
              </div>
              {(f.type === "choice" || f.type === "list") && (
                <input value={(f.options ?? []).join("，")} placeholder={t("blueprint.aiCustom.optionsPlaceholder")} onChange={(e) => setField(i, { options: lines(e.target.value) })} className={input} />
              )}
              {f.type === "number" && (
                <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <NumberInput aria-label="min" allowEmpty value={f.min} placeholder="min" onCommit={(min) => setField(i, { min })} className={cn(small, "w-16")} />
                  –
                  <NumberInput aria-label="max" allowEmpty value={f.max} placeholder="max" onCommit={(max) => setField(i, { max })} className={cn(small, "w-16")} />
                </div>
              )}
              {to?.kind === "variable" && (
                <select value={to.op ?? "set"} onChange={(e) => setField(i, { to: { ...to, op: e.target.value as "set" | "add" | "push" } })} className={small}>
                  {(["set", "add", "push"] as const).map((op) => <option key={op} value={op}>{t(`blueprint.aiCustom.op.${op}`)}</option>)}
                </select>
              )}
              <input value={f.hint ?? ""} placeholder={t("blueprint.aiCustom.hintPlaceholder")} onChange={(e) => setField(i, { hint: e.target.value || undefined })} className={input} />
            </div>
          );
        })}
      </Group>

      <Group title={t("blueprint.aiCustom.say")}>
        <div className="flex items-center gap-1">
          <select
            value={sayKind}
            data-ai-say=""
            onChange={(e) => patch({ say: e.target.value === "channel" ? name : e.target.value === "story" ? undefined : e.target.value })}
            className={cn(small, "flex-1")}
          >
            <option value="story">{t("blueprint.aiCustom.sayStory")}</option>
            <option value="channel">{t("blueprint.aiCustom.sayChannel")}</option>
            <option value="none">{t("blueprint.aiCustom.sayNone")}</option>
          </select>
          {sayKind === "channel" && <input value={say} onChange={(e) => patch({ say: e.target.value || name })} className={cn(small, "w-28")} />}
        </div>
      </Group>

      <Group title={t("blueprint.aiCustom.onError")}>
        <Row label={t("blueprint.aiCustom.timeout")}>
          <NumberInput aria-label={t("blueprint.aiCustom.timeout")} min={5} max={120} integer value={onError.timeoutSec ?? 25} onCommit={(timeoutSec) => patch({ onError: { ...onError, timeoutSec } })} className={cn(small, "w-16 text-right")} />
        </Row>
        <Row label={t("blueprint.aiCustom.retries")}>
          <NumberInput aria-label={t("blueprint.aiCustom.retries")} min={0} max={3} integer value={onError.retries ?? 1} onCommit={(retries) => patch({ onError: { ...onError, retries } })} className={cn(small, "w-16 text-right")} />
        </Row>
        <textarea rows={2} value={(onError.fallback ?? []).join("\n")} placeholder={t("blueprint.aiCustom.fallbackPlaceholder")} onChange={(e) => patch({ onError: { ...onError, fallback: e.target.value.split("\n").map((l) => l.trim()).filter(Boolean) } })} className={cn(input, "resize-y")} />
        {output.some((f) => f.type === "choice") && (
          <Row label={t("blueprint.aiCustom.randomChoice")}>
            <input type="checkbox" data-ai-random-choice="" checked={!!onError.randomChoice} onChange={(e) => patch({ onError: { ...onError, randomChoice: e.target.checked || undefined } })} />
          </Row>
        )}
        <Row label={t("blueprint.aiCustom.cooldown")}>
          <NumberInput aria-label={t("blueprint.aiCustom.cooldown")} min={0} max={3600} integer value={station.cooldownSec ?? 0} onCommit={(cooldownSec) => patch({ cooldownSec: cooldownSec || undefined })} className={cn(small, "w-16 text-right")} />
        </Row>
      </Group>

      {/* How the card's own code calls it: the line a creator (or their AI)
          pastes into the interface. */}
      {snippet && (
        <div className="rounded-md border border-white/[0.06] bg-black/20 px-2 py-1.5 font-mono text-[10.5px] text-muted-foreground" data-ai-call-snippet="">
          {`await api.callAi(${JSON.stringify(name)}, input)`}
        </div>
      )}
    </More>
    </div>
  );
}
