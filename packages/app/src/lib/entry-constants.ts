import type { WorldEntry } from "@yumina/engine";

export const API_ROLES: { value: NonNullable<WorldEntry["apiRole"]>; label: string; hint: string }[] = [
  { value: "system", label: "System", hint: "Instructions for the AI. Most entries use this." },
  { value: "user", label: "User", hint: "Appears as a human message. For few-shot examples." },
  { value: "assistant", label: "Assistant", hint: "Appears as AI's own words. For prefill & CoT bypass." },
];

export function getSendAsOptions(t: (key: any) => string) {
  return [
    { value: "system" as const, label: t("entries.sendAsOptions.system"), hint: t("entries.sendAsOptions.systemHint") },
    { value: "user" as const, label: t("entries.sendAsOptions.user"), hint: t("entries.sendAsOptions.userHint") },
    { value: "assistant" as const, label: t("entries.sendAsOptions.assistant"), hint: t("entries.sendAsOptions.assistantHint") },
  ];
}

export const TAG_LABELS: Record<string, string> = {
  system: "System",
  character: "Character",
  scenario: "Scenario",
  plot: "Plot",
  style: "Style",
  example: "Example",
  greeting: "First Message",
  custom: "Custom",
};

export const SECONDARY_LOGIC_OPTIONS: { value: NonNullable<WorldEntry["secondaryKeywordLogic"]>; label: string; hint: string }[] = [
  { value: "AND_ANY", label: "AND ANY", hint: "Primary matches AND any secondary matches" },
  { value: "AND_ALL", label: "AND ALL", hint: "Primary matches AND all secondaries match" },
  { value: "NOT_ANY", label: "NOT ANY", hint: "Primary matches AND no secondaries match" },
  { value: "NOT_ALL", label: "NOT ALL", hint: "Primary matches AND not all secondaries match" },
];

export const ROLES: { value: WorldEntry["role"]; label: string }[] = [
  { value: "system", label: "System" },
  { value: "character", label: "Character" },
  { value: "scenario", label: "Scenario" },
  { value: "plot", label: "Plot" },
  { value: "style", label: "Style" },
  { value: "example", label: "Example" },
  { value: "greeting", label: "Greeting" },
  { value: "custom", label: "Custom" },
];


export const ROLE_FILTER_TABS = [
  { value: "all" as const, label: "All" },
  ...ROLES,
];

export const ROLE_COLORS: Record<string, string> = {
  system: "text-blue-400",
  character: "text-emerald-400",
  scenario: "text-amber-400",
  plot: "text-rose-400",
  style: "text-pink-400",
  example: "text-cyan-400",
  greeting: "text-yellow-400",
  custom: "text-muted-foreground",
};

/** Default tag names available in every world.
 *  These English strings are the canonical storage IDs — never change them.
 *  For display in other locales use {@link getTagLabel}. */
export const DEFAULT_TAGS = ["Characters", "Plot", "Style", "Example", "Preset"];

/** Resolve a tag's display label. Default tags route through i18n; custom and
 *  orphan tags are shown verbatim (creators name those themselves). */
export function getTagLabel(
  tag: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: (key: any) => string
): string {
  if (DEFAULT_TAGS.includes(tag)) {
    const localized = t(`entries.defaultTagLabels.${tag}`);
    // i18next returns the key string when missing — fall back to raw tag.
    if (localized && localized !== `entries.defaultTagLabels.${tag}`) {
      return localized;
    }
  }
  return tag;
}

/** Tailwind text colors for tag pills (built-in tags only) */
export const TAG_COLORS: Record<string, string> = {
  Characters: "text-emerald-400",
  Plot: "text-rose-400",
  Style: "text-pink-400",
  // Legacy tag colors (old entries may still have these)
  System: "text-blue-400",
  Character: "text-emerald-400",
  Scenario: "text-amber-400",
  Example: "text-cyan-400",
  "First Message": "text-yellow-400",
  Custom: "text-muted-foreground",
  Preset: "text-indigo-400",
};

