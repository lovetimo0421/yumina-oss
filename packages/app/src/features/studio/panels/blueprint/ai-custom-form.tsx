import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import type { AiOutputField, AiPromptPiece, Condition, ModuleStation } from "@yumina/engine";
import { useEditorStore } from "@/stores/editor";
import { cn } from "@/lib/utils";
import { Group, More, Row } from "./controls";

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

function lines(text: string): string[] {
  return text.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean);
}

export function AiCustomForm({ worldbookId }: { worldbookId: string }) {
  const { t } = useTranslation("editor");
  const book = useEditorStore((s) => (s.worldDraft.worldbooks ?? []).find((w) => w.id === worldbookId));
  const variables = useEditorStore((s) => s.worldDraft.variables);
  const updateWorldbook = useEditorStore((s) => s.updateWorldbook);
  const station = book?.station;
  if (!book || !station) return null;
  const patch = (next: Partial<ModuleStation>) => updateWorldbook(worldbookId, { station: { ...station, ...next } });
  const varName = (id: string) => variables.find((v) => v.id === id)?.name ?? id;

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
    <More label={t("blueprint.aiCustom.title")} defaultOpen={used}>
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
          <input type="number" min={0} max={60} value={sees.history ?? 0} onChange={(e) => patch({ sees: { ...sees, history: Math.max(0, Math.min(60, Number(e.target.value) || 0)) } })} className={cn(small, "w-16 text-right")} />
        </Row>
        <Row label={t("blueprint.aiCustom.ownThread")}>
          <input type="checkbox" checked={!!sees.ownThread} onChange={(e) => patch({ sees: { ...sees, ownThread: e.target.checked || undefined } })} />
        </Row>
      </Group>

      <Group title={t("blueprint.aiCustom.pieces")} right={<button type="button" data-ai-piece-add="" onClick={() => patch({ pieces: [...pieces, { conditions: [{ variableId: variables[0]?.id ?? "", operator: "gte", value: 0 }], text: "" }] })} className="text-muted-foreground hover:text-foreground"><Plus className="h-3.5 w-3.5" /></button>}>
        {pieces.map((piece, i) => {
          const c = piece.conditions[0] ?? { variableId: "", operator: "gte" as const, value: "" };
          const setCond = (next: Partial<Condition>) => setPiece(i, { conditions: [{ ...c, ...next }, ...piece.conditions.slice(1)] });
          return (
            <div key={i} className="space-y-1 rounded-md border border-white/[0.06] p-2">
              <div className="flex items-center gap-1">
                <span className="text-[11px] text-muted-foreground">{t("blueprint.aiCustom.when")}</span>
                <select value={c.variableId} onChange={(e) => setCond({ variableId: e.target.value })} className={cn(small, "min-w-0 flex-1")}>
                  {variables.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
                <select value={c.operator} onChange={(e) => setCond({ operator: e.target.value as Condition["operator"] })} className={small}>
                  {OPS.map((op) => <option key={op} value={op}>{OP_SIGN[op]}</option>)}
                </select>
                <input value={String(c.value ?? "")} onChange={(e) => setCond({ value: e.target.value !== "" && !Number.isNaN(Number(e.target.value)) ? Number(e.target.value) : e.target.value })} className={cn(small, "w-16")} />
                <button type="button" aria-label={t("blueprint.insp.delete")} onClick={() => patch({ pieces: pieces.filter((_, j) => j !== i) })} className="text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
              </div>
              <textarea rows={2} value={piece.text} placeholder={t("blueprint.aiCustom.piecePlaceholder")} onChange={(e) => setPiece(i, { text: e.target.value })} className={cn(input, "resize-y")} />
            </div>
          );
        })}
      </Group>

      <Group title={t("blueprint.aiCustom.output")} right={<button type="button" data-ai-field-add="" onClick={() => patch({ output: [...output, { name: output.length ? `field${output.length + 1}` : "text", type: "text", ...(output.length ? {} : { to: { kind: "say" as const } }) }] })} className="text-muted-foreground hover:text-foreground"><Plus className="h-3.5 w-3.5" /></button>}>
        {output.length === 0 && <p className="text-[11px] text-muted-foreground">{t("blueprint.aiCustom.outputText")}</p>}
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
                  <input type="number" value={f.min ?? ""} placeholder="min" onChange={(e) => setField(i, { min: e.target.value === "" ? undefined : Number(e.target.value) })} className={cn(small, "w-16")} />
                  –
                  <input type="number" value={f.max ?? ""} placeholder="max" onChange={(e) => setField(i, { max: e.target.value === "" ? undefined : Number(e.target.value) })} className={cn(small, "w-16")} />
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
          <input type="number" min={5} max={120} value={onError.timeoutSec ?? 25} onChange={(e) => patch({ onError: { ...onError, timeoutSec: Math.max(5, Math.min(120, Number(e.target.value) || 25)) } })} className={cn(small, "w-16 text-right")} />
        </Row>
        <Row label={t("blueprint.aiCustom.retries")}>
          <input type="number" min={0} max={3} value={onError.retries ?? 1} onChange={(e) => patch({ onError: { ...onError, retries: Math.max(0, Math.min(3, Number(e.target.value) || 0)) } })} className={cn(small, "w-16 text-right")} />
        </Row>
        <textarea rows={2} value={(onError.fallback ?? []).join("\n")} placeholder={t("blueprint.aiCustom.fallbackPlaceholder")} onChange={(e) => patch({ onError: { ...onError, fallback: e.target.value.split("\n").map((l) => l.trim()).filter(Boolean) } })} className={cn(input, "resize-y")} />
        {output.some((f) => f.type === "choice") && (
          <Row label={t("blueprint.aiCustom.randomChoice")}>
            <input type="checkbox" data-ai-random-choice="" checked={!!onError.randomChoice} onChange={(e) => patch({ onError: { ...onError, randomChoice: e.target.checked || undefined } })} />
          </Row>
        )}
        <Row label={t("blueprint.aiCustom.cooldown")}>
          <input type="number" min={0} max={3600} value={station.cooldownSec ?? 0} onChange={(e) => patch({ cooldownSec: Math.max(0, Math.min(3600, Number(e.target.value) || 0)) || undefined })} className={cn(small, "w-16 text-right")} />
        </Row>
      </Group>

      {/* How the card's own code calls it: the line a creator (or their AI)
          pastes into the interface. */}
      <div className="rounded-md border border-white/[0.06] bg-black/20 px-2 py-1.5 font-mono text-[10.5px] text-muted-foreground" data-ai-call-snippet="">
        {`await api.callAi(${JSON.stringify(name)}, input)`}
      </div>
    </More>
    </div>
  );
}
