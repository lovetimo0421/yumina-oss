import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Plus, X } from "lucide-react";
import type { UiChoiceOption, UiElement, Variable } from "@yumina/engine";
import { ActionListEditor, type ActionContext } from "../element-behavior";
import { ImageField, NamedText, Section, Segmented, Toggle, VariableSelect, smallCls, useMakeVariable } from "./part-kit";

type Choice = Extract<UiElement, { type: "choice" }>;

/** Move one row of a list by one place; out of range is a no-op. */
export function moveItem<T>(list: T[], i: number, by: -1 | 1): T[] {
  const j = i + by;
  if (j < 0 || j >= list.length) return list;
  const next = list.slice();
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

/** "温柔, 校园，日常" → ["温柔", "校园", "日常"]. Both commas, since the creator
 *  types in whichever their keyboard gives them. */
export const parseTags = (raw: string) =>
  raw.split(/[,，、]/).map((t) => t.trim()).filter(Boolean);

const newOptionId = () => `opt-${crypto.randomUUID().slice(0, 8)}`;

/**
 * 卡片选择: the cards, how they are laid out, how many can be picked, where
 * the pick goes, and what each card does. One part for an opening picker, a
 * class picker, a route, a gift — the table is the same table.
 */
export function ChoiceEditor({
  el, onPatch, variables, ctx, worldId,
}: {
  el: Choice;
  onPatch: (fn: (el: Choice) => Choice) => void;
  variables: Variable[];
  ctx: ActionContext;
  worldId?: string | null;
}) {
  const { t } = useTranslation("editor");
  const [open, setOpen] = useState<string | null>(null);
  const make = useMakeVariable();
  const options = el.options ?? [];
  const setOptions = (fn: (list: UiChoiceOption[]) => UiChoiceOption[]) => onPatch((c) => ({ ...c, options: fn(c.options ?? []) }));
  const patchOption = (id: string, patch: Partial<UiChoiceOption>) =>
    setOptions((list) => list.map((o) => {
      if (o.id !== id) return o;
      const next = { ...o, ...patch };
      // Empty optional fields leave the document rather than sitting in it
      // as "" — an empty subtitle is no subtitle.
      for (const key of ["subtitle", "detail", "value"] as const) if (next[key] === "") delete next[key];
      if (next.tags && next.tags.length === 0) delete next.tags;
      if (next.actions && next.actions.length === 0) delete next.actions;
      if (next.image === undefined) delete next.image;
      return next;
    }));

  return (
    <div data-testid="choice-editor">
      <Section label={t("studio.parts.choice.layout")}>
        <Segmented
          label={t("studio.parts.choice.layout")}
          value={el.layout}
          onChange={(layout) => onPatch((c) => ({ ...c, layout }))}
          options={[
            { value: "grid", label: t("studio.parts.choice.layoutGrid") },
            { value: "carousel", label: t("studio.parts.choice.layoutCarousel") },
            { value: "list", label: t("studio.parts.choice.layoutList") },
          ]}
        />
        {el.layout === "grid" && (
          <div className="mt-2 flex items-center gap-2">
            <span className="shrink-0 text-[11px] text-muted-foreground">{t("studio.parts.choice.columns")}</span>
            {/* Full width, so 自动 reads as a word and not "自…". */}
            <div className="min-w-0 flex-1">
            <Segmented
              label={t("studio.parts.choice.columns")}
              // Unset is its own choice, not a silent 2: the phone draws two
              // and the wide canvas fits as many as its box holds. A number
              // holds on both canvases — the field the card renders from.
              value={el.columns ?? 0}
              onChange={(columns) => onPatch((c) => {
                const next = { ...c };
                if (columns > 0) next.columns = columns;
                else delete next.columns;
                return next;
              })}
              options={[
                { value: 0, label: t("studio.parts.choice.columnsAuto") },
                ...[1, 2, 3, 4].map((n) => ({ value: n, label: String(n) })),
              ]}
            />
            </div>
          </div>
        )}
      </Section>

      <Section label={t("studio.parts.choice.pickCount")}>
        <div className="flex items-center gap-2">
          <Segmented
            label={t("studio.parts.choice.pickCount")}
            value={el.multi ? "many" : "one"}
            onChange={(mode) => {
              // One pick is a line of text, several are a list: a variable of
              // the other kind would be written a shape it does not hold, so
              // switching brings a variable of the right kind with it.
              const wants = mode === "many" ? "json" : "string";
              const current = variables.find((v) => v.id === el.variableId);
              const variableId = current && current.type !== wants
                ? make(t("studio.parts.choice.newVariableName"), wants, wants === "json" ? [] : "").id
                : el.variableId;
              onPatch((c) => {
                if (mode === "one") {
                  const { multi: _m, maxPick: _p, ...rest } = c;
                  return { ...(rest as Choice), ...(variableId ? { variableId } : {}) };
                }
                return { ...c, multi: true, ...(variableId ? { variableId } : {}) };
              });
            }}
            options={[
              { value: "one", label: t("studio.parts.choice.pickOne") },
              { value: "many", label: t("studio.parts.choice.pickMany") },
            ]}
          />
          {el.multi && (
            <label className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
              {t("studio.parts.choice.maxPick")}
              <input
                type="number"
                min={1}
                max={60}
                value={el.maxPick ?? ""}
                placeholder={t("studio.parts.choice.unlimited")}
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  const n = Number(raw);
                  onPatch((c) => {
                    if (!raw || !Number.isFinite(n) || n < 1) {
                      const { maxPick: _p, ...rest } = c;
                      return rest as Choice;
                    }
                    return { ...c, maxPick: Math.min(60, Math.round(n)) };
                  });
                }}
                className={`${smallCls} w-14`}
              />
            </label>
          )}
        </div>
        {!el.multi && !el.confirm && <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground/70">{t("studio.parts.choice.tapRunsHint")}</p>}
      </Section>

      <Section label={t("studio.parts.choice.variable")} hint={t(el.multi ? "studio.parts.choice.variableHintMany" : "studio.parts.choice.variableHint")}>
        <VariableSelect
          label={t("studio.parts.choice.variable")}
          value={el.variableId ?? ""}
          variables={variables}
          types={el.multi ? ["json"] : ["string"]}
          newName={t("studio.parts.choice.newVariableName")}
          newType={el.multi ? "json" : "string"}
          newDefault={el.multi ? [] : ""}
          onChange={(variableId) => onPatch((c) => ({ ...c, variableId }))}
        />
      </Section>

      <Section label={t("studio.parts.choice.more")}>
        <div className="flex flex-col gap-2">
          <Toggle
            label={t("studio.parts.choice.tagFilter")}
            checked={!!el.tagFilter}
            onChange={(on) => onPatch((c) => {
              if (on) return { ...c, tagFilter: true };
              const { tagFilter: _f, ...rest } = c;
              return rest as Choice;
            })}
          />
          <Toggle
            label={t("studio.parts.choice.confirm")}
            checked={!!el.confirm}
            onChange={(on) => onPatch((c) => {
              if (on) return { ...c, confirm: { label: { template: t("studio.parts.choice.confirmDefault") } } };
              const { confirm: _c, ...rest } = c;
              return rest as Choice;
            })}
          />
          {el.confirm && (
            <NamedText
              label={t("studio.parts.choice.confirmLabel")}
              value={el.confirm.label.template}
              variables={variables}
              onChange={(template) => onPatch((c) => (c.confirm ? { ...c, confirm: { ...c.confirm, label: { template } } } : c))}
            />
          )}
        </div>
        <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground/70">
          {t(el.confirm ? "studio.parts.choice.confirmHint" : "studio.parts.choice.tagFilterHint")}
        </p>
      </Section>

      {el.confirm && (
        <ActionListEditor
          label={t("studio.parts.choice.confirmActions")}
          hint={t("studio.parts.choice.afterHint", { token: "{{choice}}" })}
          actions={el.confirm.actions ?? []}
          ctx={ctx}
          onChange={(actions) => onPatch((c) => (c.confirm ? { ...c, confirm: { ...c.confirm, actions } } : c))}
        />
      )}

      <Section label={t("studio.parts.choice.options")} testId="choice-options">
        <ol className="flex flex-col gap-1.5">
          {options.map((o, i) => {
            const expanded = open === o.id;
            return (
              <li key={o.id} className="rounded-md border border-border/60 bg-background/40" data-testid="choice-option">
                <div className="flex items-center gap-1 p-1.5">
                  <button
                    type="button"
                    onClick={() => setOpen(expanded ? null : o.id)}
                    aria-expanded={expanded}
                    aria-label={t(expanded ? "studio.parts.collapse" : "studio.parts.expand")}
                    className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                  >
                    {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  </button>
                  <ImageField
                    compact
                    worldId={worldId}
                    value={o.image}
                    onChange={(ref) => patchOption(o.id, { image: ref ? { kind: "asset", ref } : undefined })}
                  />
                  <input
                    value={o.title}
                    aria-label={t("studio.parts.choice.title")}
                    placeholder={t("studio.parts.choice.title")}
                    onChange={(e) => patchOption(o.id, { title: e.target.value })}
                    className={`${smallCls} min-w-0 flex-1`}
                  />
                  <button type="button" onClick={() => setOptions((list) => moveItem(list, i, -1))} disabled={i === 0} title={t("studio.parts.moveUp")} aria-label={t("studio.parts.moveUp")} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30">
                    <ArrowUp className="h-3 w-3" />
                  </button>
                  <button type="button" onClick={() => setOptions((list) => moveItem(list, i, 1))} disabled={i === options.length - 1} title={t("studio.parts.moveDown")} aria-label={t("studio.parts.moveDown")} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30">
                    <ArrowDown className="h-3 w-3" />
                  </button>
                  <button type="button" onClick={() => setOptions((list) => list.filter((x) => x.id !== o.id))} title={t("studio.parts.remove")} aria-label={t("studio.parts.remove")} className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
                    <X className="h-3 w-3" />
                  </button>
                </div>
                {!expanded && (o.subtitle || (o.actions?.length ?? 0) > 0) && (
                  <p className="truncate px-2 pb-1.5 text-[10px] text-muted-foreground/80">
                    {[o.subtitle, (o.actions?.length ?? 0) > 0 ? t("studio.parts.choice.stepsCount", { count: o.actions!.length }) : null].filter(Boolean).join(" · ")}
                  </p>
                )}
                {expanded && (
                  <div className="flex flex-col gap-2 border-t border-border/50 p-2">
                    <label className="flex flex-col gap-1">
                      <span className="text-[10px] text-muted-foreground">{t("studio.parts.choice.subtitle")}</span>
                      <input value={o.subtitle ?? ""} onChange={(e) => patchOption(o.id, { subtitle: e.target.value })} className={smallCls} />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[10px] text-muted-foreground">{t("studio.parts.choice.detail")}</span>
                      <textarea rows={3} value={o.detail ?? ""} placeholder={t("studio.parts.choice.detailPlaceholder")} onChange={(e) => patchOption(o.id, { detail: e.target.value })} className={`${smallCls} resize-y`} />
                    </label>
                    <TagsInput value={o.tags ?? []} onChange={(tags) => patchOption(o.id, { tags })} />
                    <label className="flex flex-col gap-1">
                      <span className="text-[10px] text-muted-foreground">{t("studio.parts.choice.value")}</span>
                      <input value={o.value ?? ""} placeholder={t("studio.parts.choice.valuePlaceholder")} onChange={(e) => patchOption(o.id, { value: e.target.value })} className={smallCls} />
                    </label>
                    <ActionListEditor
                      bare
                      label={t("studio.parts.choice.after")}
                      hint={t("studio.parts.choice.afterHint", { token: "{{choice}}" })}
                      actions={o.actions ?? []}
                      ctx={ctx}
                      onChange={(actions) => patchOption(o.id, { actions })}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ol>
        <button
          type="button"
          onClick={() => {
            const id = newOptionId();
            setOptions((list) => [...list, { id, title: t("studio.parts.choice.newOption", { n: list.length + 1 }) }]);
            setOpen(id);
          }}
          className="mt-2 flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-border px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
        >
          <Plus className="h-3 w-3" />
          {t("studio.parts.choice.addOption")}
        </button>
      </Section>
    </div>
  );
}

/** Tags as the creator types them: a comma list, kept as typed while the box
 *  has focus so a trailing comma is not eaten mid-word. */
function TagsInput({ value, onChange }: { value: string[]; onChange: (tags: string[]) => void }) {
  const { t } = useTranslation("editor");
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] text-muted-foreground">{t("studio.parts.choice.tags")}</span>
      <input
        value={draft ?? value.join(", ")}
        placeholder={t("studio.parts.choice.tagsPlaceholder")}
        onFocus={() => setDraft(value.join(", "))}
        onChange={(e) => { setDraft(e.target.value); onChange(parseTags(e.target.value)); }}
        onBlur={() => setDraft(null)}
        className={smallCls}
      />
    </label>
  );
}