/** Color palette presented to creators in the Tag Manager. Each entry is a
 *  Tailwind text color class — used for tag pills throughout the editor. */
export const TAG_COLOR_PALETTE: { name: string; value: string }[] = [
  { name: "rose",    value: "text-rose-400" },
  { name: "amber",   value: "text-amber-400" },
  { name: "yellow",  value: "text-yellow-400" },
  { name: "emerald", value: "text-emerald-400" },
  { name: "cyan",    value: "text-cyan-400" },
  { name: "sky",     value: "text-sky-400" },
  { name: "indigo",  value: "text-indigo-400" },
  { name: "violet",  value: "text-violet-400" },
  { name: "fuchsia", value: "text-fuchsia-400" },
  { name: "pink",    value: "text-pink-400" },
];

/** Deterministic fallback color for an unstyled tag — based on tag-name hash
 *  so the same tag always renders the same color across reloads. */
function hashTagToColor(tag: string): string {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) {
    hash = (hash * 31 + tag.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % TAG_COLOR_PALETTE.length;
  return TAG_COLOR_PALETTE[idx]!.value;
}

/** Resolve the display color for a tag.
 *  Order: built-in TAG_COLORS → world's customTagColors → deterministic hash. */
export function getTagColor(
  tag: string,
  customColors?: Record<string, string>
): string {
  if (TAG_COLORS[tag]) return TAG_COLORS[tag]!;
  if (customColors?.[tag]) return customColors[tag]!;
  return hashTagToColor(tag);
}

/** Per-bundle color palette for distinguishing imported bundle content (entries,
 *  UI files) in the editor. Each entry uses literal Tailwind class strings so the
 *  Tailwind 4 scanner emits the border/background utilities (a runtime-built
 *  `border-l-${x}` would never be generated). The assigned key is stored on each
 *  InstalledBundle so colors are stable across reloads.
 *
 *  Indigo is intentionally excluded — it's reserved for official preset entries. */
export const BUNDLE_COLOR_PALETTE = [
  { key: "rose",    dot: "bg-rose-400",    border: "border-l-rose-400",    text: "text-rose-400",    soft: "bg-rose-400/10" },
  { key: "amber",   dot: "bg-amber-400",   border: "border-l-amber-400",   text: "text-amber-400",   soft: "bg-amber-400/10" },
  { key: "emerald", dot: "bg-emerald-400", border: "border-l-emerald-400", text: "text-emerald-400", soft: "bg-emerald-400/10" },
  { key: "cyan",    dot: "bg-cyan-400",    border: "border-l-cyan-400",    text: "text-cyan-400",    soft: "bg-cyan-400/10" },
  { key: "sky",     dot: "bg-sky-400",     border: "border-l-sky-400",     text: "text-sky-400",     soft: "bg-sky-400/10" },
  { key: "violet",  dot: "bg-violet-400",  border: "border-l-violet-400",  text: "text-violet-400",  soft: "bg-violet-400/10" },
  { key: "fuchsia", dot: "bg-fuchsia-400", border: "border-l-fuchsia-400", text: "text-fuchsia-400", soft: "bg-fuchsia-400/10" },
  { key: "pink",    dot: "bg-pink-400",    border: "border-l-pink-400",    text: "text-pink-400",    soft: "bg-pink-400/10" },
] as const;

export type BundleColor = (typeof BUNDLE_COLOR_PALETTE)[number];

/** Pick the next palette color for a world that already has `existingCount`
 *  installed bundles — cycles through the palette so adjacent imports differ. */
export function nextBundleColorKey(existingCount: number): string {
  return BUNDLE_COLOR_PALETTE[existingCount % BUNDLE_COLOR_PALETTE.length]!.key;
}

/** Resolve a bundle color by its stored key (falls back to the first color). */
export function getBundleColor(colorKey: string | undefined): BundleColor {
  return BUNDLE_COLOR_PALETTE.find((c) => c.key === colorKey) ?? BUNDLE_COLOR_PALETTE[0]!;
}

