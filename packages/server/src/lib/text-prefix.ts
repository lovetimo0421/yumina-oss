/**
 * The first `max` UTF-16 units of `text`, never ending on half of a surrogate
 * pair. A plain `slice` can keep the high half of an emoji; JSON.stringify then
 * writes it as a lone `\ud83d`, and Postgres rejects the whole jsonb value with
 * "invalid input syntax for type json" — which failed every play turn whose
 * audited map variable had an emoji straddling the cut (prod 2026-10-15).
 */
export function textPrefix(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = Math.max(0, max);
  const last = text.charCodeAt(end - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end);
}
