/**
 * Converts a SillyTavern character card (V2/V3) or standalone worldbook
 * into a Yumina WorldDefinition.
 *
 * Only transports the core content — entries, lorebook, metadata.
 * Regex scripts, talkativeness, probability, etc. are skipped.
 */

import { makeDefaultRootComponent, type WorldDefinition, type WorldEntry } from "@yumina/engine";

/* -------------------------------------------------------------------------- */
/*  SillyTavern type shapes (loose — we only access what we need)             */
/* -------------------------------------------------------------------------- */

interface STDepthPrompt {
  prompt?: string;
  depth?: number;
  role?: string;
}

interface STLorebookEntryV2 {
  /** V2 optional / V3 entry title. */
  name?: string;
  keys?: string[];
  secondary_keys?: string[];
  comment?: string;
  content?: string;
  constant?: boolean;
  selective?: boolean;
  enabled?: boolean;
  position?: string | number;
  insertion_order?: number;
  use_regex?: boolean;
  extensions?: {
    position?: number;
    depth?: number;
    role?: number;
    selectiveLogic?: number;
    match_whole_words?: boolean | null;
    prevent_recursion?: boolean;
    exclude_recursion?: boolean;
    [key: string]: unknown;
  };
}

interface STWorldbookEntry {
  uid?: number;
  key?: string[];
  keysecondary?: string[];
  comment?: string;
  content?: string;
  constant?: boolean;
  selective?: boolean;
  disable?: boolean;
  position?: number;
  order?: number;
  depth?: number;
  role?: number | null;
  selectiveLogic?: number;
  matchWholeWords?: boolean | null;
  preventRecursion?: boolean;
  excludeRecursion?: boolean;
  [key: string]: unknown;
}

interface STCharacterCard {
  name?: string;
  data?: {
    name?: string;
    description?: string;
    personality?: string;
    scenario?: string;
    first_mes?: string;
    mes_example?: string;
    system_prompt?: string;
    post_history_instructions?: string;
    creator_notes?: string;
    creator?: string;
    character_version?: string;
    tags?: string[];
    alternate_greetings?: string[];
    extensions?: {
      depth_prompt?: STDepthPrompt;
      [key: string]: unknown;
    };
    character_book?: {
      entries?: STLorebookEntryV2[];
      name?: string;
    };
  };
  // V1 fallback fields (top-level)
  description?: string;
  personality?: string;
  scenario?: string;
  first_mes?: string;
  mes_example?: string;
  spec?: string;
}

interface STWorldbook {
  name?: string;
  entries: Record<string, STWorldbookEntry>;
}

/**
 * The words the converter writes INTO the card — entry titles and the one
 * heading inside the character entry. They are content the AI reads, so they
 * follow the card's language (see `tavernLabelsFor` in import-world), not the
 * interface's. English is the fallback so the converter stays usable alone.
 */
export interface TavernImportLabels {
  /** Heading for the personality section inside the character entry. */
  personality: string;
  scenario: string;
  systemPrompt: string;
  exampleDialogue: string;
  greeting: string;
  /** `{{n}}` = 2, 3, … for alternate greetings. */
  greetingN: string;
  postHistory: string;
  depthPrompt: string;
  /** `{{n}}` = 1-based position, for a lorebook entry with no title or key. */
  lorebookEntryN: string;
  worldbookName: string;
  cardName: string;
}

export const DEFAULT_TAVERN_LABELS: TavernImportLabels = {
  personality: "Personality",
  scenario: "Scenario",
  systemPrompt: "System prompt",
  exampleDialogue: "Example dialogue",
  greeting: "Greeting",
  greetingN: "Greeting {{n}}",
  postHistory: "Post-history instructions",
  depthPrompt: "Character note",
  lorebookEntryN: "Lorebook entry {{n}}",
  worldbookName: "Imported lorebook",
  cardName: "Imported card",
};

const withN = (template: string, n: number) => template.replace("{{n}}", String(n));

/** A lorebook entry's title: its comment (what SillyTavern shows as the
 *  title), else its V2/V3 `name`, else its first key, else a numbered one. */
