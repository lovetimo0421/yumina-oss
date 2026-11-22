import type { WorldDefinition } from "../types/index.js";

/**
 * Names for the text fields of a card that people type into together — an
 * entry's content, a variable's description, a frontend file, the card's
 * description — so the editor, the live text relay and the server's own
 * writers all mean the same field by the same key. Pure.
 *
 *   r:<collection>:<row id>:<field>   a field of a row ("r:entries:abc:content")
 *   f:<file name>                     a file of the frontend (rootComponent.files)
 *   t:<field>                         a top-level text field ("t:description")
 *
 * Ids and file names are URI-encoded, so a ':' or '/' in one can't be misread.
 */
export type TextFieldRef =
  | { kind: "row"; key: string; id: string; field: string }
  | { kind: "file"; name: string }
  | { kind: "top"; field: string };

const MAX_KEY_LENGTH = 400;
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export function textFieldKey(ref: TextFieldRef): string {
  switch (ref.kind) {
    case "row": return `r:${ref.key}:${encodeURIComponent(ref.id)}:${ref.field}`;
    case "file": return `f:${encodeURIComponent(ref.name)}`;
    case "top": return `t:${ref.field}`;
  }
}

/** The field a key names, or null for anything malformed. */
export function parseTextFieldKey(key: unknown): TextFieldRef | null {
  if (typeof key !== "string" || key.length > MAX_KEY_LENGTH) return null;
  try {
    if (key.startsWith("r:")) {
      const parts = key.slice(2).split(":");
      if (parts.length !== 3) return null;
      const [collection, id, field] = parts as [string, string, string];
      const decoded = decodeURIComponent(id);
      if (!SAFE_NAME.test(collection) || !SAFE_NAME.test(field) || !decoded || field === "id") return null;
      return { kind: "row", key: collection, id: decoded, field };
    }
    if (key.startsWith("f:")) {
      const name = decodeURIComponent(key.slice(2));
      return name ? { kind: "file", name } : null;
    }
    if (key.startsWith("t:")) {
      const field = key.slice(2);
      return SAFE_NAME.test(field) ? { kind: "top", field } : null;
    }
  } catch {
    return null;
  }
  return null;
}

type Json = Record<string, unknown>;
const UNSAFE = new Set(["__proto__", "constructor", "prototype"]);

/** The field's text in `world`; "" for a field not written yet, undefined
 *  when what holds it (the row, the file) doesn't exist. */
export function readTextField(world: WorldDefinition | Record<string, unknown> | null | undefined, key: string): string | undefined {
  const ref = parseTextFieldKey(key);
  if (!ref || !world) return undefined;
  const w = world as Json;
  switch (ref.kind) {
    case "row": {
      if (UNSAFE.has(ref.key)) return undefined;
      const rows = w[ref.key];
      if (!Array.isArray(rows)) return undefined;
      const row = (rows as Json[]).find((r) => r?.id === ref.id);
      if (!row) return undefined;
      const value = row[ref.field];
      return typeof value === "string" ? value : value === undefined || value === null ? "" : undefined;
    }
    case "file": {
      const files = (w.rootComponent as Json | undefined)?.files as Record<string, unknown> | undefined;
      if (!files || !Object.prototype.hasOwnProperty.call(files, ref.name)) return undefined;
      const value = files[ref.name];
      return typeof value === "string" ? value : undefined;
    }
    case "top": {
      if (UNSAFE.has(ref.field)) return undefined;
      const value = w[ref.field];
      return typeof value === "string" ? value : value === undefined || value === null ? "" : undefined;
    }
  }
}

/** `world` with the field set to `value`; `world` itself when there is no
 *  such field to set (its row or file is gone) or nothing changes. */
export function writeTextField<W extends WorldDefinition | Record<string, unknown>>(world: W, key: string, value: string): W {
  const ref = parseTextFieldKey(key);
  if (!ref) return world;
  const w = world as Json;
  if (readTextField(world, key) === undefined || readTextField(world, key) === value) return world;
  switch (ref.kind) {
    case "row":
      return { ...w, [ref.key]: (w[ref.key] as Json[]).map((r) => (r?.id === ref.id ? { ...r, [ref.field]: value } : r)) } as W;
    case "file": {
      const root = w.rootComponent as Json;
      return { ...w, rootComponent: { ...root, files: { ...(root.files as Json), [ref.name]: value } } } as W;
    }
    case "top":
      return { ...w, [ref.field]: value } as W;
  }
}
