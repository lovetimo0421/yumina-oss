import { normalizeWorldLanguage } from "./world-language.js";

/** The subset of a `worlds` row needed to rank language variants. */
export interface VariantRow {
  id: string;
  language: string | null;
  languageGroupId: string | null;
  isPrimaryVariant?: boolean | null;
  createdAt?: Date | string | null;
}

function time(value: Date | string | null | undefined): number {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t;
}

/**
 * Which variant of a PINNED world id should a viewer actually see?
 *
 * A community thread cites one concrete world id — whichever variant the author
 * happened to be playing, in practice almost always the Chinese one. Rendering
 * that id verbatim puts a Chinese card name, cover and description in front of
 * an English reader, and the embed's Play link takes them to the Chinese card
 * even when a published English sibling exists.
 *
 * This is the same shape as the featured-slot resolution in routes/worlds.ts:
 * swap to the viewer's REAL sibling row rather than painting that sibling's
 * fields onto the pinned id, so the embed and the card page it links to stay on
 * one variant. (`resolveVariantFields` does the paint-the-fields variant, which
 * is right for hub lists keyed on their own row and wrong here.)
 *
 * `candidates` must already be filtered to rows the viewer may see — published
 * and visible. Anything not eligible must not reach this function; it does not
 * re-check status.
 *
 * Falls back to the cited id whenever there is nothing better: no viewer
 * language, a standalone card, the cited row is already in the viewer's
 * language, or the group has no published sibling for that language. "尽量不串
 * 语言" — never a worse match than what the author cited.
 */
export function pickViewerVariantId(
  cited: VariantRow,
  candidates: VariantRow[],
  preferredLang: string | null | undefined,
): string {
  if (!preferredLang || !cited.languageGroupId) return cited.id;
  const want = normalizeWorldLanguage(preferredLang);
  if (!want) return cited.id;
  if (normalizeWorldLanguage(cited.language) === want) return cited.id;

  const ranked = candidates
    .filter((c) => c.languageGroupId === cited.languageGroupId && normalizeWorldLanguage(c.language) === want)
    .sort((a, b) => {
      // Exact code ("en") before a regional form ("en-US") — a card tagged with
      // the bare code is the canonical row for that language.
      const exact = Number(b.language === preferredLang) - Number(a.language === preferredLang);
      if (exact !== 0) return exact;
      // Then the 主 (primary) variant, which is what the hub itself surfaces.
      const primary = Number(!!b.isPrimaryVariant) - Number(!!a.isPrimaryVariant);
      if (primary !== 0) return primary;
      const created = time(a.createdAt) - time(b.createdAt);
      if (created !== 0) return created;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  return ranked[0]?.id ?? cited.id;
}

/** Batch form: cited rows → Map(citedId → id the viewer should be shown). */
export function pickViewerVariantIds(
  cited: VariantRow[],
  candidates: VariantRow[],
  preferredLang: string | null | undefined,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of cited) out.set(row.id, pickViewerVariantId(row, candidates, preferredLang));
  return out;
}
