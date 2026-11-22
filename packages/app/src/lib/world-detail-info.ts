/**
 * One description of "what a card's details page says", shared by the two
 * places a player reads it: the Discover preview and the Library detail.
 *
 * Both fill themselves from the same single-world preview response
 * (`GET /api/worlds/:id?preview=true`). The Library's own list rows are lighter
 * (no gallery, no counters, and a saved-but-not-loaded card has only what
 * `/api/library` carries), so `withWorldDetail` lays the preview's fields over
 * whatever the list left empty. `worldDetailFacts` is the one list of card
 * facts (size, play length, creation date) both views print.
 */

/** Fields of the preview response that describe the card itself. */
export interface WorldPreviewDetail {
  announcement?: string | null;
  totalTokens?: number | null;
  approxTime?: string | null;
  galleryImages?: unknown;
  createdAt?: string | null;
  sourceWorldId?: string | null;
  sourceWorldName?: string | null;
  sourceCreatorId?: string | null;
  sourceCreatorName?: string | null;
}

interface WorldDetailFields {
  announcement: string | null;
  totalTokens: number | null;
  approxTime: string | null;
  galleryImages: string[] | null;
  sourceWorldId: string | null;
  sourceWorldName?: string | null;
  sourceCreatorId?: string | null;
  sourceCreatorName?: string | null;
}

/** Only real image addresses; the column is unvalidated jsonb. */
export function galleryImageList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.length > 0) : [];
}

const isBlank = (value: unknown) => value === null || value === undefined || value === "";

/**
 * Fill the fields a library row left empty from the preview response. Fields
 * the row already has win: they are the same card, and the row may be fresher
 * after an edit. The fork credit is copied as one unit and only when the server
 * named the source (it leaves the name empty for the author's own translation).
 */
export function withWorldDetail<T extends WorldDetailFields>(item: T, detail: WorldPreviewDetail | null | undefined): T {
  if (!detail) return item;
  const next: T = { ...item };
  if (isBlank(next.announcement) && typeof detail.announcement === "string" && detail.announcement) {
    next.announcement = detail.announcement;
  }
  if (isBlank(next.totalTokens) && typeof detail.totalTokens === "number" && Number.isFinite(detail.totalTokens)) {
    next.totalTokens = detail.totalTokens;
  }
  if (isBlank(next.approxTime) && typeof detail.approxTime === "string" && detail.approxTime.trim()) {
    next.approxTime = detail.approxTime;
  }
  if (galleryImageList(next.galleryImages).length === 0) {
    const images = galleryImageList(detail.galleryImages);
    if (images.length > 0) next.galleryImages = images;
  }
  if (!next.sourceWorldId && detail.sourceWorldId && detail.sourceWorldName) {
    next.sourceWorldId = detail.sourceWorldId;
    next.sourceWorldName = detail.sourceWorldName;
    next.sourceCreatorId = detail.sourceCreatorId ?? null;
    next.sourceCreatorName = detail.sourceCreatorName ?? null;
  }
  return next;
}

export type WorldFactKey = "tokens" | "estTime" | "created";

export interface WorldFact {
  key: WorldFactKey;
  /** Key in the `library` namespace (`detail.tokens` …), shared by both views. */
  labelKey: `detail.${WorldFactKey}`;
  value: string;
}

/** "~12,345" — the approximate prompt size the card costs per turn. */
export function formatTokenCount(tokens: number | null | undefined, locale?: string): string {
  return typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0
    ? `~${Math.round(tokens).toLocaleString(locale)}`
    : "—";
}

export function formatCreatedDate(value: string | null | undefined, locale?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString(locale);
}

/**
 * The card facts both detail views print, in display order. A fact the card
 * does not have (no token count yet, no play-length note) is left out rather
 * than shown as a blank.
 */
export function worldDetailFacts(
  world: { totalTokens?: number | null; approxTime?: string | null; createdAt?: string | null },
  locale?: string,
): WorldFact[] {
  const facts: WorldFact[] = [];
  const created = formatCreatedDate(world.createdAt, locale);
  if (created) facts.push({ key: "created", labelKey: "detail.created", value: created });
  if (typeof world.totalTokens === "number" && world.totalTokens > 0) {
    facts.push({ key: "tokens", labelKey: "detail.tokens", value: formatTokenCount(world.totalTokens, locale) });
  }
  const approxTime = world.approxTime?.trim();
  if (approxTime) facts.push({ key: "estTime", labelKey: "detail.estTime", value: approxTime });
  return facts;
}
