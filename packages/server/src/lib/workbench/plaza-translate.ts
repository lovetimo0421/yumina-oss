import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { contentTranslations } from "../../db/schema.js";
import { detectLang } from "../detect-lang.js";
import { BACKFILLED_LANGS, isSupportedLang, translateContent, type SupportedLang } from "../translate.js";

/**
 * 广场 in the reader's language: what people share there (a work's title, a voice's name and description, a 做法's
 * title and description) is machine-translated the way community posts and comments are, into the same table.
 *
 * Nothing is translated when it is shared. The first reader in another language asks for it by opening the shelf:
 * the list answers with what is stored, and what is missing is started in the background for the next visit.
 */
export type PlazaSource = "plaza_work" | "plaza_voice" | "plaza_skill" | "plaza_comment";

/** ?ui=<UI language> (zh-Hant reads zh, converted on the page). Null: no translation wanted. */
export function plazaLang(raw: string | undefined): SupportedLang | null {
  const base = (raw ?? "").toLowerCase().split("-")[0];
  return isSupportedLang(base) ? base : null;
}

/**
 * The language a short title is written in, from its script. Spanish is told from English by its marks only;
 * Indonesian by its function words, which a title rarely has, so most Indonesian titles still read as English.
 */
export function guessLang(text: string): SupportedLang {
  if (/[぀-ヿ]/.test(text)) return "ja";
  if (/\p{Script=Hangul}/u.test(text)) return "ko";
  if (/[一-鿿]/.test(text)) return "zh";
  if (/\p{Script=Cyrillic}/u.test(text)) return "ru";
  if (/[¿¡ñáéíóúü]/i.test(text)) return "es";
  return detectLang(text) === "id" ? "id" : "en";
}

/**
 * Which languages a reader's visit starts. The four the shelf has always been translated into, plus the reader's
 * own: Korean, Indonesian and Russian are made only once someone reading in them opens the shelf, never for every
 * item at once.
 */
export function plazaTargets(uiLang: SupportedLang): SupportedLang[] {
  return (BACKFILLED_LANGS as readonly SupportedLang[]).includes(uiLang) ? [...BACKFILLED_LANGS] : [...BACKFILLED_LANGS, uiLang];
}

/**
 * The stored languages that can stand in for the reader's: their own, then for Korean, Indonesian and Russian the
 * English one until theirs is made (what they saw before those languages were added).
 */
export function plazaReadLangs(uiLang: SupportedLang): SupportedLang[] {
  return (BACKFILLED_LANGS as readonly SupportedLang[]).includes(uiLang) ? [uiLang] : [uiLang, "en"];
}

/** Asked for already by this process: a shelf opened ten times starts each translation once. */
const asked = new Set<string>();

export interface PlazaText { id: string; title: string; content: string; userId: string }

export async function plazaTranslations(type: PlazaSource, items: PlazaText[], uiLang: SupportedLang | null): Promise<Map<string, { title: string | null; content: string | null }>> {
  const out = new Map<string, { title: string | null; content: string | null }>();
  if (!uiLang || items.length === 0) return out;
  const foreign = items.filter((it) => (it.title || it.content).trim() && guessLang(`${it.title} ${it.content}`) !== uiLang);
  if (foreign.length === 0) return out;
  const rows = await db.select({ id: contentTranslations.sourceId, lang: contentTranslations.targetLang, title: contentTranslations.translatedTitle, content: contentTranslations.translatedContent })
    .from(contentTranslations)
    .where(and(eq(contentTranslations.sourceType, type), inArray(contentTranslations.targetLang, plazaReadLangs(uiLang)), inArray(contentTranslations.sourceId, foreign.map((it) => it.id))))
    .catch(() => []);
  // The reader's own language wins over the English stand-in, whichever row comes back first.
  const own = new Set<string>();
  for (const row of rows) {
    if (row.lang === uiLang) own.add(row.id);
    else if (out.has(row.id)) continue;
    out.set(row.id, { title: row.title || null, content: row.content || null });
  }
  const targets = plazaTargets(uiLang);
  for (const it of foreign) {
    const key = `${type}:${it.id}:${uiLang}`;
    if (own.has(it.id) || asked.has(key)) continue;
    asked.add(key);
    if (asked.size > 5000) asked.clear();
    void translateContent(it.id, type, guessLang(`${it.title} ${it.content}`), it.content, it.userId, it.title || undefined, targets).catch(() => {});
  }
  return out;
}
