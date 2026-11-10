/**
 * The update log (更新日志): one markdown file per entry in `changelog/` at
 * the repo root, read by the server and served at GET /api/changelog. These
 * are the shared words both sides agree on: the languages an entry may be
 * written in, the fixed list of areas (stable slug + a label per UI
 * language), and the shape the API answers with.
 */

/** Languages an entry may carry, in the order a missing one falls back through. */
export const CHANGELOG_LANGS = ["zh", "en", "zh-Hant", "es", "ja"] as const;
export type ChangelogLang = (typeof CHANGELOG_LANGS)[number];

/** The two an author must write by hand; the other three are generated. */
export const CHANGELOG_REQUIRED_LANGS = ["zh", "en"] as const satisfies readonly ChangelogLang[];

/** "unrestricted" = shown only to accounts eligible for 解除限制 (adult, birth year on file,
 *  mature content level) and to admins; never to logged-out visitors. */
export type ChangelogAudience = "public" | "internal" | "unrestricted";
/** "roundup" = many small improvements and fixes, shown compact and collapsed. */
export type ChangelogKind = "standard" | "roundup";

/**
 * The fixed area vocabulary. Files name an area by its slug (`chat`) or its
 * Simplified Chinese label (`聊天`); anything else fails validation. Add an
 * area here, with all five labels, before an entry uses it.
 */
export const CHANGELOG_AREAS = [
  { slug: "chat", labels: { zh: "聊天", "zh-Hant": "聊天", en: "Chat", es: "Chat", ja: "チャット" } },
  { slug: "discover", labels: { zh: "发现", "zh-Hant": "發現", en: "Discover", es: "Descubrir", ja: "発見" } },
  { slug: "image", labels: { zh: "生图", "zh-Hant": "生圖", en: "Image generation", es: "Generación de imágenes", ja: "画像生成" } },
  { slug: "creator", labels: { zh: "创作者", "zh-Hant": "創作者", en: "Creators", es: "Creadores", ja: "クリエイター" } },
  { slug: "community", labels: { zh: "社区", "zh-Hant": "社羣", en: "Community", es: "Comunidad", ja: "コミュニティ" } },
  { slug: "account", labels: { zh: "账号与付费", "zh-Hant": "帳號與付費", en: "Account & billing", es: "Cuenta y pagos", ja: "アカウントと支払い" } },
  { slug: "performance", labels: { zh: "性能与稳定性", "zh-Hant": "效能與穩定性", en: "Performance & stability", es: "Rendimiento y estabilidad", ja: "パフォーマンスと安定性" } },
  { slug: "other", labels: { zh: "其他", "zh-Hant": "其他", en: "Other", es: "Otros", ja: "その他" } },
] as const satisfies ReadonlyArray<{ slug: string; labels: Record<ChangelogLang, string> }>;

export type ChangelogArea = (typeof CHANGELOG_AREAS)[number]["slug"];

/** A slug or a Simplified Chinese label → the slug, or null when unknown. */
export function changelogAreaSlug(value: string): ChangelogArea | null {
  const needle = value.trim();
  for (const area of CHANGELOG_AREAS) {
    if (area.slug === needle.toLowerCase() || area.labels.zh === needle) return area.slug;
  }
  return null;
}

/** Any UI language → the closest entry language (zh-TW/zh-HK → zh-Hant, unknown → en). */
export function clampChangelogLang(value: string | null | undefined): ChangelogLang {
  const raw = String(value ?? "").trim();
  if (!raw) return "en";
  if (/^zh[-_](hant|tw|hk|mo)/i.test(raw)) return "zh-Hant";
  const base = raw.toLowerCase().split(/[-_]/)[0];
  if (base === "zh") return "zh";
  if (base === "es") return "es";
  if (base === "ja") return "ja";
  return "en";
}

export function changelogAreaLabel(slug: string, lang: string): string {
  const area = CHANGELOG_AREAS.find((a) => a.slug === slug);
  return area ? area.labels[clampChangelogLang(lang)] : slug;
}

/** One entry as GET /api/changelog returns it, already in the reader's language. */
export interface ChangelogEntryView {
  /** The file name without `.md` (`2026-10-11-update-log`); also the page anchor. */
  id: string;
  date: string;
  audience: ChangelogAudience;
  areas: ChangelogArea[];
  /** The language the title and body below are actually in, after fallback. */
  lang: ChangelogLang;
  title: string;
  /** Rendered from the entry's markdown on the server; raw HTML in the source is escaped. */
  html: string;
  /** A slightly larger title, and announced once on Discover. */
  highlight: boolean;
  kind: ChangelogKind;
  /** Admins only: where the entry comes from and whether it is hidden. */
  admin?: ChangelogAdminMeta;
}

export interface ChangelogAdminMeta {
  /** A changelog/ file with this id exists in the repo. */
  hasFile: boolean;
  /** The shown content was written on the web (an edited file entry, or a web-only entry). */
  fromWeb: boolean;
  hidden: boolean;
  /** Pass back when saving, to catch a concurrent edit; null for an untouched file entry. */
  revision: string | null;
}

/** One entry with every language, as the admin editor loads and saves it. */
export interface ChangelogEditable extends ChangelogAdminMeta {
  id: string;
  date: string;
  audience: ChangelogAudience;
  areas: ChangelogArea[];
  title: Record<ChangelogLang, string>;
  body: Record<ChangelogLang, string>;
  highlight: boolean;
  kind: ChangelogKind;
}

/** GET /api/changelog/latest — the newest public entry and the newest public highlight, for the "new" dot and the Discover banner. */
export interface ChangelogLatestResponse {
  latest: { id: string; date: string } | null;
  highlight: { id: string; date: string; title: string } | null;
}

export interface ChangelogRevisionView {
  id: string;
  action: "create" | "edit" | "hide" | "unhide" | "restore" | "delete";
  createdAt: string;
  by: { id: string | null; name: string | null };
  snapshot: {
    date?: string;
    audience?: ChangelogAudience;
    areas?: ChangelogArea[];
    title?: Partial<Record<ChangelogLang, string>>;
    highlight?: boolean;
    kind?: ChangelogKind;
    hidden?: boolean;
    source?: string;
  };
}

export interface ChangelogResponse {
  entries: ChangelogEntryView[];
  /** True only for an admin, whose list also carries internal entries. */
  includesInternal: boolean;
}
