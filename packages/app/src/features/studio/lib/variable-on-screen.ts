import { removeGroup, type UiDoc, type UiElement } from "@yumina/engine";

/** Whether some part of the interface document already shows the variable —
 *  a meter or list bound to it, or a line that prints `{{id}}`. The button
 *  that puts it there kept saying 「放到玩家界面上」 after it was there. */
export function isVariableOnScreen(doc: UiDoc | undefined, variableId: string): boolean {
  return !!doc?.pages.some(page => page.elements.some(el => displaysVariable(el, variableId)));
}

function displaysVariable(el: UiElement, id: string): boolean {
  if (el.type === "list") return el.source?.kind === "variable" && el.source.variableId === id;
  if (el.type === "meter") return (el.value?.kind === "variable" && el.value.variableId === id)
    || (el as unknown as { variableId?: string }).variableId === id;
  if (el.type !== "text") return false;
  const text = typeof el.text === "string" ? el.text : el.text?.template ?? "";
  const ids = [...text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map(match => match[1]);
  // A mixed text block is an authored composition, not this switch's display.
  return ids.length > 0 && ids.every(value => value === id);
}

/** Includes old unmarked one-click displays, but never actions, conditions,
 *  input fields, or a custom group's unrelated elements. */
export function removeVariableFromScreen(doc: UiDoc, variableId: string): UiDoc {
  let next = doc;
  for (const page of doc.pages) {
    const ids = new Set(page.elements.filter(el => displaysVariable(el, variableId)).map(el => el.id));
    for (const el of page.elements) {
      // The binding is authoritative: an author may have rebound this part
      // or changed a list to static content since the switch created it.
      if (ids.has(el.id) && el.variableDisplay && el.group) {
        for (const sibling of page.elements) {
          if (sibling.group === el.group && sibling.variableDisplay === el.variableDisplay) ids.add(sibling.id);
        }
      }
      if (el.type !== "meter" || !ids.has(el.id) || el.group !== `g-${el.id}`) continue;
      for (const suffix of ["-label", "-value"]) {
        const sibling = page.elements.find(item => item.id === el.id + suffix && item.group === el.group && item.type === "text");
        if (sibling) ids.add(sibling.id);
      }
    }
    if (!ids.size) continue;
    if (!doc.base && doc.surface !== "chat") {
      next = removeGroup(next, page.id, [...ids]);
      continue;
    }
    // Preserved frontends have no transcript to reflow. Only move the managed
    // strips below a removed strip; authored overlays keep their geometry.
    const removed = page.elements.filter(el => ids.has(el.id) && el.variableDisplay);
    const shift = (desktop: boolean) => {
      const boxes = removed.map(el => desktop ? (el.desktop ?? el) : el);
      const top = Math.min(...boxes.map(el => el.y));
      const bottom = Math.max(...boxes.map(el => el.y + el.h));
      return { bottom, amount: boxes.length ? bottom - top + 8 : 0 };
    };
    const phone = shift(false), wide = shift(true);
    next = { ...next, pages: next.pages.map(p => p.id !== page.id ? p : {
      ...p, elements: p.elements.filter(el => !ids.has(el.id)).map(el => {
        if (!el.variableDisplay) return el;
        return { ...el, y: el.y >= phone.bottom ? el.y - phone.amount : el.y,
          ...(el.desktop ? { desktop: { ...el.desktop, y: el.desktop.y >= wide.bottom ? el.desktop.y - wide.amount : el.desktop.y } } : {}),
        };
      }),
    }) };
  }
  return next;
}
