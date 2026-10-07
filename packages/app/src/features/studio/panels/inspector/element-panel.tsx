import { useCallback, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, Check, Copy, FilePlus2, Gauge, Home, Image as ImageIcon, Link2, List, MousePointerClick, Pencil, Square, Trash2, Type, Unlink2 } from "lucide-react";
import {
  addElement, addMeterRow, addPage, addStackedRow, boundVariableOf, buttonActionsOf, canReflow, duplicateGroup,
  coveredOn, findElementPage, groupOf, movePage, newElement, rebindVariable, removeGroup, removePage, renamePage, setEntryPage, updateElements,
  METER_ROW_H,
} from "@yumina/engine";
import { remapUiVariable, type AudioTrack, type UiAddableType, type UiDoc, type UiElement, type Variable } from "@yumina/engine";
import { useEditorStore } from "@/stores/editor";
import { feedback } from "@/lib/feedback";
import { AssetPicker } from "@/features/editor/asset-picker";
import { ActionListEditor, ConditionEditor, type GreetingOption } from "./element-behavior";
import { StyleSection } from "./style-section";
import { ArrangeBar, LayersList } from "./canvas-selection";
import { PageBackground } from "./page-background";
import { cn } from "@/lib/utils";
import { VariableTextField } from "./variable-text-field";
import { PART_ADDABLE, PartEditor, isPartType, partKindKeys, useCreatePart } from "./parts";
import { MessageDesignEditor } from "./message-design-editor";
import { MoreSection, PageVariables, VariablePick } from "./page-variables";
import { buttonAis, buttonBehaviors, makeButtonAi, makeButtonBehavior, makeCharacter, openBehaviorOnCanvas } from "./button-behaviors";
import { pageLeaveHint } from "./page-leave-hint";

/**
 * Editing the card by pointing at it.
 *
 * The other sidebar answers "where is this in the code?", which is the right
 * question for a hand-written frontend and the wrong one for an arranged card:
 * there is no code to go to, only a document. So a card the layouts built gets
 * controls instead — the part you clicked, what it is bound to, what colour it
 * is, and whether it should still be there.
 *
 * Two things this leans on rather than reinventing:
 *
 *  - **Groups.** A meter is three elements and one thing. Selection, colour and
 *    delete all act on the group (see `groupOf` in the engine), so clicking a
 *    meter's label and clicking its track open the same controls.
 *  - **`setUiDoc` recompiles on a debounce.** Every edit here writes the whole
 *    document and lets that machinery redraw the card, which is why dragging a
 *    colour slider does not compile a card per frame.
 */

/** The element that decides what the group IS. A meter group holds two texts
 *  and a track; the track is the thing, the texts are its label. */
const PRIORITY: UiElement["type"][] = ["meter", "image", "list", "chat", "messages", "composer", "custom", "button", "text", "box"];
export const leadOf = (elements: UiElement[]): UiElement =>
  [...elements].sort((a, b) => PRIORITY.indexOf(a.type) - PRIORITY.indexOf(b.type))[0]!;

/** Chat, transcript and composer are the card. Everything else is decoration
 *  the creator put there, and can take away. */
const isLoadBearing = (el: UiElement) => el.type === "chat" || el.type === "messages" || el.type === "composer";

const ADDABLE: Array<{ type: UiAddableType; icon: typeof Type }> = [
  { type: "text", icon: Type },
  { type: "button", icon: MousePointerClick },
  { type: "image", icon: ImageIcon },
  { type: "box", icon: Square },
  { type: "meter", icon: Gauge },
  { type: "list", icon: List },
  ...PART_ADDABLE,
];

const newId = () => `el-${crypto.randomUUID().slice(0, 8)}`;

/**
 * The pages of the card, and the one being edited.
 *
 * A card with a second page — a cast to pick from, a map, a status sheet — was
 * something only a layout could make. The page the editor is on is also the
 * page the preview shows and the page new parts land on, so the three can
 * never disagree about where "here" is.
 */
