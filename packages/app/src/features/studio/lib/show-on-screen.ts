import {
  METER_ROW_H, UI_CANVAS_W, UI_DESKTOP_W, addElement, addMeterRow, addStackedRow, canReflow, newElement, updateElements,
  type UiDoc, type UiElement,
} from "@yumina/engine";
import { useEditorStore } from "@/stores/editor";
import { chatPageDoc, classifyInterface } from "./ui-doc-takeover";
import { isVariableOnScreen, removeVariableFromScreen } from "./variable-on-screen";

export function hideVariableOnScreen(variableId: string): void {
  const store = useEditorStore.getState();
  if (!store.worldDraft.uiDoc || store.readOnlyInspect || store.guestMode) return;
  const next = removeVariableFromScreen(store.worldDraft.uiDoc, variableId);
  if (next !== store.worldDraft.uiDoc) store.setUiDoc(next, { keepAutoVariables: true });
}

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
  if (store.readOnlyInspect || store.guestMode) return null;
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
  if (isVariableOnScreen(doc, variableId)) return null;
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
    const el: UiElement = base.type === "list" ? { ...base, h: 96, desktop: base.desktop ? { ...base.desktop, h: 96 } : undefined, source: { kind: "variable", variableId: variable.id } } : base;
    next = addStackedRow(doc, page.id, el) ?? addElement(doc, page.id, el);
    if (el.type === "list") {
      const placed = next.pages.find(p => p.id === page.id)!.elements.find(item => item.id === id)!;
      const label: UiElement = {
        id: `${id}-label`, group: `g-${id}`, type: "text",
        x: placed.x, y: placed.y, w: placed.w, h: 20,
        desktop: placed.desktop ? { ...placed.desktop, h: 20 } : undefined,
        text: { template: variable.name }, style: { size: 12, color: "var(--yc-name, #a3a3a3)" },
      };
      next = updateElements(next, page.id, [id], item => ({
        ...item, group: `g-${id}`, y: item.y + 24, h: 72,
        desktop: item.desktop ? { ...item.desktop, y: item.desktop.y + 24, h: 72 } : undefined,
      }));
      next = addElement(next, page.id, label);
    }
  }
  const previousIds = new Set(page.elements.map(el => el.id));
  next = { ...next, pages: next.pages.map(p => p.id !== page.id ? p : {
    ...p, elements: p.elements.map(el => previousIds.has(el.id) ? el : { ...el, variableDisplay: variableId }),
  }) };
  // The preserved frontend has no transcript box to reflow. Reserve a real
  // strip ABOVE that frontend instead of laying the new part over its words.
  if (doc.base || doc.surface === "chat") {
    const added = next.pages.find(p => p.id === page.id)!.elements.filter(el => !previousIds.has(el.id));
    const phoneTop = Math.max(8, ...page.elements.filter(el => el.variableDisplay).map(el => el.y + el.h + 8));
    const wideTop = Math.max(8, ...page.elements.filter(el => el.variableDisplay).map(el => (el.desktop?.y ?? el.y) + (el.desktop?.h ?? el.h) + 8));
    const minY = Math.min(...added.map(el => el.y));
    next = { ...next, pages: next.pages.map(p => p.id !== page.id ? p : {
      ...p, elements: p.elements.map(el => previousIds.has(el.id) ? el : {
        ...el, x: 16, y: phoneTop + el.y - minY, w: UI_CANVAS_W - 32,
        desktop: { x: 16, y: wideTop + el.y - minY, w: UI_DESKTOP_W - 32, h: el.h },
      }),
    }) };
  }
  store.setUiDoc(next);
  return page.id;
}
