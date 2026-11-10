import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import type { ModuleStation } from "@yumina/engine";
import { useEditorStore } from "@/stores/editor";
import { DebouncedTextarea } from "@/features/editor/components/debounced-field";
import { cn } from "@/lib/utils";
import { Field, inputClass } from "./controls";
import { requestAddAi, type AiType } from "./add-ai";

const TYPES: AiType[] = ["turn", "ui", "event", "custom"];

/**
 * 类型: what calls this AI — the player's turn, the player's screen, an
 * event in the card, or code written to a shape the creator declares — with
 * the chosen one said in a line, so the four read as choices rather than
 * jargon.
 *
 * The card's own AI is always the one replying to the player, and on a card
 * with nothing else it is the only AI there is: its switch shows every kind
 * too, and picking another adds an AI of that kind beside it (owner, 10/17:
 * the kinds were only to be found after adding a second AI by hand).
 */
export function AiTypePicker({ value, onPick, card }: { value: AiType; onPick?: (type: AiType) => void; card?: boolean }) {
  const { t } = useTranslation("editor");
  return (
    <Field label={t("blueprint.aiForm.type")}>
      <div className="grid grid-cols-4 gap-1" role="radiogroup" data-ai-type-pick="">
        {TYPES.map((k) => {
          const adds = card && k !== value;
          return (
            <button
              key={k}
              type="button"
              role={adds ? undefined : "radio"}
              aria-checked={adds ? undefined : value === k}
              data-ai-type-option={k}
              data-ai-type-adds={adds ? "" : undefined}
              title={adds ? t("blueprint.aiForm.addTyped", { type: t(`blueprint.aiType.${k}`) }) : undefined}
              onClick={() => {
                if (k === value) return;
                if (card) requestAddAi(k);
                else onPick?.(k);
              }}
              className={cn(
                "flex items-center justify-center gap-1 rounded-md border px-1.5 py-1.5 text-[11.5px] font-semibold transition-colors",
                value === k ? "border-pink-400/60 bg-pink-400/[0.12] text-foreground" : "border-white/10 text-muted-foreground hover:text-foreground",
                adds && "border-dashed",
              )}
            >
              {adds && <Plus className="h-3 w-3 shrink-0" />}
              {t(`blueprint.aiType.${k}`)}
            </button>
          );
        })}
      </div>
      <p className="pt-1.5 text-[11px] leading-relaxed text-foreground/55" data-ai-type-hint={value}>
        {t(`blueprint.aiTypeHint.${value}`)}
        {card && <> {t("blueprint.aiForm.cardTypeHint")}</>}
      </p>
    </Field>
  );
}

/**
 * 调用方式: a called AI as the interface it is — the name the card's code
 * calls it by, what it is handed, and (below, in 回答格式) what it answers.
 * On a custom AI also 它要做什么, the creator's half of the deal: what the
 * code that implements it should do. That is the AI's note, which the
 * creation assistant and an outside AI read before writing anything.
 */
export function AiContract({ worldbookId, withNote }: { worldbookId: string; withNote?: boolean }) {
  const { t } = useTranslation("editor");
  const book = useEditorStore((s) => (s.worldDraft.worldbooks ?? []).find((w) => w.id === worldbookId));
  const updateWorldbook = useEditorStore((s) => s.updateWorldbook);
  const station = book?.station;
  if (!book || !station) return null;
  const patch = (next: Partial<ModuleStation>) => updateWorldbook(worldbookId, { station: { ...station, ...next } });
  const name = station.name?.trim() || book.name;
  const fields = station.output ?? [];
  const returns = fields.length
    ? `{ ${fields.map((f) => `${f.name}: ${f.type === "choice" && f.options?.length ? f.options.map((o) => JSON.stringify(o)).join(" | ") : t(`blueprint.aiCustom.type.${f.type}`)}`).join(", ")} }`
    : station.answer === "json"
    ? t("blueprint.aiContract.returnsJson")
    : t("blueprint.aiContract.returnsText");
  return (
    <div className="space-y-2.5" data-ai-contract="">
      <Field label={t("blueprint.aiContract.title")} hint={t("blueprint.aiContract.titleHint")}>
        <div className="space-y-0.5 rounded-md border border-white/[0.08] bg-black/25 px-2.5 py-2 font-mono text-[11px] leading-relaxed" data-ai-call-snippet="">
          <div className="text-foreground/85">
            <span className="text-muted-foreground">await </span>api.callAi(<span className="text-amber-200">{JSON.stringify(name)}</span>, <span className="text-sky-200">input</span>)
          </div>
          <div className="break-words text-foreground/60">→ {returns}</div>
        </div>
      </Field>
      <Field label={t("blueprint.aiContract.takes")} hint={t("blueprint.aiContract.takesHint")}>
        <DebouncedTextarea
          value={station.takes ?? ""}
          onCommit={(takes) => patch({ takes: takes.trim() ? takes : undefined })}
          syncKey={`${worldbookId}:takes`}
          placeholder={t("blueprint.aiContract.takesPlaceholder")}
          rows={2}
          data-ai-takes=""
          className={cn(inputClass, "min-h-[48px] resize-y")}
        />
      </Field>
      {withNote && (
        <Field label={t("blueprint.aiContract.does")} hint={t("blueprint.aiContract.doesHint")}>
          <DebouncedTextarea
            value={book.note ?? ""}
            onCommit={(note) => updateWorldbook(worldbookId, { note: note.trim() ? note : undefined })}
            syncKey={`${worldbookId}:note`}
            placeholder={t("blueprint.aiContract.doesPlaceholder")}
            rows={3}
            data-ai-does=""
            className={cn(inputClass, "min-h-[64px] resize-y")}
          />
        </Field>
      )}
    </div>
  );
}