export function PageBar({
  doc, pageId, onPage, onEdit, variables = [], onNew,
}: {
  doc: UiDoc;
  pageId: string;
  onPage: (pageId: string) => void;
  onEdit: (next: UiDoc) => void;
  variables?: ReadonlyArray<{ id: string; name: string }>;
  /** Opens the new-page gallery; without it the button adds a blank page. */
  onNew?: () => void;
}) {
  const { t } = useTranslation("editor");
  const pages = doc.pages ?? [];
  const current = pages.find((p) => p.id === pageId) ?? pages[0];
  const [renaming, setRenaming] = useState<string | null>(null);
  if (!current) return null;
  const nameOf = (i: number) => pages[i]?.name || t("studio.element.pageN", { n: i + 1 });
  const commitRename = () => {
    if (renaming !== null && renaming.trim()) onEdit(renamePage(doc, current.id, renaming.trim()));
    setRenaming(null);
  };
  return (
    <div className="border-b border-border/50 px-3 py-2.5" data-testid="page-bar">
      <span className="mb-1.5 block text-[11px] font-medium text-muted-foreground">{t("studio.element.page")}</span>
      <div className="flex items-center gap-1">
        {renaming !== null ? (
          <input
            autoFocus
            value={renaming}
            aria-label={t("studio.element.renamePage")}
            onChange={(e) => setRenaming(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") { e.stopPropagation(); setRenaming(null); }
            }}
            onBlur={commitRename}
            className="min-w-0 flex-1 rounded-md border border-primary bg-background px-2 py-1 text-xs outline-none"
          />
        ) : (
          <select
            value={current.id}
            aria-label={t("studio.element.page")}
            onChange={(e) => onPage(e.target.value)}
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:border-primary"
          >
            {pages.map((p, i) => (
              <option key={p.id} value={p.id}>
                {nameOf(i)}{p.id === doc.entryPageId ? ` · ${t("studio.element.entryPage")}` : ""}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          onMouseDown={(e) => { if (renaming !== null) e.preventDefault(); }}
          onClick={() => (renaming !== null ? commitRename() : setRenaming(current.name || nameOf(pages.indexOf(current))))}
          title={t("studio.element.renamePage")}
          aria-label={t("studio.element.renamePage")}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {renaming !== null ? <Check className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          onClick={() => {
            if (onNew) { onNew(); return; }
            const id = `page-${crypto.randomUUID().slice(0, 8)}`;
            onEdit(addPage(doc, { id, name: t("studio.element.pageN", { n: pages.length + 1 }) }));
            onPage(id);
          }}
          title={t("studio.element.addPage")}
          aria-label={t("studio.element.addPage")}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <FilePlus2 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          disabled={pages.length <= 1}
          onClick={() => {
            const next = removePage(doc, current.id);
            onEdit(next);
            onPage(next.entryPageId);
          }}
          title={t(pages.length <= 1 ? "studio.element.lastPage" : "studio.element.removePage")}
          aria-label={t("studio.element.removePage")}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {pages.length > 1 && (
        <ol className="mt-2 flex flex-col gap-px" aria-label={t("studio.element.pageList")} data-testid="page-list">
          {pages.map((p, i) => {
            const entry = p.id === doc.entryPageId;
            const leave = pageLeaveHint(doc, p, variables);
            return (
              <li
                key={p.id}
                data-page-row={p.id}
                className={cn("group flex items-center gap-1 rounded-md pl-2 pr-0.5", p.id === current.id ? "bg-primary/15" : "hover:bg-accent/60")}
              >
                <button type="button" onClick={() => onPage(p.id)} className="flex min-w-0 flex-1 flex-col py-1 text-left">
                  <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-foreground">
                    <span className="truncate">{nameOf(i)}</span>
                    {entry && (
                      <span title={t("studio.element.isEntry")} className="inline-flex shrink-0 items-center gap-0.5 rounded bg-primary/20 px-1 py-px text-[9px] font-semibold text-primary">
                        <Home className="h-2.5 w-2.5" />{t("studio.element.entryPage")}
                      </span>
                    )}
                  </span>
                  {leave && (
                    <span className="truncate text-[9px] text-muted-foreground/70" data-testid="page-leave-hint">
                      {t(`studio.element.${leave.key}`, {
                        name: leave.target.name || nameOf(pages.indexOf(leave.target)),
                        when: leave.variableName === null
                          ? t("studio.element.leaveNotStarted")
                          : t("studio.element.leaveVariableMet", { variable: leave.variableName }),
                      })}
                    </span>
                  )}
                </button>
                {!entry && (
                  <button
                    type="button"
                    onClick={() => onEdit(setEntryPage(doc, p.id))}
                    className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    {t("studio.element.setEntry")}
                  </button>
                )}
                <button
                  type="button"
                  disabled={i === 0}
                  onClick={() => onEdit(movePage(doc, p.id, i - 1))}
                  title={t("studio.element.movePageUp")}
                  aria-label={t("studio.element.movePageUp")}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-25"
                >
                  <ArrowUp className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  disabled={i === pages.length - 1}
                  onClick={() => onEdit(movePage(doc, p.id, i + 1))}
                  title={t("studio.element.movePageDown")}
                  aria-label={t("studio.element.movePageDown")}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-25"
                >
                  <ArrowDown className="h-3 w-3" />
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

export function ElementPanel({
  doc, selectedElementId, selectionIds, variables, canvas, onAddVariable,
  editPageId, onEditPage, greetings = [], tracks = [], onAdded, worldId,
  onSelectPart, hiddenIds = [], onToggleHidden, onNewPage,
}: {
  doc: UiDoc;
  /** The uiDoc element the creator clicked, or null when nothing is selected. */
  selectedElementId: string | null;
  /** Everything picked, the lead's group included. Colour and delete act on
   *  all of it; the fields that describe ONE thing — its text, its binding,
   *  its box — stay on the lead, because there is no sensible value to show
   *  for six elements at once. */
  selectionIds?: string[];
  variables: Variable[];
  /**
   * Which canvas the preview is showing. A card is laid out twice, so "move
   * this 20px left" has to mean the arrangement in front of the creator —
   * editing the phone's numbers while they look at the desktop is an edit that
   * appears to do nothing.
   */
  canvas: "phone" | "desktop";
  /** Makes a fresh 0-100 variable for "add a meter". Returns the name it
   *  actually took as well as its id — a second meter gets "New meter 2", and
   *  the row's label has to say the same thing its variable is called. */
  onAddVariable: (name: string) => { id: string; name: string };
  /** The page being edited when nothing is selected — where new parts land. */
  editPageId?: string;
  onEditPage?: (pageId: string) => void;
  /** The card's openings, in the order "切换开场白" counts them. */
  greetings?: GreetingOption[];
  tracks?: AudioTrack[];
  /** A part was just added; the host selects it once the preview has it. */
  onAdded?: (elementId: string) => void;
  /** For the image picker. Absent until the card has been saved once. */
  worldId?: string | null;
  /** The layers list picked a part; `additive` adds it to the selection. */
  onSelectPart?: (elementId: string, additive: boolean) => void;
  /** Parts hidden in the editor only (the layers list's eye). */
  hiddenIds?: string[];
  onToggleHidden?: (elementId: string) => void;
  /** Opens the new-page gallery. */
  onNewPage?: () => void;
}) {
  const { t } = useTranslation("editor");
  const setUiDoc = useEditorStore((s) => s.setUiDoc);
  // What a button's 「让一条行为生效」 picks from, makes, and opens, and what
  // a list can show of the card's entries.
  const reactions = useEditorStore((s) => s.worldDraft.reactions);
  const cardEntries = useEditorStore((s) => s.worldDraft.entries);
  const entryFolders = useEditorStore((s) => s.worldDraft.entryFolders);
  const worldbooks = useEditorStore((s) => s.worldDraft.worldbooks);
  const behaviorCtx = useMemo(() => {
    const live = (cardEntries ?? []).filter((e) => e.enabled !== false && e.role !== "greeting");
    const characters = live.filter((e) => e.role === "character").length;
    const entrySources = [
      { key: "role:character", source: { role: "character" }, label: String(t("studio.parts.list.entriesCharacters", { n: characters })) },
      ...(entryFolders ?? []).map((f) => ({
        key: `folder:${f.id}`,
        source: { folderId: f.id },
        label: String(t("studio.parts.list.entriesFolder", { name: f.name, n: live.filter((e) => e.folderId === f.id).length })),
      })),
    ];
    return { behaviors: buttonBehaviors(reactions), newBehavior: makeButtonBehavior, openBehavior: openBehaviorOnCanvas, entrySources, newCharacter: makeCharacter, ais: buttonAis(worldbooks), newAi: makeButtonAi };
  }, [reactions, cardEntries, entryFolders, worldbooks, t]);

  const pageId = selectedElementId ? findElementPage(doc, selectedElementId) : null;
  const ownGroup = useMemo(
    () => (pageId && selectedElementId ? groupOf(doc, pageId, selectedElementId) : []),
    [doc, pageId, selectedElementId],
  );
  const groupIds = selectionIds && selectionIds.length > ownGroup.length ? selectionIds : ownGroup;
  const multi = groupIds.length > ownGroup.length;
  const groupElements = useMemo(() => {
    const page = (doc.pages ?? []).find((p) => p.id === pageId);
    return page ? page.elements.filter((el) => groupIds.includes(el.id)) : [];
  }, [doc, pageId, groupIds]);
  const lead = groupElements.length > 0 ? leadOf(groupElements) : null;

  /** An element's box on the canvas in view. `null` means the layout takes it
   *  off this canvas, which is a real state and not a missing number. */
  const boxOn = useCallback(
    (el: UiElement) => {
      if (canvas !== "desktop") return { x: el.x, y: el.y, w: el.w, h: el.h };
      if (el.desktop === null) return null;
      return el.desktop ?? { x: el.x, y: el.y, w: el.w, h: el.h };
    },
    [canvas],
  );
  const leadBox = lead ? boxOn(lead) : null;

  const edit = useCallback((next: UiDoc) => setUiDoc(next), [setUiDoc]);

  const patchGroup = useCallback(
    (fn: (el: UiElement) => UiElement) => {
      if (!pageId) return;
      edit(updateElements(doc, pageId, groupIds, fn));
    },
    [doc, pageId, groupIds, edit],
  );

  // New parts land on the page the creator is looking at: the selected part's
  // page, or the one the page picker is on.
  const addPageId = pageId
    ?? (doc.pages ?? []).find((p) => p.id === editPageId)?.id
    ?? doc.entryPageId ?? doc.pages?.[0]?.id ?? "page-1";
  const [pickingImageFor, setPickingImageFor] = useState<string | null>(null);
  const createPart = useCreatePart();

  const addPart = useCallback((type: UiAddableType) => {
    const id = newId();
    const page = (doc.pages ?? []).find((p) => p.id === addPageId);
    if (!page) return;
    // A full page leaves a new part nowhere empty: it goes near the end of the
    // content instead of onto the title (engine freeSpotOn) — and the creator
    // is told, so a part half over the cards reads as "move me", not a bug.
    const nudgeIfCrowded = (el: UiElement) => {
      const box = canvas === "desktop" ? (el.desktop === null ? null : el.desktop ?? el) : el;
      if (box && coveredOn(page, canvas, { x: box.x, y: box.y, w: box.w, h: box.h }).length > 0) {
        feedback.notice(t("studio.element.noRoomNudge"));
      }
    };
    if (isPartType(type)) {
      // The part and the variable made for it are one undo step.
      const store = useEditorStore.getState();
      store.beginBatch();
      try {
        const part = createPart(page, type, id);
        edit(addElement(doc, addPageId, part));
        nudgeIfCrowded(part);
      } finally {
        store.commitBatch();
      }
      onAdded?.(id);
      return;
    }
    // A meter shows a number, so it comes with one — and on a page with a
    // transcript it joins the stack of rows above it, the way the layouts
    // place theirs, rather than floating over the conversation.
    if (type === "meter") {
      const store = useEditorStore.getState();
      store.beginBatch();
      try {
        const created = onAddVariable(t("studio.element.newMeterName"));
        edit(canReflow(doc, addPageId, METER_ROW_H)
          ? addMeterRow(doc, addPageId, { id, label: created.name, variableId: created.id })
          : addElement(doc, addPageId, newElement(page, { id, type, variableId: created.id })));
      } finally {
        store.commitBatch();
      }
      onAdded?.(id);
      return;
    }
    const text = type === "text" ? t("studio.element.newText")
      : type === "button" ? t("studio.element.newButton")
      : type === "list" ? t("studio.element.newListItems")
      : undefined;
    const el = newElement(page, { id, type, text });
    // On a chat page, words and lists take a row above the conversation
    // rather than a spot on top of it.
    const stacked = type === "text" || type === "list" ? addStackedRow(doc, addPageId, el) : null;
    if (stacked) {
      edit(stacked);
    } else {
      edit(addElement(doc, addPageId, el));
      nudgeIfCrowded(el);
    }
    onAdded?.(id);
  }, [doc, addPageId, onAddVariable, edit, t, onAdded, createPart, canvas]);

  /** A meter's label and the variable made for it say the same thing until
   *  the creator names the variable themselves (then it is theirs). */
  // A label and the variable behind it that say the same thing are one
  // thing to the creator: renaming 金币 to 今晚收入 on the screen and leaving
  // the AI told about 金币 was an edit that only half happened. Whether they
  // match is read when the part is picked, so clearing the field on the way
  // to a new name does not break the link.
  const nameLink = useRef<{ partId: string; variableId: string } | null>(null);
  const syncMeterVariableName = useCallback((variableId: string, _before: string, after: string) => {
    const store = useEditorStore.getState();
    const world = store.worldDraft;
    if (nameLink.current?.variableId !== variableId) return;
    const index = world.variables.findIndex((v) => v.id === variableId);
    const variable = world.variables[index];
    const next = after.trim();
    if (!variable || !next || /\{\{/.test(next) || variable.name.trim() === next) return;
    if (world.variables.some((v) => v.id !== variableId && v.name.trim() === next)) return;
    store.updateVariableAt(index, { name: next });
  }, []);

  const addMenu = (
    <div className="px-3 py-3" data-testid="add-part">
      <span className="mb-1.5 block text-[11px] font-medium text-muted-foreground">{t("studio.element.addPart")}</span>
      <div className="grid grid-cols-3 gap-1.5">
        {ADDABLE.map(({ type, icon: Icon }) => (
          <button
            key={type}
            type="button"
            onClick={() => addPart(type)}
            className="flex flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border px-1 py-2 text-[11px] font-medium text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
          >
            <Icon className="h-3.5 w-3.5" />
            {t(partKindKeys(type) as never)}
          </button>
        ))}
      </div>
    </div>
  );

  const layers = (onPageId: string) => onSelectPart && onToggleHidden ? (
    <LayersList doc={doc} pageId={onPageId} selectedIds={selectionIds ?? []} hiddenIds={hiddenIds}
      onSelect={onSelectPart} onToggleHidden={onToggleHidden} />
  ) : null;

  // On a wide screen the page strip on the left does all of this; the bar
  // stays for the narrow sheet, where there is no strip.
  const pageBar = onEditPage ? (
    <div className={onNewPage ? "@[880px]:hidden" : undefined}>
      <PageBar doc={doc} pageId={addPageId} onPage={onEditPage} onEdit={edit} variables={variables} onNew={onNewPage} />
    </div>
  ) : null;

  if (!lead || !pageId) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-y-auto">
        {pageBar}
        {addPageId && <PageVariables doc={doc} pageId={addPageId} variables={variables} onEdit={edit} />}
        <p className="px-3 pt-3 text-[11px] leading-relaxed text-muted-foreground">{t("studio.element.emptyHint")}</p>
        {addPageId && <PageBackground doc={doc} pageId={addPageId} worldId={worldId} onEdit={edit} />}
        {addMenu}
        {layers(addPageId)}
      </div>
    );
  }

  const bound = boundVariableOf(lead);
  const bindable = lead.type === "meter" ? variables.filter((v) => v.type === "number")
    : lead.type === "list" ? variables.filter((v) => v.type === "json")
    : lead.type === "image" ? variables.filter((v) => v.type === "string")
    : variables;
  // A meter's label is the text element beside it that holds no macro.
  const labelEl = groupElements.find((el) => el.type === "text" && !boundVariableOf(el));
  const textEl = lead.type === "text" ? lead : labelEl;
  // The variable the part shows, whichever of its pieces was picked.
  const groupBound = bound ?? groupElements.map((el) => boundVariableOf(el)).find(Boolean);
  const linkVar = groupBound && labelEl ? variables.find((v) => v.id === groupBound) : undefined;
  if (nameLink.current?.partId !== lead.id) {
    nameLink.current = linkVar && labelEl && labelEl.type === "text" && linkVar.name.trim() === labelEl.text.template.trim()
      ? { partId: lead.id, variableId: linkVar.id } : null;
  }
  const linkedName = nameLink.current?.variableId ? variables.find((v) => v.id === nameLink.current!.variableId)?.name : undefined;
  const buttonLabel = lead.type === "button" ? lead.label.template : null;

  return (
    // Keyed on the part: selecting another one starts the panel at its top.
    // It kept the last part's scroll, so a new status bar opened on its
    // colour stops with its 读取变量 scrolled out of sight.
    <div key={lead.id} className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2.5">
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">
          {multi
            ? t("studio.element.manyPicked", { count: new Set(groupElements.map((el) => el.group ?? el.id)).size })
            : t(partKindKeys(lead.type) as never)}
        </span>
        {!isLoadBearing(lead) && (
          <button
            type="button"
            onClick={() => edit(duplicateGroup(doc, pageId, groupIds, `el-${crypto.randomUUID().slice(0, 8)}`, canvas))}
            title={t("studio.element.duplicate")}
            aria-label={t("studio.element.duplicate")}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
        )}
        {!isLoadBearing(lead) && (
          <button
            type="button"
            onClick={() => edit(removeGroup(doc, pageId, groupIds))}
            title={t("studio.element.remove")}
            aria-label={t("studio.element.remove")}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {pageBar}

      {/* What the part shows, first: on a ready-made page the thing to change
          is whose value it is, and it sat below arranging, layering and the
          words, and for text only inside the words as {{id}}. */}
      {!multi && lead.type === "meter" && bound !== null && (
        <MeterBinding
          meter={lead}
          onRange={(range) => patchGroup((el) => (el.type === "meter" ? {
            ...el,
            ...(range.min !== undefined ? { min: { kind: "literal" as const, value: range.min } } : {}),
            ...(range.max !== undefined ? { max: { kind: "literal" as const, value: range.max } } : {}),
          } : el))}
          bound={bound}
          variables={variables}
          label={labelEl?.type === "text" ? labelEl.text.template : ""}
          onAddVariable={onAddVariable}
          onRebind={(variableId) => patchGroup((el) => (boundVariableOf(el) ? rebindVariable(el, variableId) : el))}
        />
      )}

      {!multi && lead.type !== "meter" && lead.type !== "image" && groupBound && (
        <div className="border-b border-border/50 px-3 py-2.5" data-part-shows="">
          <VariablePick
            label={t("studio.element.shows")}
            value={groupBound}
            variables={lead.type === "list" ? bindable : variables}
            type={lead.type === "list" ? "json" : null}
            onPick={(to) => patchGroup((el) => remapUiVariable(el, groupBound, to))}
          />
        </div>
      )}

      {isLoadBearing(lead) && (
        <p className="border-b border-border/50 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
          {t("studio.element.loadBearing")}
        </p>
      )}

      {!multi && buttonLabel !== null ? (
        <VariableTextField
          label={t("studio.element.label")}
          starter={t("studio.element.newButton")}
          value={buttonLabel}
          variables={variables}
          onChange={(template) => edit(updateElements(doc, pageId, [lead.id], (el) =>
            el.type === "button" ? { ...el, label: { template } } : el))}
        />
      ) : !multi && textEl && textEl.type === "text" && (
        <VariableTextField
          label={t("studio.element.label")}
          starter={t("studio.element.newText")}
          value={textEl.text.template}
          variables={variables}
          onChange={(template) => {
            edit(updateElements(doc, pageId, [textEl.id], (el) =>
              el.type === "text" ? { ...el, text: { template } } : el));
            // A meter's label and the variable made for it say the same
            // thing until the creator names the variable themselves.
            if (groupBound && textEl.id === labelEl?.id) syncMeterVariableName(groupBound, textEl.text.template, template);
          }}
        />
      )}
      {!multi && linkedName && (
        <p className="-mt-1 border-b border-border/50 px-3 pb-2 text-[10.5px] text-muted-foreground" data-name-linked="">
          {t("studio.element.nameLinked", { name: linkedName })}
        </p>
      )}

      {!multi && lead.type === "button" && (
        <ActionListEditor
          actions={buttonActionsOf(lead)}
          ctx={{ variables, pages: doc.pages ?? [], pageId, greetings, tracks, ...behaviorCtx }}
          onChange={(actions) => edit(updateElements(doc, pageId, [lead.id], (el) => {
            if (el.type !== "button") return el;
            // The older single-step spelling is folded in on the first edit.
            const { action: _legacy, ...rest } = el as typeof el & { action?: unknown };
            return { ...rest, actions };
          }))}
        />
      )}

      {!multi && lead.type === "image" && (
        <div className="border-b border-border/50 px-3 py-2.5">
          {/* A portrait or a scene that changes with the story reads a
              variable; a fixed picture is one asset. Same part, one choice. */}
          {variables.some((v) => v.type === "string") && (
            <select
              value={lead.src.kind === "variable" ? lead.src.variableId : ""}
              aria-label={t("studio.element.imageSource")}
              data-testid="image-source"
              onChange={(e) => {
                const variableId = e.target.value;
                edit(updateElements(doc, pageId, [lead.id], (el) => {
                  if (el.type !== "image") return el;
                  if (variableId) return { ...el, src: { kind: "variable", variableId, ...(el.src.kind === "asset" && el.src.ref ? { fallback: el.src.ref } : {}) } };
                  return { ...el, src: { kind: "asset", ref: el.src.kind === "variable" ? el.src.fallback ?? "" : el.src.ref } };
                }));
              }}
              className="mb-1.5 w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary"
            >
              <option value="">{t("studio.element.imageFixed")}</option>
              {variables.filter((v) => v.type === "string").map((v) => (
                <option key={v.id} value={v.id}>{t("studio.element.imageFollows", { name: v.name })}</option>
              ))}
            </select>
          )}
          {lead.src.kind === "asset" && <button
            type="button"
            disabled={!worldId}
            title={worldId ? undefined : t("studio.element.saveFirst")}
            onClick={() => setPickingImageFor(lead.id)}
            className="w-full rounded-md border border-border px-2 py-1.5 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-40"
          >
            {t(lead.src.kind === "asset" && lead.src.ref ? "studio.element.changeImage" : "studio.element.pickImage")}
          </button>}
          {lead.media === "video" && (
            <div className="mt-2 space-y-1.5" data-video-playback>
              <PlaybackChoice label={t("studio.element.videoPlay")}
                options={[[true, t("studio.element.videoLoop")], [false, t("studio.element.videoOnce")]]}
                value={lead.loop !== false}
                onChange={(loop) => edit(updateElements(doc, pageId, [lead.id], (el) => el.type === "image" ? { ...el, loop } : el))} />
              <PlaybackChoice label={t("studio.element.videoSound")}
                options={[[false, t("studio.element.videoMuted")], [true, t("studio.element.videoWithSound")]]}
                value={lead.sound === true}
                onChange={(sound) => edit(updateElements(doc, pageId, [lead.id], (el) => el.type === "image" ? { ...el, sound } : el))} />
            </div>
          )}
          {pickingImageFor && worldId && createPortal(
            <AssetPicker
              worldId={worldId}
              filterType="media"
              onSelect={(ref, type) => {
                const target = pickingImageFor;
                setPickingImageFor(null);
                edit(updateElements(doc, pageId, [target], (el) => {
                  if (el.type !== "image") return el;
                  // A picture drops the clip-only settings; a clip starts as a muted loop.
                  const { media: _media, loop: _loop, sound: _sound, ...still } = el;
                  return type === "video"
                    ? { ...still, src: { kind: "asset", ref }, media: "video" as const }
                    : { ...still, src: { kind: "asset", ref } };
                }));
              }}
              onClose={() => setPickingImageFor(null)}
            />,
            document.body,
          )}
        </div>
      )}

      {!multi && (
        <PartEditor
          lead={lead}
          doc={doc}
          pageId={pageId}
          variables={variables}
          ctx={{ variables, pages: doc.pages ?? [], pageId, greetings, tracks, ...behaviorCtx }}
          worldId={worldId}
          edit={edit}
        />
      )}

      {!multi && (lead.type === "chat" || lead.type === "messages") && (
        <MessageDesignEditor lead={lead} doc={doc} pageId={pageId} edit={edit} worldId={worldId} />
      )}

      <MoreSection label={t("studio.element.more")}>
      <ArrangeBar doc={doc} pageId={pageId} ids={groupIds} canvas={canvas} onEdit={edit} />

      {!multi && (
        <ConditionEditor
          condition={lead.visibleWhen}
          variables={variables}
          onChange={(visibleWhen) => patchGroup((el) => {
            // The whole group shows and hides together — a meter's label
            // should not outlive its track.
            if (visibleWhen) return { ...el, visibleWhen };
            const { visibleWhen: _drop, ...rest } = el;
            return rest as UiElement;
          })}
        />
      )}

      <StyleSection
        doc={doc}
        targets={groupElements}
        lead={lead}
        canvas={canvas}
        onPatch={patchGroup}
        onDoc={edit}
        worldId={worldId}
      />

      <div className="border-b border-border/50 px-3 py-2.5" hidden={multi}>
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[11px] font-medium text-muted-foreground">{t("studio.element.box")}</span>
          <span className="rounded bg-accent px-1.5 py-0.5 text-[9px] text-muted-foreground">
            {t(canvas === "desktop" ? "studio.element.onDesktop" : "studio.element.onPhone")}
          </span>
        </div>
        {leadBox === null ? (
          <p className="text-[11px] leading-relaxed text-muted-foreground">{t("studio.element.hiddenHere")}</p>
        ) : (
          <div className="grid grid-cols-4 gap-1.5">
            {(["x", "y", "w", "h"] as const).map((axis) => (
              <label key={axis} className="flex flex-col gap-1">
                <span className="text-[9px] uppercase tracking-wide text-muted-foreground/60">{axis}</span>
                <input
                  type="number"
                  value={Math.round(leadBox[axis])}
                  onChange={(e) => {
                    // A cleared field is the creator mid-retype, not a request
                    // for 0: Number("") is 0, and treating it as one jumped the
                    // element to the corner (or, for w/h, made it vanish).
                    const raw = e.target.value.trim();
                    if (raw === "") return;
                    const parsed = Number(raw);
                    if (!Number.isFinite(parsed)) return;
                    const next = axis === "w" || axis === "h" ? Math.max(1, parsed) : parsed;
                    const delta = next - leadBox[axis];
                    // The whole group moves together; resizing applies to the
                    // part that was measured, so a label does not become a track.
                    patchGroup((el) => {
                      const b = boxOn(el);
                      if (b === null) return el;
                      const moved = axis === "x" || axis === "y"
                        ? { ...b, [axis]: b[axis] + delta }
                        : el.id === lead.id ? { ...b, [axis]: next } : b;
                      return canvas === "desktop"
                        ? { ...el, desktop: moved }
                        : { ...el, x: moved.x, y: moved.y, w: moved.w, h: moved.h };
                    });
                  }}
                  className="w-full rounded border border-border bg-background px-1.5 py-1 text-[11px] outline-none focus:border-primary"
                />
              </label>
            ))}
          </div>
        )}
        {/* The card is laid out twice. A part with no wide box of its own sits
            where the phone puts it on both; once it is moved on the computer
            the two part ways, and nothing on screen said so. */}
        <div data-layout-link={lead.desktop === undefined ? "shared" : lead.desktop === null ? "off" : "own"}
          className="mt-2 flex items-center gap-1.5 text-[10.5px] leading-snug text-muted-foreground">
          {lead.desktop === undefined ? <Link2 className="h-3 w-3 shrink-0" /> : <Unlink2 className="h-3 w-3 shrink-0 text-amber-400" />}
          <span className="min-w-0 flex-1">
            {t(lead.desktop === undefined ? "studio.element.layoutShared"
              : lead.desktop === null ? (canvas === "desktop" ? "studio.element.layoutOffHere" : "studio.element.layoutOffDesktop")
              : "studio.element.layoutOwn")}
          </span>
          {lead.desktop !== undefined && (
            <button type="button" data-layout-reset=""
              onClick={() => patchGroup((el) => {
                if (el.desktop === undefined) return el;
                const { desktop: _own, ...rest } = el;
                return rest as UiElement;
              })}
              className="shrink-0 rounded px-1.5 py-0.5 text-[10.5px] font-medium text-primary hover:bg-primary/10">
              {t("studio.element.layoutFollowPhone")}
            </button>
          )}
        </div>
      </div>
      </MoreSection>

      {addMenu}
      {layers(pageId)}
    </div>
  );
}

/**
 * Which number a meter shows, and that number's range — in one place.
 * Changing the range used to mean leaving the screen for the variables
 * block; and pointing a meter at something new meant making the variable
 * somewhere else first.
 */
function MeterBinding({ meter, onRange, bound, variables, label, onAddVariable, onRebind }: {
  meter: UiElement;
  /** The bar's own ends; the variable's range is kept the same beside it. */
  onRange: (range: { min?: number; max?: number }) => void;
  bound: string;
  variables: Variable[];
  label: string;
  onAddVariable: (name: string) => { id: string; name: string };
  onRebind: (variableId: string) => void;
}) {
  const { t } = useTranslation("editor");
  const numbers = variables.filter((v) => v.type === "number");
  const index = variables.findIndex((v) => v.id === bound);
  const variable = variables[index];
  const updateVariableAt = useEditorStore((s) => s.updateVariableAt);
  const numberField = "w-full rounded border border-border bg-background px-1.5 py-1 text-[11px] outline-none focus:border-primary";
  const end = (key: "min" | "max") => {
    const n = meter.type === "meter" ? meter[key] : undefined;
    return n?.kind === "literal" ? n.value : variable?.[key];
  };
  const shown = { min: end("min"), max: end("max"), defaultValue: variable?.defaultValue };
  const setNumber = (key: "min" | "max" | "defaultValue", raw: string) => {
    if (index < 0) return;
    const value = Number(raw.trim());
    // A cleared box is the creator mid-retype, not a request for 0.
    if (raw.trim() === "" || !Number.isFinite(value)) return;
    const store = useEditorStore.getState();
    store.beginBatch();
    try {
      updateVariableAt(index, { [key]: value });
      if (key !== "defaultValue") onRange({ [key]: value });
    } finally {
      store.commitBatch();
    }
  };
  return (
    <div className="border-b border-border/50 px-3 py-2.5" data-testid="meter-binding">
      <span className="mb-1.5 block text-[11px] font-medium text-muted-foreground">{t("studio.element.binding")}</span>
      <select
        value={bound}
        onChange={(e) => {
          if (e.target.value !== "__new__") { onRebind(e.target.value); return; }
          const store = useEditorStore.getState();
          store.beginBatch();
          try {
            const made = onAddVariable(label.trim() || t("studio.element.newMeterName"));
            onRebind(made.id);
          } finally {
            store.commitBatch();
          }
        }}
        className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary"
      >
        {numbers.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        {!numbers.some((v) => v.id === bound) && <option value={bound}>{bound}</option>}
        <option value="__new__">{t("studio.element.newNumberVariable")}</option>
      </select>
      {variable && (
        <div className="mt-2 grid grid-cols-3 gap-1.5">
          {([["min", "studio.element.rangeMin"], ["max", "studio.element.rangeMax"], ["defaultValue", "studio.element.rangeStart"]] as const).map(([key, labelKey]) => (
            <label key={key} className="flex flex-col gap-1">
              <span className="text-[10px] text-muted-foreground/70">{t(labelKey)}</span>
              <input
                type="number"
                value={shown[key] === undefined || shown[key] === null ? "" : String(shown[key])}
                onChange={(e) => setNumber(key, e.target.value)}
                className={numberField}
              />
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/** Two-way choice for a clip's playback (loop/once, muted/sound). */
function PlaybackChoice({ label, options, value, onChange }: {
  label: string;
  options: [boolean, string][];
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="w-10 shrink-0 text-muted-foreground">{label}</span>
      <div className="flex flex-1 gap-1">
        {options.map(([v, text]) => (
          <button key={String(v)} type="button" aria-pressed={value === v} onClick={() => onChange(v)}
            className={`flex-1 rounded-md border px-2 py-1 transition-colors ${value === v ? "border-primary/60 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground"}`}>
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}
