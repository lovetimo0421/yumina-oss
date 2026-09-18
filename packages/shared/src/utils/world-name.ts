// Default / placeholder world (card) names.
//
// A card whose name is still one of these — the blank-save fallback
// ("Untitled World"), or an un-renamed starter-template name ("World
// Simulation", "Character Chat", …), with or without the app's " (2)" / " (3)"
// dedup suffix — is considered "unnamed". The publish flow refuses to push an
// unnamed card so the hub never fills with indistinguishable cards.
//
// NOTE: this is a publish-time GATE only. Name *generation* (the blank-save
// "Untitled World" fallback and the template " (n)" dedup) lives in the app
// exactly as on main — this helper just recognizes those outputs.
//
// Detection is name-based on purpose (rather than a stored "renamed" boolean):
// it is deterministic, can't be fooled by typing a name then reverting it to the
// default, needs no DB column / migration, and works for cards that already
// exist.

// Blank-card fallback names (the literal saveDraft writes, plus its localized
// equivalents). Listed longest-first so the alternation prefers the more
// specific base.
const BLANK_FALLBACK_NAMES = [
  "未命名世界",
  "untitled world",
] as const;

// Template default names. A card created from a starter template keeps the
// template's name until the creator renames it — so an un-renamed template card
// is just as much "unnamed" as a blank one, and must not be publishable.
//
// IMPORTANT: these mirror the top-level `chat.name` / `world.name` strings in
// packages/app/src/locales/<locale>/templates-content.json across EVERY shipped
// locale. The server can't read the app's i18n bundles, so they're duplicated
// here. When a template is added/renamed or a new locale ships, update this list.
const TEMPLATE_DEFAULT_NAMES = [
  // en
  "Character Chat",
  "World Simulation",
  // zh
  "角色聊天",
  "世界模拟",
  // es
  "Chat de personaje",
  "Simulación de mundo",
  // ja
  "キャラクターチャット",
  "ワールドシミュレーション",
] as const;

/** Every recognized default base (blank fallbacks + template names), lower-cased. */
export const DEFAULT_WORLD_NAME_BASES = [
  ...BLANK_FALLBACK_NAMES,
  ...TEMPLATE_DEFAULT_NAMES,
].map((b) => b.toLowerCase());

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Optional trailing dedup suffix the app appends to keep defaults distinct:
//   template dedup (loadTemplate) → "World Simulation (2)"   (parenthesized)
// Also tolerate a bare " 2" form for safety against any hand-edited variants.
const SUFFIX = "(?:\\s*\\(\\d+\\)|[\\s_-]*\\d+)?";

/**
 * Matches a blank fallback OR a template default name, optionally followed by a
 * dedup suffix — e.g. "Untitled World", "World Simulation", "角色聊天 (3)".
 */
const DEFAULT_NAME_PATTERN = new RegExp(
  `^(?:${[...BLANK_FALLBACK_NAMES, ...TEMPLATE_DEFAULT_NAMES]
    .map(escapeRe)
    .join("|")})${SUFFIX}$`,
  "i",
);

/**
 * True when `name` is empty/whitespace, the blank-save fallback
 * ("Untitled World"), OR an un-renamed template name ("World Simulation",
 * "角色聊天", …) — with or without a trailing dedup suffix.
 *
 * This is the publish gate: a card matching this can't be published.
 */
export function isDefaultWorldName(name: string | null | undefined): boolean {
  const trimmed = (name ?? "").trim();
  if (trimmed === "") return true;
  return DEFAULT_NAME_PATTERN.test(trimmed);
}
