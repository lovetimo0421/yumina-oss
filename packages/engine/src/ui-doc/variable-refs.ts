import { UI_CHAT_STARTED, type UiDoc } from "./types.js";

/** Tokens a part resolves itself (a list row, a pick, a popup's value). */
const SCOPE_TOKEN = /^(item|index|choice|value)(\.|$)/;

/**
 * Which variables a UI doc reads and writes, from its bindings.
 *
 * The compiled doc reads every value through one runtime helper keyed by the
 * binding's id, so scanning the generated code finds a single dynamic read and
 * no names. The doc itself says exactly which variables it binds: value
 * sources `{ kind: "variable", variableId }`, `{{id}}` macros in text, and
 * `set-variable` actions for writes, and the variables `visibleWhen` conditions
 * compare.
 */
export function uiDocVariableRefs(doc: UiDoc): { reads: string[]; writes: string[] } {
  const reads = new Set<string>();
  const writes = new Set<string>();
  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      for (const m of node.matchAll(/\{\{\s*([^{}\s]+)\s*\}\}/g)) {
        // A list row's {{item}}, a pick's {{choice}}, a popup's {{value}} are
        // the part's own tokens, not variables.
        if (!SCOPE_TOKEN.test(m[1]!)) reads.add(m[1]!);
      }
      return;
    }
    if (Array.isArray(node)) { for (const item of node) visit(item); return; }
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (typeof obj.variableId === "string" && obj.variableId) {
      if (obj.kind === "set-variable" || obj.kind === "random") writes.add(obj.variableId);
      else if (obj.kind === "variable") reads.add(obj.variableId);
      // A `visibleWhen` condition reads its variable too — except the built-in
      // "has the chat started", which is not a variable at all.
      else if (typeof obj.operator === "string" && obj.variableId !== UI_CHAT_STARTED) reads.add(obj.variableId);
    }
    if (typeof obj.operator === "string" && typeof obj.valueRef === "string" && obj.valueRef) reads.add(obj.valueRef);
    // The parts that bind a variable by element rather than by source: a
    // choice and a field write what the player picks or types (and read it
    // back to show it), a popup watches its variable and clears it on close.
    if ((obj.type === "choice" || obj.type === "field" || obj.type === "popup") && typeof obj.variableId === "string" && obj.variableId) {
      reads.add(obj.variableId);
      if (obj.type !== "popup" || obj.clearOnClose !== false) writes.add(obj.variableId);
    }
    // A button's 「这些填好了才能按」 and a card list's lock both read.
    if (obj.type === "button" && Array.isArray(obj.requires)) {
      for (const id of obj.requires) if (typeof id === "string" && id) reads.add(id);
    }
    const lock = obj.lockedUnless as { variableId?: unknown } | undefined;
    if (lock && typeof lock === "object" && typeof lock.variableId === "string" && lock.variableId) reads.add(lock.variableId);
    for (const value of Object.values(obj)) visit(value);
  };
  visit(doc);
  return { reads: [...reads], writes: [...writes] };
}

/** The variables one page uses, read or written, in the order they first
 *  appear on it: what a creator swaps for their own after adding a ready-made
 *  page that came with its own. */
export function pageVariableRefs(doc: UiDoc, pageId: string): string[] {
  const page = (doc.pages ?? []).find((p) => p.id === pageId);
  if (!page) return [];
  const { reads, writes } = uiDocVariableRefs({ ...doc, pages: [page] });
  // {{inventory.weapons}} is a use of `inventory`.
  return [...new Set([...reads, ...writes].map((id) => id.split(".")[0]!))];
}

/** The behaviours one page's buttons set off (`run-behavior` steps), by the
 *  action id each sends, in the order they first appear. */
export function pageBehaviorRefs(doc: UiDoc, pageId: string): string[] {
  const page = (doc.pages ?? []).find((p) => p.id === pageId);
  if (!page) return [];
  const ids: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { for (const item of node) visit(item); return; }
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (obj.kind === "run-behavior" && typeof obj.actionId === "string" && obj.actionId && !ids.includes(obj.actionId)) ids.push(obj.actionId);
    for (const value of Object.values(obj)) visit(value);
  };
  visit(page);
  return ids;
}

/**
 * Every use of variable `from` in a piece of a UI doc, pointed at `to`: value
 * sources, conditions and their compared value, button steps, the parts that
 * bind by element, the fields a button waits for, and `{{from}}` or
 * `{{from.path}}` in any text.
 */
export function remapUiVariable<T>(node: T, from: string, to: string): T {
  if (!from || from === to) return node;
  const name = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const macro = new RegExp(`\\{\\{(\\s*)${name}(?=\\s*\\}\\}|\\.)`, "g");
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return value.includes("{{") ? value.replace(macro, (_m, space: string) => `{{${space}${to}`) : value;
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== "object") return value;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if ((key === "variableId" || key === "valueRef" || key === "variableDisplay") && v === from) out[key] = to;
      else if (key === "requires" && Array.isArray(v)) out[key] = v.map((id) => (id === from ? to : id));
      else out[key] = walk(v);
    }
    return out;
  };
  return walk(node) as T;
}

/** One page's uses of `from`, all moved to `to` at once. */
export function remapPageVariable(doc: UiDoc, pageId: string, from: string, to: string): UiDoc {
  if (!from || from === to) return doc;
  return { ...doc, pages: (doc.pages ?? []).map((p) => (p.id === pageId ? remapUiVariable(p, from, to) : p)) };
}

/** Every page's uses of `from`, moved to `to`: a ready-made interface uses
 *  its variables on more than one page (the status bar and its details). */
export function remapDocVariable(doc: UiDoc, from: string, to: string): UiDoc {
  if (!from || from === to) return doc;
  return { ...doc, pages: (doc.pages ?? []).map((p) => remapUiVariable(p, from, to)) };
}
