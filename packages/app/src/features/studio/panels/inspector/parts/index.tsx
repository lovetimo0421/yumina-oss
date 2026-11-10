import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { LayoutGrid, PanelTop, TextCursorInput, type LucideIcon } from "lucide-react";
import { applyUiLook, nameFromQuestion, newElement, updateElements } from "@yumina/engine";
import type { UiAddableType, UiDoc, UiElement, UiPage, Variable } from "@yumina/engine";
import type { ActionContext } from "../element-behavior";
import { ChoiceEditor } from "./choice-editor";
import { FieldEditor } from "./field-editor";
import { ListEditor } from "./list-editor";
import { PopupEditor } from "./popup-editor";
import { RequiresEditor } from "./requires-editor";
import { LookPicker } from "./look-picker";
import { useEditorStore } from "@/stores/editor";
import { AutoNameContext, MakeVariableContext, type MakeVariable } from "./part-kit";

/**
 * The form parts — 卡片选择, 填写项, 弹窗 — and the new halves of 列表 and 按钮,
 * as the element panel sees them: three more entries for its add menu, one
 * way to make each, and one editor per selected part. element-panel.tsx only
 * dispatches here, so the panel's own layout stays its own.
 */

export type PartType = "choice" | "field" | "popup";

export const PART_ADDABLE: Array<{ type: PartType; icon: LucideIcon }> = [
  { type: "choice", icon: LayoutGrid },
  { type: "field", icon: TextCursorInput },
  { type: "popup", icon: PanelTop },
];

export const isPartType = (type: UiAddableType): type is PartType =>
  type === "choice" || type === "field" || type === "popup";

/**
 * A fresh variable with a name nobody has taken yet. `ensureVariableByName`
 * reuses a same-named variable, which is right for a behaviour naming one and
 * wrong here: two choices added in a row must not write the same variable.
 *
 * Made through `makeAutoVariable`, so the interface owns it: delete the part,
 * or point it at another variable, and this one goes too — unless something
 * else in the card has started reading it.
 */
export function useStoreMakeVariable(): MakeVariable {
  const make = useEditorStore((s) => s.makeAutoVariable);
  return useCallback((base, type, defaultValue, extra) => make(base, type, defaultValue, extra), [make]);
}

/**
 * What the AI is told about a variable a part made, so a filled-in answer
 * means something in the prompt. The prompt shows variables by id (a UUID
 * here), and only the rules line names them — without it the AI sees
 * `3f2a…: 林雾` and nothing about what 林雾 is.
 */
export function useAutoVariableRules() {
  const { t } = useTranslation("editor");
  return useMemo(() => ({
    field: (name: string) => t("studio.parts.field.aiRule", { name }),
    popup: (name: string) => t("studio.parts.popup.aiRule", { name }),
  }), [t]);
}

/** A part's name in the panel. The older parts keep their keys under
 *  `studio.element.kind`; the new ones live under `studio.parts.kind`. */
export const partKindKeys = (type: string) => [`studio.element.kind.${type}`, `studio.parts.kind.${type}`];

/**
 * A new part, ready to look like something the moment it lands: four cards
 * with names, a question with a hint, a popup with a title — and a fresh
 * variable of the right kind behind each, so it works before the creator has
 * touched a single setting.
 */
