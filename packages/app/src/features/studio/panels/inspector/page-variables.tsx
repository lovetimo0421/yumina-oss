import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import { pageBehaviorRefs, pageVariableRefs, remapDocVariable, type UiDoc, type UiPage, type Variable } from "@yumina/engine";
import { getVariableIdUsage } from "@/features/editor/lib/variable-id-references";
import { useEditorStore } from "@/stores/editor";
import { cn } from "@/lib/utils";
import { readLocalPref, writeLocalPref } from "../../lib/local-pref";
import { buttonBehaviors, openBehaviorOnCanvas } from "./button-behaviors";

const NEW = "__new__";

/** What kind of value a page's parts need from one variable: a meter needs a
 *  number, a list a list, a picture a piece of text. Anything else takes any. */
function neededType(page: UiPage | undefined, id: string): Variable["type"] | null {
  for (const el of page?.elements ?? []) {
    if (el.type === "meter" && el.value.kind === "variable" && el.value.variableId === id) return "number";
    if (el.type === "list" && el.source.kind === "variable" && el.source.variableId === id) return "json";
    if (el.type === "image" && el.src.kind === "variable" && el.src.variableId === id) return "string";
  }
  return null;
}

/**
 * One of the card's variables, or a new one made on the spot. A page or a
 * part reads a variable; this is where the creator says which one, by its
 * name, instead of editing `{{id}}` in its words.
 */
