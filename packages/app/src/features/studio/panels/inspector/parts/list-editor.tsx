import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import type { UiElement, UiListCard, Variable } from "@yumina/engine";
import { ActionListEditor, type ActionContext } from "../element-behavior";
import { moveItem } from "./choice-editor";
import { idsToNames, namesToIds } from "./variable-text";
import { ImageField, NamedText, Section, Segmented, Toggle, VariableSelect, smallCls, useMakeVariable, type InsertToken } from "./part-kit";

type List = Extract<UiElement, { type: "list" }>;
type Row = Record<string, string>;

/** An authored row as a record. A plain string row is its own title — the
 *  shape the list had before rows could carry a picture. */
export const asRecord = (item: string | Record<string, string>): Row =>
  typeof item === "string" ? { title: item } : { ...item };

/** The picture shapes a card can have, as 图片高 ÷ 宽. `side` is the small
 *  square beside the text. */
const SHAPES = { side: undefined, wide: 0.56, square: 1, tall: 1.33 } as const;
type Shape = keyof typeof SHAPES;
const shapeOf = (card: UiListCard | undefined): Shape => {
  const r = card?.imageRatio;
  if (!r) return "side";
  if (r < 0.8) return "wide";
  if (r > 1.15) return "tall";
  return "square";
};

/**
 * 列表, the new half: rows written by hand as a small table (title, text,
 * picture), rows drawn as cards, rows locked until a variable admits them, and
 * what tapping a row does. A collection, a cast, a shop and a clue log are the
 * same part with different switches on.
 */
