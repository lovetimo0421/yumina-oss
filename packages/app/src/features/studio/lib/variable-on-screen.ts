import type { UiDoc } from "@yumina/engine";

/** Whether some part of the interface document already shows the variable —
 *  a meter or list bound to it, or a line that prints `{{id}}`. The button
 *  that puts it there kept saying 「放到玩家界面上」 after it was there. */
export function isVariableOnScreen(doc: UiDoc | undefined, variableId: string): boolean {
  if (!doc) return false;
  const bound = `"variableId":${JSON.stringify(variableId)}`;
  const printed = `{{${variableId}}}`;
  return doc.pages.some((page) => {
    const parts = JSON.stringify(page.elements);
    return parts.includes(bound) || parts.includes(printed);
  });
}