export function VariablePick({ value, variables, type, onPick, label }: {
  value: string;
  variables: Variable[];
  /** Only variables of this type fit; null takes any. */
  type: Variable["type"] | null;
  onPick: (variableId: string) => void;
  label?: string;
}) {
  const { t } = useTranslation("editor");
  const [naming, setNaming] = useState<string | null>(null);
  const fits = variables.filter((v) => !type || v.type === type);
  const current = variables.find((v) => v.id === value);
  const create = () => {
    const name = naming?.trim();
    if (!name) return;
    const made = useEditorStore.getState().makeAutoVariable(name, type ?? current?.type ?? "string", type === "number" ? 0 : type === "json" ? [] : type === "boolean" ? false : "");
    setNaming(null);
    onPick(made.id);
  };
  return (
    <div className="flex flex-col gap-1">
      {label && <span className="text-[11px] font-medium text-muted-foreground">{label}</span>}
      <select
        value={naming !== null ? NEW : value}
        onChange={(e) => {
          if (e.target.value === NEW) { setNaming(""); return; }
          setNaming(null);
          onPick(e.target.value);
        }}
        className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary"
      >
        {!current && <option value={value}>{t("studio.element.missingVariable", { id: value })}</option>}
        {fits.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        {current && !fits.some((v) => v.id === current.id) && <option value={current.id}>{current.name}</option>}
        <option value={NEW}>{t("studio.element.newVariable")}</option>
      </select>
      {naming !== null && (
        <div className="flex gap-1.5">
          <input
            autoFocus
            value={naming}
            onChange={(e) => setNaming(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") create(); if (e.key === "Escape") setNaming(null); }}
            placeholder={t("studio.element.newVariableName")}
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:border-primary"
          />
          <button type="button" onClick={create} disabled={!naming.trim()}
            className="rounded-md bg-primary px-2.5 text-[11px] font-semibold text-primary-foreground disabled:opacity-40">
            {t("studio.element.newVariableCreate")}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 「这一页用到的」: every variable the page reads or writes, each one
 * swappable for the card's own, and the behaviours its buttons set off, each
 * one a way to that behaviour on the canvas. A ready-made page comes with
 * variables of its own (当前位置, 体力 …); a creator who already has theirs
 * points the page at them here, and every part on the page follows at once.
 */
export function PageVariables({ doc, pageId, variables, onEdit }: {
  doc: UiDoc;
  pageId: string;
  variables: Variable[];
  onEdit: (next: UiDoc) => void;
}) {
  const { t } = useTranslation("editor");
  const ids = useMemo(() => pageVariableRefs(doc, pageId), [doc, pageId]);
  const reactions = useEditorStore((s) => s.worldDraft.reactions);
  const behaviors = useMemo(() => {
    const known = buttonBehaviors(reactions);
    return pageBehaviorRefs(doc, pageId).map((actionId) => ({ actionId, behavior: known.find((b) => b.actionId === actionId) }));
  }, [doc, pageId, reactions]);
  const page = (doc.pages ?? []).find((p) => p.id === pageId);
  /** A value the swap left with no use anywhere on the card: the page's own,
   *  most likely, which the AI would otherwise go on tracking. */
  const [unused, setUnused] = useState<Variable | null>(null);
  const swap = (from: string, to: string) => {
    const before = variables.find((v) => v.id === from);
    const after = useEditorStore.getState().worldDraft.variables.find((v) => v.id === to);
    // The whole interface follows (a status bar and its details page read the
    // same value), and a label that was only the old value's name takes the
    // new one: 「体力」 over a bar that now shows 好感度 would be wrong.
    let next = remapDocVariable(doc, from, to);
    if (before && after && before.name.trim()) {
      next = {
        ...next,
        pages: (next.pages ?? []).map((p) => ({
          ...p,
          elements: p.elements.map((el) => (el.type === "text" && el.text.template.trim() === before.name.trim()
            ? { ...el, text: { template: after.name } } : el)),
        })),
      };
    }
    onEdit(next);
    const world = useEditorStore.getState().worldDraft;
    const old = world.variables.find((v) => v.id === from);
    setUnused(old && getVariableIdUsage(world, old).references.length === 0 ? old : null);
  };
  const removeUnused = () => {
    if (!unused) return;
    const store = useEditorStore.getState();
    const index = store.worldDraft.variables.findIndex((v) => v.id === unused.id);
    if (index >= 0) store.removeVariableAt(index);
    setUnused(null);
  };
  if (ids.length === 0 && behaviors.length === 0) return null;
  const both = ids.length > 0 && behaviors.length > 0;
  return (
    <div className="border-b border-border/50 px-3 py-2.5" data-page-variables="">
      <span className="mb-2 block text-[11px] font-medium text-muted-foreground">{t("studio.element.pageData")}</span>
      {ids.length > 0 && (
        <div className="flex flex-col gap-2">
          {both && <span className="text-[10.5px] text-muted-foreground/70">{t("studio.element.pageValues")}</span>}
          {ids.map((id) => (
            <VariablePick
              key={id}
              value={id}
              variables={variables}
              type={neededType(page, id)}
              onPick={(to) => swap(id, to)}
            />
          ))}
        </div>
      )}
      {behaviors.length > 0 && (
        <div className={cn("flex flex-col gap-1", ids.length > 0 && "mt-3")} data-page-behaviors="">
          {both && <span className="text-[10.5px] text-muted-foreground/70">{t("studio.element.pageBehaviors")}</span>}
          {behaviors.map(({ actionId, behavior }) => (
            <div key={actionId} className="flex items-center gap-2 rounded-md border border-border/60 px-2 py-1.5 text-xs">
              <span className={cn("min-w-0 flex-1 truncate", !behavior && "text-muted-foreground")}>
                {behavior ? behavior.name : t("studio.element.behaviorMissing", { id: actionId })}
              </span>
              {behavior && (
                <button
                  type="button"
                  onClick={() => openBehaviorOnCanvas(behavior.id)}
                  className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  {t("studio.element.behaviorOpen")}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {unused && (
        <div className="mt-2 flex items-center gap-2 rounded-md bg-amber-400/10 px-2 py-1.5 text-[11px] text-amber-100" data-unused-variable="">
          <span className="min-w-0 flex-1">{t("studio.element.unusedVariable", { name: unused.name })}</span>
          <button type="button" onClick={removeUnused} className="shrink-0 rounded px-1.5 py-0.5 font-semibold text-amber-200 hover:bg-amber-400/15">
            {t("studio.element.unusedRemove")}
          </button>
          <button type="button" onClick={() => setUnused(null)} className="shrink-0 rounded px-1.5 py-0.5 text-muted-foreground hover:text-foreground">
            {t("studio.element.unusedKeep")}
          </button>
        </div>
      )}
    </div>
  );
}

const MORE_KEY = "yumina-ui-panel-more";

/** The settings most changes never need, folded under one line and opened
 *  the way the creator last left it. Folded, not removed. */
export function MoreSection({ label, children, storageKey = MORE_KEY }: { label: string; children: React.ReactNode; storageKey?: string }) {
  const [open, setOpen] = useState(() => readLocalPref(storageKey) === "1");
  return (
    <div data-more-section="" className="border-b border-border/50">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => { setOpen(!open); writeLocalPref(storageKey, open ? "0" : "1"); }}
        className="flex w-full items-center gap-1.5 px-3 py-2.5 text-left text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
        {label}
      </button>
      {open && <div className="border-t border-border/50">{children}</div>}
    </div>
  );
}