export function useCreatePart() {
  const { t } = useTranslation("editor");
  const make = useStoreMakeVariable();
  const rules = useAutoVariableRules();
  return useCallback((page: UiPage, type: PartType, id: string): UiElement => {
    if (type === "choice") {
      const variable = make(t("studio.parts.choice.newVariableName"), "string", "");
      const titles = t("studio.parts.choice.starterTitles").split("\n").filter(Boolean);
      const subtitle = t("studio.parts.choice.starterSubtitle");
      return newElement(page, {
        id, type, variableId: variable.id,
        options: titles.map((title, i) => ({ id: `${id}-o${i + 1}`, title, subtitle })),
      });
    }
    if (type === "field") {
      // Named for what the question asks (「你的名字是？」→「你的名字」), not
      // 「名字 2」「名字 3」; renamed with the question while it is still ours.
      const label = t("studio.parts.field.newLabel");
      const name = nameFromQuestion(label) || t("studio.parts.field.newVariableName");
      const variable = make(name, "string", "", { rule: rules.field });
      return newElement(page, {
        id, type, variableId: variable.id, fieldKind: "text",
        label, placeholder: t("studio.parts.field.newPlaceholder"),
      });
    }
    const title = t("studio.parts.popup.newTitle");
    const popupName = nameFromQuestion(title) || t("studio.parts.popup.newVariableName");
    const variable = make(popupName, "string", "", { rule: rules.popup });
    return newElement(page, {
      id, type, variableId: variable.id,
      label: t("studio.parts.popup.newTitle"), text: "{{value}}", buttonLabel: t("studio.parts.popup.newButton"),
    });
  }, [make, t, rules]);
}


/** The editor for whichever part is selected, or nothing for the older parts
 *  whose controls element-panel.tsx already draws. */
export function PartEditor({
  lead, doc, pageId, variables, ctx, worldId, edit,
}: {
  lead: UiElement;
  doc: UiDoc;
  pageId: string;
  variables: Variable[];
  ctx: ActionContext;
  worldId?: string | null;
  edit: (next: UiDoc) => void;
}) {
  const make = useStoreMakeVariable();
  const syncName = useEditorStore((s) => s.syncAutoVariableName);
  return (
    <MakeVariableContext.Provider value={make}>
      <AutoNameContext.Provider value={syncName}>
        <PartEditorBody lead={lead} doc={doc} pageId={pageId} variables={variables} ctx={ctx} worldId={worldId} edit={edit} />
      </AutoNameContext.Provider>
    </MakeVariableContext.Provider>
  );
}

function PartEditorBody({
  lead, doc, pageId, variables, ctx, worldId, edit,
}: {
  lead: UiElement;
  doc: UiDoc;
  pageId: string;
  variables: Variable[];
  ctx: ActionContext;
  worldId?: string | null;
  edit: (next: UiDoc) => void;
}) {
  const patch = <T extends UiElement>(fn: (el: T) => T) =>
    edit(updateElements(doc, pageId, [lead.id], (el) => (el.type === lead.type ? fn(el as T) : el)));
  return (
    <>
      <LookPicker el={lead} tokens={doc.theme?.tokens} onApply={(id) => patch((el) => applyUiLook(el, id))} />
      <PartEditorFields lead={lead} variables={variables} ctx={ctx} worldId={worldId} patch={patch} />
    </>
  );
}

function PartEditorFields({
  lead, variables, ctx, worldId, patch,
}: {
  lead: UiElement;
  variables: Variable[];
  ctx: ActionContext;
  worldId?: string | null;
  patch: <T extends UiElement>(fn: (el: T) => T) => void;
}) {
  switch (lead.type) {
    case "choice":
      return <ChoiceEditor el={lead} onPatch={patch} variables={variables} ctx={ctx} worldId={worldId} />;
    case "field":
      return <FieldEditor el={lead} onPatch={patch} variables={variables} />;
    case "popup":
      return <PopupEditor el={lead} onPatch={patch} variables={variables} worldId={worldId} />;
    case "list":
      return <ListEditor el={lead} onPatch={patch} variables={variables} ctx={ctx} worldId={worldId} />;
    case "button":
      return (
        <RequiresEditor
          value={lead.requires ?? []}
          variables={variables}
          onChange={(requires) => patch<Extract<UiElement, { type: "button" }>>((b) => {
            if (requires.length) return { ...b, requires };
            const { requires: _r, ...rest } = b;
            return rest as typeof b;
          })}
        />
      );
    default:
      return null;
  }
}