export function ListEditor({
  el, onPatch, variables, ctx, worldId,
}: {
  el: List;
  onPatch: (fn: (el: List) => List) => void;
  variables: Variable[];
  ctx: ActionContext;
  worldId?: string | null;
}) {
  const { t } = useTranslation("editor");
  const make = useMakeVariable();
  const source = el.source && typeof el.source === "object" ? el.source : { kind: "static" as const, items: [] };
  const isStatic = source.kind === "static";
  const isEntries = source.kind === "entries";
  const entryKey = source.kind === "entries" ? (source.folderId ? `folder:${source.folderId}` : `role:${source.role ?? "character"}`) : "";
  const [naming, setNaming] = useState<string | null>(null);
  const makeCharacter = () => {
    const name = naming?.trim();
    if (!name || !ctx.newCharacter) return;
    ctx.newCharacter(name);
    setNaming(null);
  };
  const rows = isStatic ? (source.items ?? []).map(asRecord) : [];
  // Which fields a row's title and text live in: the list's own display
  // decides. The map and collection templates write name/note rows and show
  // {{item.name}}; editing them as title/body left the boxes blank and wrote
  // where nothing reads.
  const shown = JSON.stringify([el.item, el.card]);
  const only = (field: string, other: string) => rows.some((r) => field in r) && !rows.some((r) => other in r);
  const titleKey = shown.includes("item.name") || only("name", "title") ? "name" : "title";
  const bodyKey = shown.includes("item.note") || only("note", "body") ? "note" : "body";
  const rowTokens: InsertToken[] = [
    { token: `item.${titleKey}`, label: t("studio.parts.list.tokenTitle") },
    { token: `item.${bodyKey}`, label: t("studio.parts.list.tokenBody") },
    { token: "item", label: t("studio.parts.list.tokenRow") },
    { token: "index", label: t("studio.parts.list.tokenIndex") },
  ];
  const lockedNamed = [...variables, ...rowTokens.map((tk) => ({ id: tk.token, name: tk.label }))];

  /** Rows are written back as records; a list still showing `{{item}}` for
   *  its text now shows the title instead of a JSON blob. */
  const setRows = (next: Row[]) => onPatch((l) => ({
    ...l,
    source: { kind: "static", items: next },
    item: !l.item?.template || l.item.template.trim() === "{{item}}" ? { template: `{{item.${titleKey}}}` } : l.item,
  }));
  const patchRow = (i: number, patch: Row) => setRows(rows.map((r, j) => {
    if (j !== i) return r;
    const next = { ...r, ...patch };
    for (const k of Object.keys(next)) if (next[k] === "") delete next[k];
    return next;
  }));
  const setCard = (patch: Partial<UiListCard> | null) => onPatch((l) => {
    if (patch === null) {
      const { card: _c, ...rest } = l;
      return rest as List;
    }
    const card = { ...(l.card ?? {}), ...patch } as UiListCard & Record<string, unknown>;
    for (const k of Object.keys(card)) if (card[k] === undefined) delete card[k];
    return { ...l, card };
  });

  return (
    <div data-testid="list-editor">
      <Section label={t("studio.parts.list.source")}>
        <Segmented
          label={t("studio.parts.list.source")}
          value={isStatic ? "static" : isEntries ? "entries" : "variable"}
          onChange={(mode) => {
            if (mode === "static") {
              onPatch((l) => ({ ...l, source: { kind: "static", items: [] } }));
              return;
            }
            if (mode === "entries") {
              // The card's characters, as cards with their portraits: the
              // name and the picture, and none of the text written for the AI
              // until the creator puts {{item.body}} under it.
              onPatch((l) => ({
                ...l,
                source: { kind: "entries", role: "character" },
                item: { template: "{{item.title}}" },
                card: l.card ?? { title: { template: "{{item.title}}" }, imageField: "image" },
              }));
              return;
            }
            const existing = variables.find((v) => v.type === "json" && !v.internal);
            const variableId = existing?.id ?? make(t("studio.parts.list.newVariableName"), "json", []).id;
            onPatch((l) => ({ ...l, source: { kind: "variable", variableId } }));
          }}
          options={[
            { value: "static", label: t("studio.parts.list.sourceStatic") },
            { value: "entries", label: t("studio.parts.list.sourceEntries") },
            { value: "variable", label: t("studio.parts.list.sourceVariable") },
          ]}
        />
        {/* Which variable is the panel's own 读取变量 row, right under this. */}
        {!isStatic && !isEntries && <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground/70">{t("studio.parts.list.variableHint")}</p>}
        {isEntries && (
          <div className="mt-2 flex flex-col gap-1.5" data-list-entries="">
            <select
              value={entryKey}
              aria-label={t("studio.parts.list.entriesWhich")}
              onChange={(e) => {
                const pick = ctx.entrySources?.find((s) => s.key === e.target.value);
                if (pick) onPatch((l) => ({ ...l, source: { kind: "entries", ...pick.source } }));
              }}
              className={smallCls}
            >
              {!(ctx.entrySources ?? []).some((s) => s.key === entryKey) && <option value={entryKey}>{entryKey}</option>}
              {(ctx.entrySources ?? []).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
            {ctx.newCharacter && entryKey === "role:character" && (naming === null ? (
              <button type="button" onClick={() => setNaming("")}
                className="flex items-center gap-1 self-start rounded px-1 py-0.5 text-[11px] text-primary hover:underline">
                {t("studio.parts.list.newCharacter")}
              </button>
            ) : (
              <div className="flex gap-1.5">
                <input autoFocus value={naming} onChange={(e) => setNaming(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") makeCharacter(); if (e.key === "Escape") setNaming(null); }}
                  placeholder={t("studio.element.newVariableName")} className={`${smallCls} min-w-0 flex-1`} />
                <button type="button" onClick={makeCharacter} disabled={!naming.trim()}
                  className="rounded-md bg-primary px-2.5 text-[11px] font-semibold text-primary-foreground disabled:opacity-40">
                  {t("studio.element.newVariableCreate")}
                </button>
              </div>
            ))}
          </div>
        )}
      </Section>

      {isStatic && (
        <Section label={t("studio.parts.list.rows")} testId="list-rows">
          <ol className="flex flex-col gap-1.5">
            {rows.map((row, i) => (
              <li key={i} className="flex flex-col gap-1 rounded-md border border-border/60 bg-background/40 p-1.5" data-testid="list-row">
                <div className="flex items-center gap-1">
                  <ImageField compact worldId={worldId} value={row.image} onChange={(ref) => patchRow(i, { image: ref ?? "" })} />
                  <input
                    value={row[titleKey] ?? ""}
                    aria-label={t("studio.parts.list.rowTitle")}
                    placeholder={t("studio.parts.list.rowTitle")}
                    onChange={(e) => patchRow(i, { [titleKey]: e.target.value })}
                    className={`${smallCls} min-w-0 flex-1`}
                  />
                  <button type="button" onClick={() => setRows(moveItem(rows, i, -1))} disabled={i === 0} title={t("studio.parts.moveUp")} aria-label={t("studio.parts.moveUp")} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30">
                    <ArrowUp className="h-3 w-3" />
                  </button>
                  <button type="button" onClick={() => setRows(moveItem(rows, i, 1))} disabled={i === rows.length - 1} title={t("studio.parts.moveDown")} aria-label={t("studio.parts.moveDown")} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30">
                    <ArrowDown className="h-3 w-3" />
                  </button>
                  <button type="button" onClick={() => setRows(rows.filter((_, j) => j !== i))} title={t("studio.parts.remove")} aria-label={t("studio.parts.remove")} className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
                    <X className="h-3 w-3" />
                  </button>
                </div>
                <input
                  value={row[bodyKey] ?? ""}
                  aria-label={t("studio.parts.list.rowBody")}
                  placeholder={t("studio.parts.list.rowBody")}
                  onChange={(e) => patchRow(i, { [bodyKey]: e.target.value })}
                  className={`${smallCls} ml-9 w-[calc(100%-2.25rem)]`}
                />
              </li>
            ))}
          </ol>
          <button
            type="button"
            onClick={() => setRows([...rows, { [titleKey]: t("studio.parts.list.newRow", { n: rows.length + 1 }) }])}
            className="mt-2 flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-border px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
          >
            <Plus className="h-3 w-3" />
            {t("studio.parts.list.addRow")}
          </button>
        </Section>
      )}

      <Section label={t("studio.parts.list.card")} hint={el.card ? undefined : t("studio.parts.list.cardHint")}>
        <Toggle
          label={t("studio.parts.list.cardOn")}
          checked={!!el.card}
          onChange={(on) => {
            if (!on) return setCard(null);
            setCard({
              title: { template: isStatic ? `{{item.${titleKey}}}` : el.item?.template || "{{item}}" },
              ...(isStatic ? { subtitle: { template: `{{item.${bodyKey}}}` }, imageField: "image" } : {}),
            });
          }}
        />
        {el.card && (
          <div className="mt-2 flex flex-col gap-2">
            {!isStatic && (
              <>
                <NamedText label={t("studio.parts.list.cardTitle")} value={el.card.title?.template ?? ""} variables={variables} tokens={rowTokens}
                  onChange={(template) => setCard({ title: template ? { template } : undefined })} />
                <NamedText label={t("studio.parts.list.cardSubtitle")} value={el.card.subtitle?.template ?? ""} variables={variables} tokens={rowTokens}
                  placeholder={t("studio.parts.list.cardSubtitle")}
                  onChange={(template) => setCard({ subtitle: template ? { template } : undefined })} />
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] text-muted-foreground">{t("studio.parts.list.imageField")}</span>
                  <input value={el.card.imageField ?? ""} placeholder="image" onChange={(e) => setCard({ imageField: e.target.value || undefined })} className={smallCls} />
                </label>
              </>
            )}
            <div className="flex flex-col gap-1">
              <span className="text-[10px] text-muted-foreground">{t("studio.parts.list.cardBadge")}</span>
              <NamedText label={t("studio.parts.list.cardBadge")} value={el.card.badge?.template ?? ""} variables={variables} tokens={rowTokens}
                onChange={(template) => setCard({ badge: template ? { template } : undefined })} />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[10px] text-muted-foreground">{t("studio.parts.list.imageShape")}</span>
              <Segmented
                label={t("studio.parts.list.imageShape")}
                value={shapeOf(el.card)}
                onChange={(shape) => {
                  setCard({ imageRatio: SHAPES[shape] });
                  // A picture on top wants cards side by side; one beside the
                  // text wants a column.
                  onPatch((l) => shape === "side"
                    ? { ...l, direction: "column" }
                    : { ...l, direction: "row", columns: l.columns && l.columns > 1 ? l.columns : 2 });
                }}
                options={(Object.keys(SHAPES) as Shape[]).map((s) => ({ value: s, label: t(`studio.parts.list.shape_${s}` as never) }))}
              />
            </div>
            {shapeOf(el.card) !== "side" && (
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-[10px] text-muted-foreground">{t("studio.parts.list.columns")}</span>
                <Segmented
                  label={t("studio.parts.list.columns")}
                  value={el.direction === "row" ? el.columns ?? 2 : 1}
                  onChange={(n) => onPatch((l) => (n === 1 ? { ...l, direction: "column" } : { ...l, direction: "row", columns: n }))}
                  options={[1, 2, 3, 4].map((n) => ({ value: n, label: String(n) }))}
                />
              </div>
            )}
          </div>
        )}
      </Section>

      {el.card && (
        <Section label={t("studio.parts.list.lock")} hint={el.card.lockedUnless ? t("studio.parts.list.lockHint", { field: el.card.lockedUnless.field }) : t("studio.parts.list.lockOffHint")}>
          <Toggle
            label={t("studio.parts.list.lockOn")}
            checked={!!el.card.lockedUnless}
            onChange={(on) => {
              if (!on) return setCard({ lockedUnless: undefined, lockedText: undefined });
              const existing = variables.find((v) => v.type === "json" && !v.internal && !(source.kind === "variable" && v.id === source.variableId));
              const variableId = existing?.id ?? make(t("studio.parts.list.lockVariableName"), "json", []).id;
              setCard({ lockedUnless: { variableId, field: isStatic ? "title" : "id" }, lockedText: { template: "？？？" } });
            }}
          />
          {el.card.lockedUnless && (
            <div className="mt-2 flex flex-col gap-2">
              <VariableSelect
                label={t("studio.parts.list.lockVariable")}
                value={el.card.lockedUnless.variableId}
                variables={variables}
                types={["json", "string"]}
                newName={t("studio.parts.list.lockVariableName")}
                newType="json"
                newDefault={[]}
                onChange={(variableId) => setCard({ lockedUnless: { ...el.card!.lockedUnless!, variableId } })}
              />
              <label className="flex flex-col gap-1">
                <span className="text-[10px] text-muted-foreground">{t("studio.parts.list.lockField")}</span>
                <input
                  value={el.card.lockedUnless.field}
                  onChange={(e) => setCard({ lockedUnless: { ...el.card!.lockedUnless!, field: e.target.value || "title" } })}
                  className={smallCls}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] text-muted-foreground">{t("studio.parts.list.lockedText")}</span>
                {/* Names on screen, ids in the document — like every other
                    text on the card (see variable-text.ts). */}
                <input
                  aria-label={t("studio.parts.list.lockedText")}
                  value={idsToNames(el.card.lockedText?.template ?? "", lockedNamed)}
                  onChange={(e) => setCard({ lockedText: e.target.value ? { template: namesToIds(e.target.value, lockedNamed) } : undefined })}
                  className={smallCls}
                />
              </label>
            </div>
          )}
        </Section>
      )}

      <ActionListEditor
        label={t("studio.parts.list.rowActions")}
        hint={t("studio.parts.list.rowActionsHint", { token: `{{item.${titleKey}}}` })}
        actions={el.rowActions ?? []}
        ctx={ctx}
        onChange={(rowActions) => onPatch((l) => {
          if (rowActions.length) return { ...l, rowActions };
          const { rowActions: _r, ...rest } = l;
          return rest as List;
        })}
      />
    </div>
  );
}

