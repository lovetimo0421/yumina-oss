import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { Worldbook } from "@yumina/engine";
import { useEditorStore } from "@/stores/editor";
import { cn } from "@/lib/utils";
import { ConditionEditor } from "./condition-editor";

/**
 * When a module turns on — the one editor for it.
 *
 * There used to be two: the lorebook page offered three modes and the canvas
 * inspector five, so a module opened by a keyword could be made on the canvas
 * and not even be read on the lorebook page. One component, both screens.
 */

const inputClass =
  "w-full rounded-lg border border-border bg-background px-2.5 py-2 text-xs text-foreground focus:border-amber-500/50 focus:outline-none focus:ring-1 focus:ring-amber-500/40";

/** Switch a module to a new activation mode without losing what the old one
 *  held. Re-picking "conditions" after a detour through "always" should find
 *  the conditions still there — they are wires the creator drew. */
export function activationForMode(mode: string, book: Worldbook): Worldbook["activation"] {
  if (mode === "conditions") {
    return book.activation.mode === "conditions"
      ? book.activation
      : { mode: "conditions", conditions: [], conditionLogic: "all" };
  }
  if (mode === "greeting") {
    return book.activation.mode === "greeting" ? book.activation : { mode: "greeting", greetingIds: [] };
  }
  if (mode === "keywords") {
    // Exclusive by default: the reason to switch a module on with a word is
    // almost always to leave the one you were in.
    return book.activation.mode === "keywords"
      ? book.activation
      : { mode: "keywords", keywords: [], exclusive: true };
  }
  return { mode: mode === "manual" ? "manual" : "always" };
}

/** all/any toggle shown once a target has several conditions. */
export function LogicToggle({ value, onChange }: { value: "all" | "any"; onChange: (v: "all" | "any") => void }) {
  const { t } = useTranslation("editor");
  return (
    <div className="space-y-1.5">
      <label className="text-[11px] font-medium text-muted-foreground">{t("blueprint.insp.logicLabel")}</label>
      <div className="flex gap-1">
        {(["all", "any"] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => onChange(v)}
            className={cn(
              "flex-1 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors",
              value === v
                ? "border-amber-500/60 bg-amber-500/15 text-amber-400"
                : "border-border text-muted-foreground hover:bg-accent",
            )}
          >
            {t(`blueprint.logic.${v}` as never)}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The words that open this module. Chips rather than a comma-separated
 *  field: a creator has to be able to see that "地下室" and "地下 室" are two
 *  different keys, and delete one without re-reading the other. */
export function KeywordEditor({
  activation,
  onChange,
}: {
  activation: Extract<Worldbook["activation"], { mode: "keywords" }>;
  onChange: (next: Worldbook["activation"]) => void;
}) {
  const { t } = useTranslation("editor");
  return (
    <div className="space-y-1.5 rounded-lg border border-border px-2 py-1.5">
      <WordList
        words={activation.keywords ?? []}
        onChange={(keywords) => onChange({ ...activation, keywords })}
        placeholder={t("blueprint.insp.keywordPlaceholder")}
      />
      {/* The way back out. Without it the door only closed when another
          exclusive situation opened, and a back room's settings kept going
          to the AI after the player had walked out of it. */}
      <p className="pt-1 text-[10.5px] font-semibold text-muted-foreground">{t("blueprint.insp.leaveWordsLabel")}</p>
      <WordList
        words={activation.leaveKeywords ?? []}
        onChange={(leaveKeywords) => onChange({ ...activation, leaveKeywords })}
        placeholder={t("blueprint.insp.leaveWordsPlaceholder")}
        tone="leave"
      />
      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          checked={activation.exclusive !== false}
          onChange={(e) => onChange({ ...activation, exclusive: e.target.checked })}
          className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-amber-500"
        />
        <span className="text-[10px] leading-relaxed text-muted-foreground">
          {t("blueprint.insp.keywordExclusive")}
        </span>
      </label>
    </div>
  );
}

/** Words as chips and a box to type one more; a chip clicked goes away. */
function WordList({ words, onChange, placeholder, tone = "enter" }: { words: string[]; onChange: (next: string[]) => void; placeholder: string; tone?: "enter" | "leave" }) {
  const [draft, setDraft] = useState("");
  const commit = () => {
    const word = draft.trim();
    setDraft("");
    if (!word || words.includes(word)) return;
    onChange([...words, word]);
  };
  return (
    <>
      {words.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {words.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => onChange(words.filter((x) => x !== w))}
              className={cn("group flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors hover:border-destructive/50 hover:text-destructive",
                tone === "leave" ? "border-sky-400/30 bg-sky-500/10 text-sky-200/90" : "border-amber-400/30 bg-amber-500/10 text-amber-200/90")}
            >
              {w}
              <X className="h-2.5 w-2.5 opacity-50 group-hover:opacity-100" />
            </button>
          ))}
        </div>
      )}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit();
          }
        }}
        placeholder={placeholder}
        className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-primary/50"
      />
    </>
  );
}

