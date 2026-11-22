/**
 * The words someone typed that never reached the server, as plain text they
 * can copy: every text field of the open card that differs from the last
 * saved copy, labelled by where it sits. Used when they are removed from a
 * card mid-sentence, so the sentence isn't simply gone.
 */
type Json = unknown;

const MAX_DEPTH = 6;

function isRecord(value: Json): value is Record<string, Json> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function labelOf(item: Record<string, Json>, fallback: string): string {
  const name = item.name ?? item.title ?? item.label ?? item.id;
  return typeof name === "string" && name.trim() ? name.trim() : fallback;
}

function collect(base: Json, next: Json, path: string, out: string[], depth: number): void {
  if (depth > MAX_DEPTH || next === base) return;
  if (typeof next === "string") {
    if (next.trim() && next !== base && !next.startsWith("data:")) out.push(`【${path}】\n${next}`);
    return;
  }
  if (Array.isArray(next)) {
    const baseItems = Array.isArray(base) ? base : [];
    const byId = new Map<string, Json>();
    for (const item of baseItems) if (isRecord(item) && typeof item.id === "string") byId.set(item.id, item);
    next.forEach((item, i) => {
      if (isRecord(item) && typeof item.id === "string") {
        collect(byId.get(item.id), item, `${path} · ${labelOf(item, String(i + 1))}`, out, depth + 1);
      } else {
        collect(baseItems[i], item, `${path} · ${i + 1}`, out, depth + 1);
      }
    });
    return;
  }
  if (isRecord(next)) {
    const baseRecord = isRecord(base) ? base : {};
    for (const [key, value] of Object.entries(next)) {
      // Ids, code bundles and images aren't something anyone typed.
      if (key === "id" || key === "compiled" || key === "compiledCode" || key.startsWith("_")) continue;
      collect(baseRecord[key], value, path ? `${path} · ${key}` : key, out, depth + 1);
    }
  }
}

export function unsavedText(base: Json, draft: Json): string {
  const out: string[] = [];
  collect(base, draft, "", out, 0);
  return out.join("\n\n");
}
