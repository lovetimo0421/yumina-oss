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
  entries: Record<string, STWorldbookEntry>;
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
  positionOffset: number
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
    name: entry.comment || "Imported Entry",
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
  positionOffset: number
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
    name: entry.comment || "Imported Entry",
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
 */
export function convertTavernCard(card: STCharacterCard): WorldDefinition {
  // V2/V3 data lives in card.data, V1 fallback to top-level
  const data = card.data ?? {};
  const name = data.name || card.name || "Imported Card";
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

  if (description.trim()) {
    entries.push(
      makeEntry({
        name: "Character Description",
        content: description,
        role: "character",
        section: "system-presets",
        alwaysSend: true,
        position: systemPresetPos++,
      })
    );
  }

  if (personality.trim()) {
    entries.push(
      makeEntry({
        name: "Personality",
        content: personality,
        role: "personality",
        section: "system-presets",
        alwaysSend: true,
        position: systemPresetPos++,
      })
    );
  }

  if (scenario.trim()) {
    entries.push(
      makeEntry({
        name: "Scenario",
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
        name: "System Prompt",
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
        name: "Example Dialogue",
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
        name: "Greeting",
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
          name: `Greeting ${i + 2}`,
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
        name: "Post-History Instructions",
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
        name: "Depth Prompt",
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

  const lorebookEntries = data.character_book?.entries ?? [];
  for (const lbEntry of lorebookEntries) {
    const { section } = mapSTPosition(
      lbEntry.position,
      lbEntry.extensions?.position,
      lbEntry.extensions?.depth
    );
    let pos: number;
    if (section === "system-presets") pos = systemPresetPos++;
    else if (section === "post-history") pos = postHistoryPos++;
    else pos = chatHistoryPos++;

    entries.push(convertV2LorebookEntry(lbEntry, pos));
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
export function convertTavernWorldbook(wb: STWorldbook): WorldDefinition {
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

  for (const wbEntry of wbEntries) {
    const { section } = mapSTPosition(
      wbEntry.position,
      undefined,
      wbEntry.depth ?? undefined
    );
    let pos: number;
    if (section === "system-presets") pos = systemPresetPos++;
    else if (section === "post-history") pos = postHistoryPos++;
    else pos = chatHistoryPos++;

    entries.push(convertWorldbookEntry(wbEntry, pos));
  }

  const id = crypto.randomUUID();
  return {
    id,
    version: "21.0.0",
    name: "Imported Worldbook",
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
