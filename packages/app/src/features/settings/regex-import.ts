import { REGEX_RULES_MAX, parseSillyTavernRegex, type RegexRule } from "@yumina/shared";
import { readZipTexts } from "@/lib/zip-texts";

/** A nested quantifier such as (a+)+ can take exponential time in the player's own browser. Refuse it here;
 *  the server runs rules under a time limit regardless. */
export function looksRunaway(pattern: string): boolean {
  return /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)(?:[+*]|\{\d*,\d*\})/.test(pattern);
}

type ImportFile = Pick<File, "name" | "type" | "text" | "arrayBuffer">;

/**
 * The rules in any number of files a player picked: SillyTavern regex exports (.json, one rule or a list) and
 * .zip folders of them. Each rule comes once (not by an id or the same find/replace/flags already in `existing`
 * or earlier in the files), runaway patterns are left out, and only as many as fit under the cap are added.
 * `skipped` counts what didn't come in (unreadable files, scripts the parser passed over, repeats, no room);
 * `failed` is true when nothing could be read at all.
 */
export async function importRegexFiles(files: ImportFile[], existing: RegexRule[]): Promise<{ added: RegexRule[]; skipped: number; failed: boolean }> {
  const texts: string[] = [];
  let unreadable = 0;
  for (const file of files) {
    try {
      if (/\.zip$/i.test(file.name) || file.type.includes("zip")) {
        const inside = await readZipTexts(await file.arrayBuffer(), (name) => /\.json$/i.test(name) && !/(^|\/)__MACOSX\//.test(name));
        if (!inside.length) unreadable++;
        texts.push(...inside.map((f) => f.text));
      } else texts.push(await file.text());
    } catch { unreadable++; }
  }
  const found: RegexRule[] = [];
  let skipped = unreadable;
  for (const text of texts) {
    try {
      const got = parseSillyTavernRegex(JSON.parse(text));
      found.push(...got.rules);
      skipped += got.skipped.length;
    } catch { skipped++; }
  }
  if (!found.length) return { added: [], skipped, failed: skipped > 0 };
  const sameAs = (r: RegexRule) => JSON.stringify([r.find, r.replace, r.flags ?? "", r.isRegex]);
  const ids = new Set(existing.map((r) => r.id)), same = new Set(existing.map(sameAs));
  const fresh = found.filter((r) => {
    if (ids.has(r.id) || same.has(sameAs(r)) || looksRunaway(r.find)) return false;
    ids.add(r.id); same.add(sameAs(r));
    return true;
  });
  const added = fresh.slice(0, Math.max(0, REGEX_RULES_MAX - existing.length));
  return { added, skipped: skipped + (found.length - added.length), failed: false };
}
