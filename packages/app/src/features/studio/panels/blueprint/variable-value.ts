import type { Variable } from '@yumina/engine';

export function parseVariableValue(type: Variable['type'], raw: string):
  { ok: true; value: Variable['defaultValue'] } | { ok: false; error: 'number' | 'boolean' | 'json' } {
  if (type === 'string') return { ok: true, value: raw };
  if (type === 'number') {
    const value = Number(raw);
    return raw.trim() && Number.isFinite(value) ? { ok: true, value } : { ok: false, error: 'number' };
  }
  if (type === 'boolean') {
    return raw === 'true' || raw === 'false' ? { ok: true, value: raw === 'true' } : { ok: false, error: 'boolean' };
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (value !== null && typeof value === 'object') return { ok: true, value: value as Variable['defaultValue'] };
  } catch { /* Keep the invalid draft visible to its author. */ }
  return { ok: false, error: 'json' };
}

/** Parse the inspector's free-text value as the wire's variable stores it.
 *  Conditions compare strictly, so a text variable's "1" must stay "1": read
 *  as the number 1 it never equals the variable again and the wire goes dead. */
export function parseEditedValue(raw: string, type?: Variable["type"]): unknown {
  const t = raw.trim();
  if (type === "string") return raw;
  if (type === "number") return t !== "" && Number.isFinite(Number(t)) ? Number(t) : raw;
  if (type === "boolean") return t === "true" ? true : t === "false" ? false : raw;
  if (t === "") return "";
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  try { return JSON.parse(t); } catch { return t; }
}