function lorebookEntryName(
  entry: { comment?: string; name?: string; keys?: string[]; key?: string[] },
  index: number,
  labels: TavernImportLabels,
): string {
  const keys = Array.isArray(entry.keys) ? entry.keys : Array.isArray(entry.key) ? entry.key : [];
  const firstKey = keys.find((k) => typeof k === "string" && k.trim());
  for (const candidate of [entry.comment, entry.name, firstKey]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return withN(labels.lorebookEntryN, index + 1);
}

/* -------------------------------------------------------------------------- */
/*  Detection                                                                 */
/* -------------------------------------------------------------------------- */

function isObjectEntryMap(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isTavernCharacterCard(json: unknown): json is STCharacterCard {
  if (!json || typeof json !== "object") return false;
  const obj = json as Record<string, unknown>;

  // V2/V3 cards have spec field
  if (typeof obj.spec === "string" && obj.spec.startsWith("chara_card")) {
    return true;
  }

  // V2/V3 cards always have a data object with name
  if (obj.data && typeof obj.data === "object") {
    const data = obj.data as Record<string, unknown>;
    if (typeof data.name === "string") return true;
  }

  // V1 cards: has name + first_mes or description at top level
  // Standalone worldbooks may also carry top-level name/description strings
  // (including empty strings), so an object-mapped `entries` field must win.
  if (
    !isObjectEntryMap(obj.entries) &&
    typeof obj.name === "string" &&
    (typeof obj.first_mes === "string" || typeof obj.description === "string")
  ) {
    return true;
  }

  return false;
}

export function isTavernWorldbook(json: unknown): json is STWorldbook {
  if (!json || typeof json !== "object") return false;
  const obj = json as Record<string, unknown>;

  // Standalone worldbook: { entries: { "0": {...}, "1": {...} } }
  if (isObjectEntryMap(obj.entries)) {
    const keys = Object.keys(obj.entries);
    if (keys.length === 0) return false;
    // Check first entry looks like a worldbook entry (has content + key/comment)
    const first = (obj.entries as Record<string, unknown>)[keys[0]];
    if (first && typeof first === "object") {
      const entry = first as Record<string, unknown>;
      return typeof entry.content === "string" || Array.isArray(entry.key);
    }
  }

  return false;
}

/* -------------------------------------------------------------------------- */
/*  Conversion helpers                                                        */
/* -------------------------------------------------------------------------- */

function makeId(): string {
  return crypto.randomUUID();
}

function mapSTRole(role: number | null | undefined): WorldEntry["apiRole"] {
  switch (role) {
    case 1:
      return "user";
    case 2:
      return "assistant";
    default:
      return "system";
  }
}

function mapSTSelectiveLogic(
  logic: number | undefined
): WorldEntry["secondaryKeywordLogic"] {
  switch (logic) {
    case 1:
      return "NOT_ALL";
    case 2:
      return "NOT_ANY";
    case 3:
      return "AND_ALL";
    default:
      return "AND_ANY";
  }
}

interface SectionAndDepth {
  section: WorldEntry["section"];
  depth?: number;
}

/**
 * Maps ST position values to Yumina section + depth.
 *
 * ST positions:
 *   0 = before char def → system-presets
 *   1 = after char def  → system-presets
 *   2 = before AN       → post-history
 *   3 = after AN        → post-history
 *   4 = @depth          → chat-history with depth value
 *   "before_char"       → system-presets
 *   "after_char"        → system-presets
 */
function mapSTPosition(
  position: string | number | undefined,
  extPosition: number | undefined,
  depth: number | undefined
): SectionAndDepth {
  // extensions.position overrides the top-level position
  const pos = extPosition ?? position;

  if (pos === 0 || pos === "before_char") {
    return { section: "system-presets" };
  }
  if (pos === 1 || pos === "after_char") {
    return { section: "system-presets" };
  }
  if (pos === 2 || pos === 3) {
    return { section: "post-history" };
  }
  if (pos === 4) {
    return { section: "chat-history", depth: depth ?? 4 };
  }

  // Default: treat as system-presets
  return { section: "system-presets" };
}

function makeEntry(
  overrides: Partial<WorldEntry> & { name: string; content: string }
): WorldEntry {
  return {
    id: makeId(),
    role: "lore",
    apiRole: undefined,
    alwaysSend: false,
    keywords: [],
    conditions: [],
    conditionLogic: "all",
    enabled: true,
    position: 0,
    section: "system-presets",
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*  Convert V2 lorebook entry (character_book.entries[])                       */
/* -------------------------------------------------------------------------- */

function convertV2LorebookEntry(
  entry: STLorebookEntryV2,
  positionOffset: number,
  index: number,
  labels: TavernImportLabels,
): WorldEntry {
  const ext = entry.extensions ?? {};
  const { section, depth } = mapSTPosition(
    entry.position,
    ext.position,
    ext.depth
  );

  const isConstant = entry.constant === true;
  const keywords = Array.isArray(entry.keys)
    ? entry.keys.filter((k) => typeof k === "string" && k.length > 0)
    : [];

  const secondaryKeywords = Array.isArray(entry.secondary_keys)
    ? entry.secondary_keys.filter((k) => typeof k === "string" && k.length > 0)
    : [];

  const isKeywordTriggered = !isConstant && keywords.length > 0;

  return makeEntry({
    name: lorebookEntryName(entry, index, labels),
    content: entry.content || "",
    role: "lore",
    apiRole: mapSTRole(ext.role),
    section,
    depth,
    alwaysSend: !isKeywordTriggered,
    keywords: isKeywordTriggered ? keywords : [],
    enabled: entry.enabled !== false,
    position: positionOffset,
    matchWholeWords: ext.match_whole_words ?? undefined,
    preventRecursion: ext.prevent_recursion ?? undefined,
    excludeRecursion: ext.exclude_recursion ?? undefined,
    secondaryKeywords: secondaryKeywords.length > 0 ? secondaryKeywords : undefined,
    secondaryKeywordLogic:
      secondaryKeywords.length > 0
        ? mapSTSelectiveLogic(ext.selectiveLogic)
        : undefined,
  });
}

/* -------------------------------------------------------------------------- */
/*  Convert standalone worldbook entry                                        */
/* -------------------------------------------------------------------------- */

function convertWorldbookEntry(
  entry: STWorldbookEntry,
  positionOffset: number,
  index: number,
  labels: TavernImportLabels,
): WorldEntry {
  const { section, depth } = mapSTPosition(
    entry.position,
    undefined,
    entry.depth ?? undefined
  );

  const isConstant = entry.constant === true;
  const keywords = Array.isArray(entry.key)
    ? entry.key.filter((k) => typeof k === "string" && k.length > 0)
    : [];

  const secondaryKeywords = Array.isArray(entry.keysecondary)
    ? entry.keysecondary.filter((k) => typeof k === "string" && k.length > 0)
    : [];

  const isKeywordTriggered = !isConstant && keywords.length > 0;

  return makeEntry({
    name: lorebookEntryName(entry as { comment?: string; name?: string; key?: string[] }, index, labels),
    content: entry.content || "",
    role: "lore",
    apiRole: mapSTRole(entry.role),
    section,
    depth,
    alwaysSend: !isKeywordTriggered,
    keywords: isKeywordTriggered ? keywords : [],
    enabled: entry.disable !== true,
    position: positionOffset,
    matchWholeWords: entry.matchWholeWords ?? undefined,
    preventRecursion: entry.preventRecursion ?? undefined,
    excludeRecursion: entry.excludeRecursion ?? undefined,
    secondaryKeywords: secondaryKeywords.length > 0 ? secondaryKeywords : undefined,
    secondaryKeywordLogic:
      secondaryKeywords.length > 0
        ? mapSTSelectiveLogic(entry.selectiveLogic)
        : undefined,
  });
}

/* -------------------------------------------------------------------------- */
/*  Main converters                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Converts a SillyTavern character card (V1/V2/V3) into a WorldDefinition.
 *
 * A card is ONE character: its description and personality become one
 * character entry named after the card, so the editor shows one character
 * under its real name, {{char}} resolves to that name, and the card reads as
 * a 1:1 character chat rather than a multi-NPC world.
 */
export function convertTavernCard(card: STCharacterCard, labelOverrides: Partial<TavernImportLabels> = {}): WorldDefinition {
  const labels = { ...DEFAULT_TAVERN_LABELS, ...labelOverrides };
  // V2/V3 data lives in card.data, V1 fallback to top-level
  const data = card.data ?? {};
  const name = (data.name || card.name || "").trim() || labels.cardName;
  const description = data.description || card.description || "";
  const personality = data.personality || card.personality || "";
  const scenario = data.scenario || card.scenario || "";
  const firstMes = data.first_mes || card.first_mes || "";
  const mesExample = data.mes_example || card.mes_example || "";
  const systemPrompt = data.system_prompt || "";
  const postHistoryInstructions = data.post_history_instructions || "";
  const creator = data.creator || "";
  const alternateGreetings = data.alternate_greetings ?? [];
  const depthPrompt = data.extensions?.depth_prompt;

  const entries: WorldEntry[] = [];

  // Position counter per section (offset after official presets which use 0-3)
  let systemPresetPos = 10;
  let postHistoryPos = 10;
  let chatHistoryPos = 0;

  // --- Character-level fields → entries ---

  // Description and personality are two halves of one character. The
  // personality rides under its own heading so nothing is lost, and a card
  // with only one of the two carries just that one.
  const characterParts: string[] = [];
  if (description.trim()) characterParts.push(description.trim());
  if (personality.trim()) {
    characterParts.push(characterParts.length > 0 ? `## ${labels.personality}\n${personality.trim()}` : personality.trim());
  }
  if (characterParts.length > 0) {
    entries.push(
      makeEntry({
        name,
        content: characterParts.join("\n\n"),
        role: "character",
        section: "system-presets",
        alwaysSend: true,
        position: systemPresetPos++,
      })
    );
  }

  if (scenario.trim()) {
    entries.push(
      makeEntry({
        name: labels.scenario,
        content: scenario,
        role: "scenario",
        section: "system-presets",
        alwaysSend: true,
        position: systemPresetPos++,
      })
    );
  }

  if (systemPrompt.trim()) {
    entries.push(
      makeEntry({
        name: labels.systemPrompt,
        content: systemPrompt,
        role: "system",
        section: "system-presets",
        alwaysSend: true,
        position: systemPresetPos++,
      })
    );
  }

  if (mesExample.trim()) {
    entries.push(
      makeEntry({
        name: labels.exampleDialogue,
        content: mesExample,
        role: "example",
        section: "system-presets",
        alwaysSend: true,
        position: systemPresetPos++,
      })
    );
  }

  if (firstMes.trim()) {
    entries.push(
      makeEntry({
        name: labels.greeting,
        content: firstMes,
        role: "greeting",
        section: "system-presets",
        alwaysSend: true,
        position: systemPresetPos++,
      })
    );
  }

  for (let i = 0; i < alternateGreetings.length; i++) {
    const greeting = alternateGreetings[i];
    if (typeof greeting === "string" && greeting.trim()) {
      entries.push(
        makeEntry({
          name: withN(labels.greetingN, i + 2),
          content: greeting,
          role: "greeting",
          section: "system-presets",
          alwaysSend: true,
          position: systemPresetPos++,
        })
      );
    }
  }

  if (postHistoryInstructions.trim()) {
    entries.push(
      makeEntry({
        name: labels.postHistory,
        content: postHistoryInstructions,
        role: "custom",
        section: "post-history",
        alwaysSend: true,
        position: postHistoryPos++,
      })
    );
  }

  if (depthPrompt?.prompt?.trim()) {
    entries.push(
      makeEntry({
        name: labels.depthPrompt,
        content: depthPrompt.prompt,
        role: "custom",
        section: "chat-history",
        alwaysSend: true,
        depth: depthPrompt.depth ?? 4,
        position: chatHistoryPos++,
      })
    );
  }

  // --- Lorebook entries ---

  const lorebookEntries = Array.isArray(data.character_book?.entries) ? data.character_book.entries : [];
  for (const [index, lbEntry] of lorebookEntries.entries()) {
    const { section } = mapSTPosition(
      lbEntry.position,
      lbEntry.extensions?.position,
      lbEntry.extensions?.depth
    );
    let pos: number;
    if (section === "system-presets") pos = systemPresetPos++;
    else if (section === "post-history") pos = postHistoryPos++;
    else pos = chatHistoryPos++;

    entries.push(convertV2LorebookEntry(lbEntry, pos, index, labels));
  }

  const id = crypto.randomUUID();
  return {
    id,
    version: "21.0.0",
    name,
    description: "",
    author: creator,
    entries,
    variables: [],
    rules: [],
    components: [],
    audioTracks: [],
    customUI: [],
    rootComponent: makeDefaultRootComponent(id),
    settings: {},
  } as WorldDefinition;
}

/**
 * Converts a standalone SillyTavern worldbook into a WorldDefinition.
 */
export function convertTavernWorldbook(wb: STWorldbook, labelOverrides: Partial<TavernImportLabels> = {}): WorldDefinition {
  const labels = { ...DEFAULT_TAVERN_LABELS, ...labelOverrides };
  const entries: WorldEntry[] = [];

  let systemPresetPos = 10;
  let postHistoryPos = 10;
  let chatHistoryPos = 0;

  const wbEntries = Object.values(wb.entries);
  // Sort by order (insertion_order) descending = higher priority first,
  // then by uid for stability
  wbEntries.sort((a, b) => {
    const orderA = a.order ?? 100;
    const orderB = b.order ?? 100;
    if (orderA !== orderB) return orderB - orderA;
    return (a.uid ?? 0) - (b.uid ?? 0);
  });

  for (const [index, wbEntry] of wbEntries.entries()) {
    const { section } = mapSTPosition(
      wbEntry.position,
      undefined,
      wbEntry.depth ?? undefined
    );
    let pos: number;
    if (section === "system-presets") pos = systemPresetPos++;
    else if (section === "post-history") pos = postHistoryPos++;
    else pos = chatHistoryPos++;

    entries.push(convertWorldbookEntry(wbEntry, pos, index, labels));
  }

  const id = crypto.randomUUID();
  return {
    id,
    version: "21.0.0",
    name: (typeof wb.name === "string" && wb.name.trim()) || labels.worldbookName,
    description: "",
    author: "",
    entries,
    variables: [],
    rules: [],
    components: [],
    audioTracks: [],
    customUI: [],
    rootComponent: makeDefaultRootComponent(id),
    settings: {},
  } as WorldDefinition;
}

/**
 * The language a SillyTavern file is written in, from its own text — the
 * titles the converter adds should match the card, whatever the interface is
 * set to. Kana means Japanese, Han without kana Chinese (Traditional only when
 * the interface is), Latin text English unless it reads as Spanish.
 */
export function guessTavernLanguage(json: unknown, uiLanguage = "en"): "zh" | "zh-Hant" | "ja" | "en" | "es" {
  const texts: string[] = [];
  const collect = (value: unknown, depth: number) => {
    if (texts.length > 200 || depth > 5) return;
    if (typeof value === "string") texts.push(value.slice(0, 2000));
    else if (Array.isArray(value)) value.forEach((v) => collect(v, depth + 1));
    else if (value && typeof value === "object") Object.values(value).forEach((v) => collect(v, depth + 1));
  };
  collect(json, 0);
  const text = texts.join("\n");
  if (/[぀-ヿ]/.test(text)) return "ja";
  if (/[一-鿿]/.test(text)) return /^zh-(hant|tw|hk|mo)/i.test(uiLanguage) ? "zh-Hant" : "zh";
  const spanish = (text.match(/[ñ¿¡]|\b(que|los|las|una|con|para|pero|está)\b/gi) ?? []).length;
  const english = (text.match(/\b(the|and|you|with|her|his|is)\b/gi) ?? []).length;
  return spanish > english ? "es" : "en";
}
