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