/** Which openings turn this module on. A list of the card's own openings, not
 *  a wire to draw: "this dungeon only exists in the beta run" is a choice made
 *  from what the card actually offers. */
export function GreetingPicker({ selected, onToggle }: { selected: string[]; onToggle: (id: string) => void }) {
  const { t } = useTranslation("editor");
  // Filter outside the selector, never inside it. A selector that builds a new
  // array hands useSyncExternalStore a different snapshot on every check, and
  // the component re-renders until React gives up — "Maximum update depth
  // exceeded", the whole editor gone, on any module bound to an opening.
  const entries = useEditorStore((s) => s.worldDraft.entries);
  const greetings = useMemo(() => entries.filter((e) => e.role === "greeting"), [entries]);
  if (greetings.length === 0) {
    return <p className="text-[10px] leading-relaxed text-amber-500/80">{t("blueprint.insp.noOpenings")}</p>;
  }
  return (
    <div className="space-y-1 rounded-lg border border-border px-2 py-1.5">
      {greetings.map((g, i) => (
        <label key={g.id} className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={selected.includes(g.id)}
            onChange={() => onToggle(g.id)}
            className="h-3.5 w-3.5 shrink-0 accent-amber-500"
          />
          <span className="min-w-0 flex-1 truncate text-[11px] text-foreground/85">
            {g.name || t("blueprint.insp.openingN", { n: i + 1 })}
          </span>
        </label>
      ))}
    </div>
  );
}

export function ModuleActivationEditor({
  book,
  onChange,
  /** Whether variable conditions are edited here as rows. On the canvas they
   *  are wires, so the inspector shows only the all/any toggle. */
  conditionsInline = true,
}: {
  book: Worldbook;
  onChange: (activation: Worldbook["activation"]) => void;
  conditionsInline?: boolean;
}) {
  const { t } = useTranslation("editor");
  const variables = useEditorStore((s) => s.worldDraft.variables);
  const mode = book.activation.mode;
  // An AI behind the scenes has an activation like any frame, and it is its
  // master switch: the worker and quiet runs both skip a frame that is not
  // in, so a chapter-two recorder does not write during chapter one.
  return (
    <div className="space-y-2">
      <select
        value={mode}
        onChange={(e) => onChange(activationForMode(e.target.value, book))}
        className={inputClass}
      >
        {(["always", "keywords", "conditions", "greeting", "manual"] as const).map((m) => (
          <option key={m} value={m}>
            {t(`blueprint.activation.${m}` as never)}
          </option>
        ))}
      </select>
      {/* The conditions hint tells the creator to draw a wire, which is the
          canvas's way; with the rows editable right here it would be wrong. */}
      {/* Only where the choice needs a how-to: the others say it in their name. */}
      {(mode === "manual" || (mode === "conditions" && !conditionsInline)) && (
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          {t(`blueprint.insp.whenOpenHint.${mode}` as never)}
        </p>
      )}
      {book.activation.mode === "keywords" && (
        <KeywordEditor activation={book.activation} onChange={onChange} />
      )}
      {book.activation.mode === "greeting" && (
        <GreetingPicker
          selected={book.activation.greetingIds}
          onToggle={(id) => {
            const prev = book.activation.mode === "greeting" ? book.activation.greetingIds : [];
            const next = prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id];
            onChange({ mode: "greeting", greetingIds: next });
          }}
        />
      )}
      {book.activation.mode === "conditions" && (
        <div className="space-y-2">
          {conditionsInline && (
            <div className="rounded-lg border border-sky-500/20 bg-sky-500/5 p-2.5">
              <ConditionEditor
                conditions={book.activation.conditions}
                variables={variables.filter((v) => !v.internal)}
                onChange={(conditions) =>
                  onChange({
                    mode: "conditions",
                    conditions,
                    conditionLogic: book.activation.mode === "conditions" ? book.activation.conditionLogic : "all",
                  })
                }
              />
              {variables.filter((v) => !v.internal).length === 0 && (
                <p className="mt-1 text-[10px] text-amber-500/80">{t("modules.noVars")}</p>
              )}
            </div>
          )}
          {book.activation.conditions.length > 1 && (
            <LogicToggle
              value={book.activation.conditionLogic === "any" ? "any" : "all"}
              onChange={(conditionLogic) =>
                onChange({ ...book.activation, conditionLogic } as Worldbook["activation"])
              }
            />
          )}
        </div>
      )}
    </div>
  );
}
