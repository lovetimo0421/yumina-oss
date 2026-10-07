import {
  METER_ROW_H, addElement, addMeterRow, addStackedRow, canReflow, newElement, updateElements,
  type UiDoc, type UiElement,
} from "@yumina/engine";
import { useEditorStore } from "@/stores/editor";
import { chatPageDoc, classifyInterface } from "./ui-doc-takeover";

/**
 * Put a variable on the player's screen in the shape that suits it: a number
 * as a meter, a list as a list, anything else as a "name: value" line — on the
 * page that holds the conversation, in a row above it.
 *
 * The other direction (add a part, then bind it) is the player-screen editor's;
 * this is for the creator who is looking at the variable and wants to see it.
 * A bare chat becomes a chat page first, the way adding any part makes it one.
 * Returns the page it landed on, or null when there was nowhere to put it.
 */
export function showVariableOnScreen(variableId: string, words: {
  chatPageName: string;
  /** "好感度：" — the line a plain value is shown after. */
  lineLabel: (name: string) => string;
}): string | null {
  const store = useEditorStore.getState();
  const variable = store.worldDraft.variables.find((v) => v.id === variableId);
  if (!variable) return null;
  let doc: UiDoc | undefined = store.worldDraft.uiDoc;
  if (!doc) {
    if (classifyInterface(store.worldDraft.rootComponent) === "handwritten") {
      store.adoptUiDoc();
      doc = useEditorStore.getState().worldDraft.uiDoc;
    } else {
      doc = chatPageDoc(words.chatPageName);
    }
  }
  if (!doc) return null;
  const page = doc.pages.find((p) => p.elements.some((el) => el.type === "messages" || el.type === "chat"))
    ?? doc.pages.find((p) => p.id === doc!.entryPageId) ?? doc.pages[0];
  if (!page) return null;
  const id = `el-${crypto.randomUUID().slice(0, 8)}`;

  let next: UiDoc;
  if (variable.type === "number") {
    next = canReflow(doc, page.id, METER_ROW_H)
      ? addMeterRow(doc, page.id, { id, label: variable.name, variableId: variable.id })
      : addElement(doc, page.id, newElement(page, { id, type: "meter", variableId: variable.id }));
    // The bar's ends are the variable's own range when it has one.
    if (variable.min !== undefined || variable.max !== undefined) {
      next = updateElements(next, page.id, [id], (el) => el.type !== "meter" ? el : {
        ...el,
        ...(variable.min !== undefined ? { min: { kind: "literal" as const, value: variable.min } } : {}),
        ...(variable.max !== undefined ? { max: { kind: "literal" as const, value: variable.max } } : {}),
      });
    }
  } else {
    const base = variable.type === "json"
      ? newElement(page, { id, type: "list" })
      : newElement(page, { id, type: "text", text: `${words.lineLabel(variable.name)}{{${variable.id}}}` });
    const el: UiElement = base.type === "list" ? { ...base, source: { kind: "variable", variableId: variable.id } } : base;
    next = addStackedRow(doc, page.id, el) ?? addElement(doc, page.id, el);
  }
  store.setUiDoc(next);
  return page.id;
}
