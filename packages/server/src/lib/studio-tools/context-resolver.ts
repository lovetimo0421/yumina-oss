import type {
  WorldDefinition,
  WorldEntry,
  Rule,
  CustomUIComponent,
} from "@yumina/engine";
import type { Reaction } from "@yumina/engine";
import { loadAssetCatalog, formatAssetCatalog } from "./asset-catalog.js";

// ── Types ──

export interface ResolvedContext {
  /** Layer 1: Rich inventory of ALL entities (compact but detailed enough to orient) */
  inventory: string;
  /** Layer 2: Full content of matched + system-presets entries */
  preloadedEntities: string;
  /** Token estimate for budget tracking */
  tokenEstimate: number;
  /** Whether the budget cap was hit and content was truncated */
  truncated: boolean;
  /** Human-readable summary of what was dropped (only set when truncated) */
  truncationDetail?: string;
  /** Lorebook bloat check — drives the slim-skill auto-load in the system prompt */
  lorebookHealth: LorebookHealth;
}

// ── Lorebook Health (bloat detection → slim-skill auto-load) ──

/** Budgets aligned with the editor's health bands (entries.tsx colours the dot
 *  "heavy" past ~60k total). 20k always-send is the per-turn comfort ceiling;
 *  entries carrying ≥15 keywords fire so often they act always-on. */
export const LOREBOOK_BUDGETS = {
  alwaysSendTokens: 20_000,
  pseudoAlwaysPoolTokens: 5_000,
  totalTokens: 60_000,
  broadKeywordCount: 15,
} as const;

export interface LorebookHealth {
  alwaysCount: number;
  alwaysTokens: number;
  /** Enabled keyword entries with ≥broadKeywordCount keywords — effectively always-on */
  pseudoAlwaysCount: number;
  pseudoAlwaysTokens: number;
  totalTokens: number;
  /** Largest enabled non-greeting entries, biggest first (top 5) */
  topEntries: Array<{ name: string; tokens: number; alwaysSend: boolean; keywordCount: number }>;
  overBudget: boolean;
  /** Full-sentence reasons with numbers baked in; empty when healthy */
  reasons: string[];
}

export function computeLorebookHealth(world: WorldDefinition): LorebookHealth {
  let alwaysCount = 0;
  let alwaysTokens = 0;
  let pseudoAlwaysCount = 0;
  let pseudoAlwaysTokens = 0;
  let totalTokens = 0;
  const sized: LorebookHealth["topEntries"] = [];

  for (const e of world.entries) {
    const tokens = estimateTokens(e.content ?? "");
    totalTokens += tokens;
    if (e.role === "greeting" || !e.enabled) continue;
    const keywordCount = toStringArray(e.keywords).length;
    sized.push({ name: e.name, tokens, alwaysSend: !!e.alwaysSend, keywordCount });
    if (e.alwaysSend) {
      alwaysCount++;
      alwaysTokens += tokens;
    } else if (keywordCount >= LOREBOOK_BUDGETS.broadKeywordCount) {
      pseudoAlwaysCount++;
      pseudoAlwaysTokens += tokens;
    }
  }

  sized.sort((a, b) => b.tokens - a.tokens);

  const reasons: string[] = [];
  if (alwaysTokens > LOREBOOK_BUDGETS.alwaysSendTokens) {
    reasons.push(`always-send load is ~${alwaysTokens.toLocaleString()} tokens/turn across ${alwaysCount} entries (budget ${LOREBOOK_BUDGETS.alwaysSendTokens.toLocaleString()})`);
  }
  if (pseudoAlwaysTokens > LOREBOOK_BUDGETS.pseudoAlwaysPoolTokens) {
    reasons.push(`${pseudoAlwaysCount} entries carry ≥${LOREBOOK_BUDGETS.broadKeywordCount} keywords and act always-on (~${pseudoAlwaysTokens.toLocaleString()} tokens)`);
  }
  if (totalTokens > LOREBOOK_BUDGETS.totalTokens) {
    reasons.push(`total lorebook is ~${totalTokens.toLocaleString()} tokens (healthy ceiling ${LOREBOOK_BUDGETS.totalTokens.toLocaleString()})`);
  }

  return {
    alwaysCount,
    alwaysTokens,
    pseudoAlwaysCount,
    pseudoAlwaysTokens,
    totalTokens,
    topEntries: sized.slice(0, 5),
    overBudget: reasons.length > 0,
    reasons,
  };
}

// ── Token Estimation ──

/** Token estimate: ~4 chars/token for ASCII, ~1 char/token for CJK.
 *  Flat /4 undercounts Chinese content 4-8x, blowing the Layer 2 budget.
 *  Exported for the write-tool cost echo (tool-executor). */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff)) {
      cjk++;
    }
  }
  const ascii = text.length - cjk;
  return Math.ceil(cjk + ascii / 4);
}

// ── Keyword Extraction ──

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "must", "need", "to", "of",
  "in", "for", "on", "with", "at", "by", "from", "as", "into", "about",
  "it", "its", "this", "that", "these", "those", "my", "your", "his",
  "her", "our", "their", "me", "him", "them", "us", "i", "you", "he",
  "she", "we", "they", "and", "or", "but", "not", "no", "if", "then",
  "so", "just", "also", "too", "very", "really", "please", "make",
  "add", "create", "update", "change", "modify", "edit", "delete",
  "remove", "set", "get", "new", "more", "less", "some", "all",
]);

/** CJK Unified Ideographs + common CJK ranges */
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/;

export function extractKeywords(request: string): string[] {
  const lower = request.toLowerCase();
  const results: string[] = [];

  // Extract Latin/digit words (existing logic)
  const latinWords = lower
    .replace(/[^\w\s-]/g, (ch) => (CJK_RE.test(ch) ? ch : " "))
    .split(/\s+/)
    .filter((w) => w.length > 1 && !CJK_RE.test(w[0]!) && !STOP_WORDS.has(w));
  results.push(...latinWords);

  // Extract CJK: individual characters + bigrams for better matching
  // e.g. "修改猫猫的性格" → ["修改", "猫猫", "性格", "猫", "格"]
  const cjkChars = lower.replace(/[^\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g, " ").split(/\s+/).filter(Boolean);
  for (const run of cjkChars) {
    // Full run as keyword (good for multi-char names like "猫猫")
    if (run.length >= 2) results.push(run);
    // Bigrams for substring matching
    for (let i = 0; i < run.length - 1; i++) {
      const bigram = run.slice(i, i + 2);
      if (!results.includes(bigram)) results.push(bigram);
    }
    // Single chars only for short runs (avoid noise from long strings)
    if (run.length <= 2) {
      for (const ch of run) {
        if (!results.includes(ch)) results.push(ch);
      }
    }
  }

  return results;
}

// ── Entity Matching ──

/** Word-boundary match for Latin keywords, substring match for CJK. */
function matchesKeyword(text: string, kw: string): boolean {
  // CJK keywords: substring match (no word boundaries in CJK text)
  if (CJK_RE.test(kw)) return text.includes(kw);
  // Latin keywords: word-boundary match to avoid "cat" matching "catalog"
  try {
    return new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
  } catch {
    return text.includes(kw);
  }
}

/** Tolerate corrupt entries whose array fields were persisted as a string.
 *  Studio AI tool calls occasionally emit `keywords: "a, b"` (or `tags`) instead
 *  of `["a", "b"]`; without coercion a stored string crashes every read site that
 *  calls `.map`/`.slice`/`.join` on the field (e.g. `e.keywords.slice(...).join`). */
export function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  if (typeof value === "string") {
    return value.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

interface ScoredEntry {
  entry: WorldEntry;
  score: number;
}

function scoreEntry(entry: WorldEntry, keywords: string[]): number {
  let score = 0;
  const nameLower = entry.name.toLowerCase();
  const keywordsLower = toStringArray(entry.keywords).map((k) => k.toLowerCase());
  const tagsLower = toStringArray(entry.tags).map((t) => t.toLowerCase());

  for (const kw of keywords) {
    // Name match (strongest signal)
    if (matchesKeyword(nameLower, kw)) score += 3;
    // Keyword match
    if (keywordsLower.some((k) => matchesKeyword(k, kw))) score += 2;
    // Tag match
    if (tagsLower.some((t) => matchesKeyword(t, kw))) score += 1;
  }

  return score;
}

function scoreBehavior(behavior: Reaction, keywords: string[]): number {
  let score = 0;
  const nameLower = behavior.name.toLowerCase();

  for (const kw of keywords) {
    if (matchesKeyword(nameLower, kw)) score += 2;
  }

  return score;
}

function scoreRule(rule: Rule, keywords: string[]): number {
  let score = 0;
  const nameLower = rule.name.toLowerCase();

  for (const kw of keywords) {
    if (matchesKeyword(nameLower, kw)) score += 2;
  }

  return score;
}

// ── Layer 1: Rich Inventory ──

function buildInventory(world: WorldDefinition, assets: AssetSummary[]): string {
  const parts: string[] = [];

  // World metadata
  parts.push(`World: "${world.name || "(unnamed)"}"`);
  if (world.description) parts.push(`Description: ${world.description}`);

  // Entries inventory (compact but rich — includes keywords, not just count)
  if (world.entries.length > 0) {
    parts.push(`\nENTRIES (${world.entries.length}):`);
    for (const e of world.entries) {
      const flags: string[] = [];
      flags.push(e.section);
      if (!e.enabled) flags.push("DISABLED");
      if (e.alwaysSend) flags.push("alwaysSend");
      if (e.depth) flags.push(`depth=${e.depth}`);
      if (e.worldbookId) flags.push(`book=${e.worldbookId}`);
      if (e.audience && e.audience !== "both") flags.push(`audience=${e.audience}`);

      const kw = toStringArray(e.keywords);
      const kwStr = kw.length > 0
        ? ` keywords=[${kw.slice(0, 8).join(", ")}${kw.length > 8 ? "..." : ""}]`
        : "";
      const tags = toStringArray(e.tags);
      const tagStr = tags.length ? ` tags=[${tags.join(", ")}]` : "";
      const condStr = e.conditions.length > 0
        ? ` conditions=[${e.conditions.map((c) => `${c.variableId} ${c.operator} ${c.value}`).join("; ")}]`
        : "";
      const ivKeys = e.initialVariables ? Object.keys(e.initialVariables) : [];
      const ivStr = ivKeys.length
        ? ` initialVars={${ivKeys.map((k) => `${k}=${JSON.stringify(e.initialVariables![k])}`).join(", ")}}`
        : "";

      parts.push(`  ${e.id}: "${e.name}" [${e.role}] (${flags.join(", ")}) pos=${e.position}${kwStr}${tagStr}${condStr}${ivStr}`);
    }

    // Greeting count
    const greetings = world.entries.filter((e) => e.role === "greeting");
    if (greetings.length > 0) parts.push(`  Greetings: ${greetings.length}`);
  }

  // Worldbooks (knowledge bases) — only an ACTIVE book's entries reach the AI;
  // entries with no book belong to the always-on Core. Two-layer gating: book
  // activation runs BEFORE each member entry's own alwaysSend/keyword/condition.
  const worldbooks = world.worldbooks ?? [];
  if (worldbooks.length > 0) {
    parts.push(`\nWORLDBOOKS (${worldbooks.length}) — entries with no book = always-on Core:`);
    for (const wb of [...worldbooks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
      const act = wb.activation;
      let actStr: string;
      if (act.mode === "conditions") {
        actStr = `conditions(${act.conditionLogic}): ${act.conditions.map((c) => `${c.variableId} ${c.operator} ${c.value}`).join("; ") || "(none)"}`;
      } else if (act.mode === "greeting") {
        actStr = `greeting=[${act.greetingIds.join(", ")}]`;
      } else {
        actStr = act.mode; // always | manual
      }
      const memberCount = world.entries.filter((e) => e.worldbookId === wb.id).length;
      const off = wb.enabled === false ? " DISABLED" : "";
      parts.push(`  ${wb.id}: "${wb.name}" — activation=${actStr}; ${memberCount} entr${memberCount === 1 ? "y" : "ies"}${off}`);
    }
  }

  // Lore UI bindings — frontend <LoreSlot>/<LoreButton> slot → entry (eligible
  // for injection while the slot is mounted/toggled by the player in the TSX).
  const bindings = world.loreUiBindings ?? [];
  if (bindings.length > 0) {
    parts.push(`\nLORE BINDINGS (${bindings.length}) — frontend slot → entry:`);
    for (const b of bindings) {
      const cond = b.conditions.length
        ? ` +conditions(${b.conditionLogic}): ${b.conditions.map((c) => `${c.variableId} ${c.operator} ${c.value}`).join("; ")}`
        : "";
      parts.push(`  slot "${b.slotId}" → entry "${b.entryId}"${cond}`);
    }
  }

  // Variables — compact inventory (truncate long behaviorRules/description, full via read_entities)
  if (world.variables.length > 0) {
    parts.push(`\nVARIABLES (${world.variables.length}):`);
    for (const v of world.variables) {
      const range = v.min != null || v.max != null
        ? ` [${v.min ?? "—"}..${v.max ?? "—"}]`
        : "";
      const rules = v.behaviorRules
        ? `\n    behaviorRules: "${v.behaviorRules.length > 60 ? v.behaviorRules.slice(0, 60) + "..." : v.behaviorRules}"`
        : "";
      const desc = v.description
        ? `\n    description: "${v.description.length > 60 ? v.description.slice(0, 60) + "..." : v.description}"`
        : "";
      // Surface setup-scope so the AI can tell a pre-game choice variable is
      // protected from the opening-switch reset (or spot that it's missing).
      const scope = v.scope === "setup" ? " scope:setup" : "";
      parts.push(`  ${v.id}: "${v.name}" (${v.type}${scope}, default: ${JSON.stringify(v.defaultValue)})${range}${desc}${rules}`);
    }
  }

  // Behaviors/Reactions
  const reactions = world.reactions ?? [];
  if (reactions.length > 0) {
    parts.push(`\nBEHAVIORS (${reactions.length}):`);
    for (const r of reactions) {
      const flags = !r.enabled ? " DISABLED" : "";
      parts.push(`  ${r.id}: "${r.name}" [${r.when.eventType}] priority=${r.priority}${flags}`);
    }
  }

  // Legacy rules
  if (world.rules.length > 0) {
    parts.push(`\nRULES (${world.rules.length}):`);
    for (const r of world.rules) {
      const flags = !r.enabled ? " DISABLED" : "";
      parts.push(`  ${r.id}: "${r.name}" [WHEN: ${r.trigger.type}] priority=${r.priority}${flags}`);
    }
  }

  // Custom UI / Root Component
  if (world.rootComponent) {
    // Worlds with rootComponent: show it as the rendered app component
    const rc = world.rootComponent;
    const fileNames = Object.keys(rc.files);
    parts.push(`\nROOT COMPONENT:`);
    parts.push(`  ${rc.id}: "${rc.name}" entry=${rc.entryFile}`);
    // List each file with its size — agent uses filenames as IDs for read_entities and
    // write_custom_ui, and the size tells it which files to page through rather than read whole.
    for (const fn of fileNames) {
      const code = rc.files[fn] ?? "";
      const kb = Math.max(1, Math.round(code.length / 1024));
      const entryMark = fn === rc.entryFile ? " (entry)" : "";
      const bigMark = code.length > UI_PRELOAD_MAX_FILE_CHARS
        ? " — large; read on demand with grep_world / read_entities(offset_lines)"
        : "";
      parts.push(`    file: "${fn}" [${kb}KB]${entryMark}${bigMark}`);
    }
  }
  // Every migrated world has rootComponent — the customUI[]-only branch that
  // used to live here was removed in the v1→v2 unification.

  // Audio tracks
  if (world.audioTracks.length > 0) {
    parts.push(`\nAUDIO (${world.audioTracks.length}):`);
    for (const a of world.audioTracks) {
      parts.push(`  ${a.id}: "${a.name}" (${a.type})`);
    }
  }

  // Assets (user uploads)
  if (assets.length > 0) {
    parts.push(`\nASSETS (${assets.length}):`);
    for (const a of assets) {
      parts.push(`  @asset:${a.id}  "${a.filename}" [${a.type}]`);
    }
  }

  // Settings
  const s = world.settings;
  if (s) {
    const settingParts: string[] = [];
    if (s.maxTokens) settingParts.push(`maxTokens=${s.maxTokens}`);
    if (s.temperature != null) settingParts.push(`temp=${s.temperature}`);
    if (s.playerName) settingParts.push(`playerName="${s.playerName}"`);
    if (settingParts.length > 0) {
      parts.push(`\nSETTINGS: ${settingParts.join(", ")}`);
    }
  }

  return parts.join("\n");
}

// Per-file size cap for force-preloading rootComponent TSX into the system prompt.
// Files at/under this load in full on a UI-related request; larger files are left for
// on-demand reads (grep_world / read_entities with offset_lines) so one huge component
// can't bloat every agent iteration to ~200K tokens. Tunable.
const UI_PRELOAD_MAX_FILE_CHARS = 32 * 1024;

// ── Layer 2: Pre-loaded Full Content ──

function buildPreloadedContent(
  _world: WorldDefinition,
  matchedEntries: WorldEntry[],
  matchedBehaviors: Reaction[],
  matchedRules: Rule[],
  matchedUI: CustomUIComponent[],
): string {
  const parts: string[] = [];

  if (matchedEntries.length > 0) {
    parts.push("PRELOADED ENTRIES (full content):");
    for (const e of matchedEntries) {
      parts.push(`\n<entry id="${e.id}">`);
      parts.push(`  name: ${e.name}`);
      parts.push(`  role: ${e.role}`);
      parts.push(`  section: ${e.section}`);
      parts.push(`  position: ${e.position}`);
      parts.push(`  enabled: ${e.enabled}`);
      if (e.apiRole) parts.push(`  apiRole: ${e.apiRole}`);
      if (e.depth) parts.push(`  depth: ${e.depth}`);
      if (e.alwaysSend) parts.push(`  alwaysSend: true`);
      const entryKw = toStringArray(e.keywords);
      if (entryKw.length > 0) parts.push(`  keywords: [${entryKw.join(", ")}]`);
      if (e.conditions.length > 0) {
        parts.push(`  conditions (${e.conditionLogic}): ${e.conditions.map((c) => `${c.variableId} ${c.operator} ${c.value}`).join("; ")}`);
      }
      const entryTags = toStringArray(e.tags);
      if (entryTags.length) parts.push(`  tags: [${entryTags.join(", ")}]`);
      if (e.matchWholeWords) parts.push(`  matchWholeWords: true`);
      const entrySecKw = toStringArray(e.secondaryKeywords);
      if (entrySecKw.length) parts.push(`  secondaryKeywords: [${entrySecKw.join(", ")}]`);
      parts.push(`  content: |`);
      // Indent content for readability
      const contentLines = e.content.split("\n");
      for (const line of contentLines) {
        parts.push(`    ${line}`);
      }
      parts.push(`</entry>`);
    }
  }

  if (matchedBehaviors.length > 0) {
    parts.push("\nPRELOADED BEHAVIORS (full content):");
    for (const b of matchedBehaviors) {
      parts.push(`\n<behavior id="${b.id}">`);
      parts.push(`  name: ${b.name}`);
      if (b.description) parts.push(`  description: ${b.description}`);
      parts.push(`  when: ${JSON.stringify(b.when)}`);
      if (b.conditions.length > 0) {
        parts.push(`  conditions (${b.conditionLogic}): ${JSON.stringify(b.conditions)}`);
      }
      parts.push(`  then: ${JSON.stringify(b.then)}`);
      parts.push(`  priority: ${b.priority}`);
      if (b.cooldownTurns) parts.push(`  cooldownTurns: ${b.cooldownTurns}`);
      if (b.maxFireCount) parts.push(`  maxFireCount: ${b.maxFireCount}`);
      parts.push(`  enabled: ${b.enabled}`);
      parts.push(`</behavior>`);
    }
  }

  if (matchedRules.length > 0) {
    parts.push("\nPRELOADED RULES (full content):");
    for (const r of matchedRules) {
      parts.push(`\n<rule id="${r.id}">`);
      parts.push(`  name: ${r.name}`);
      if (r.description) parts.push(`  description: ${r.description}`);
      parts.push(`  trigger: ${JSON.stringify(r.trigger)}`);
      if (r.conditions.length > 0) {
        parts.push(`  conditions (${r.conditionLogic}): ${JSON.stringify(r.conditions)}`);
      }
      parts.push(`  actions: ${JSON.stringify(r.actions)}`);
      parts.push(`  priority: ${r.priority}`);
      parts.push(`  enabled: ${r.enabled}`);
      parts.push(`</rule>`);
    }
  }

  if (matchedUI.length > 0) {
    parts.push("\nPRELOADED CUSTOM UI (full content):");
    for (const c of matchedUI) {
      parts.push(`\n<customUI id="${c.id}">`);
      parts.push(`  name: ${c.name}`);
      if (c.language && c.language !== "tsx") parts.push(`  language: ${c.language}`);
      if (c.description) parts.push(`  description: ${c.description}`);
      parts.push(`  visible: ${c.visible}`);
      parts.push(`  code: |`);
      const codeLines = c.tsxCode.split("\n");
      for (const line of codeLines) {
        parts.push(`    ${line}`);
      }
      parts.push(`</customUI>`);
    }
  }

  return parts.join("\n");
}

// ── Asset Loading ──

interface AssetSummary {
  id: string;
  filename: string;
  type: string;
}

// ── Main Resolver ──

/**
 * Build tiered context for the Studio AI agent.
 *
 * Layer 1: Rich inventory of ALL entities (keywords, tags, conditions — not just names).
 *          Variables fully loaded. Assets included.
 * Layer 2: Full content of entries matching request keywords + ALL system-presets entries.
 *          Behaviors/rules/UI referencing matched entries.
 * Layer 3: read_entities tool available as fallback (handled by agent loop, not here).
 *
 * Token budget: 45% of model context for entity context.
 */
export async function resolveContext(
  world: WorldDefinition,
  request: string,
  options: {
    userId: string;
    /** Database world ID, which can differ from the imported schema.id. */
    worldId?: string;
    /** Model context window size in tokens (default 120k) */
    contextWindow?: number;
    /** Currently selected entity ID in the editor — force-preloaded */
    selectedEntityId?: string;
    /** Active editor panel — triggers panel-aware preloading */
    activePanel?: string;
  },
): Promise<ResolvedContext> {
  const contextWindow = options.contextWindow ?? 120_000;
  const contextBudget = Math.floor(contextWindow * 0.45);

  // Load assets
  let assetInventory: string;
  try {
    assetInventory = options.worldId
      ? formatAssetCatalog(await loadAssetCatalog(options.userId, options.worldId))
      : "\nASSET LIBRARY unavailable: database worldId was not provided.\n";
  } catch {
    assetInventory = "\nASSET LIBRARY read failed. Do not claim assets are missing; retry using list_assets.\n";
  }

  // Build Layer 1: rich inventory (always loaded)
  const inventory = buildInventory(world, []) + assetInventory;
  let tokenEstimate = estimateTokens(inventory);

  // Extract keywords from user request
  const keywords = extractKeywords(request);

  // Score and match entries
  const scoredEntries: ScoredEntry[] = world.entries.map((entry) => ({
    entry,
    score: scoreEntry(entry, keywords),
  }));

  // Pre-load: keyword matches + ALL system-presets entries
  const matchedEntries: WorldEntry[] = [];
  const matchedIds = new Set<string>();

  // Force-preload the selected entity (highest priority — user is actively editing this)
  if (options.selectedEntityId) {
    const selId = options.selectedEntityId;
    const selEntry = world.entries.find((e) => e.id === selId);
    if (selEntry && !matchedIds.has(selEntry.id)) {
      matchedEntries.push(selEntry);
      matchedIds.add(selEntry.id);
    }
  }

  // Always include system-presets entries (they define the world identity)
  for (const e of world.entries) {
    if (e.section === "system-presets" && e.enabled && !matchedIds.has(e.id)) {
      matchedEntries.push(e);
      matchedIds.add(e.id);
    }
  }

  // Add keyword-matched entries (sorted by score descending)
  const keywordMatches = scoredEntries
    .filter((s) => s.score > 0 && !matchedIds.has(s.entry.id))
    .sort((a, b) => b.score - a.score);

  for (const { entry } of keywordMatches) {
    matchedEntries.push(entry);
    matchedIds.add(entry.id);
  }

  // Find behaviors that reference matched entries (graph walk)
  const reactions = world.reactions ?? [];
  const matchedBehaviors: Reaction[] = [];

  // Score behaviors against keywords
  for (const b of reactions) {
    if (scoreBehavior(b, keywords) > 0) {
      matchedBehaviors.push(b);
    }
  }

  // Score rules against keywords
  const matchedRules: Rule[] = [];
  for (const r of world.rules) {
    if (scoreRule(r, keywords) > 0) {
      matchedRules.push(r);
    }
  }

  // Match custom UI if request mentions UI-related terms
  const uiKeywords = ["component", "renderer", "ui", "tsx", "interface", "hud", "overlay", "panel", "screen", "visual", "display",
    "前端", "界面", "组件", "样式", "背景", "显示", "渲染", "主题", "皮肤", "外观"];
  // Also match if the request mentions a specific rootComponent filename
  const rcFileNames = world.rootComponent
    ? Object.keys(world.rootComponent.files)
    : [];
  const mentionsRcFile = rcFileNames.some((fn) => {
    const base = fn.replace(/\.tsx?$/, "").toLowerCase();
    return keywords.some((kw) => kw === base || kw === fn.toLowerCase());
  });
  const isUIRequest = keywords.some((kw) => uiKeywords.includes(kw)) || mentionsRcFile;

  // Preload rootComponent file CONTENT only for UI-related requests, and only for files
  // small enough to be worth carrying in every prompt. We deliberately DON'T key this off
  // the editor panel or a "selected element": the front-end never sets a selection, and
  // ~90% of editing happens by talking to the agent regardless of which panel is open, so
  // those signals are noise. Large files (e.g. a 162KB index.tsx) are NEVER force-loaded —
  // the inventory lists them with size + a read hint, and the agent pulls the exact slice it
  // needs on demand via grep_world / read_entities(offset_lines). Keeps each step small
  // instead of re-sending ~200K tokens every iteration.
  let matchedUI: CustomUIComponent[] = [];
  if (isUIRequest && world.rootComponent) {
    const rc = world.rootComponent;
    // The `surface` field is required by the legacy type but has no meaning in v2 —
    // stamp "app" purely so this compiles against the legacy type shape.
    matchedUI = Object.entries(rc.files)
      .filter(([, code]) => code.length <= UI_PRELOAD_MAX_FILE_CHARS)
      .map(([filename, code], i) => ({
        id: filename,
        name: `${rc.name} / ${filename}`,
        surface: "app" as const,
        language: "tsx" as const,
        tsxCode: code,
        description: filename === rc.entryFile ? "entry file" : "sub-file",
        order: i,
        visible: true,
        updatedAt: rc.updatedAt,
      }));
  }

  // Build Layer 2: pre-loaded content
  let preloadedContent = buildPreloadedContent(
    world,
    matchedEntries,
    matchedBehaviors,
    matchedRules,
    matchedUI,
  );

  tokenEstimate += estimateTokens(preloadedContent);

  // Token budget enforcement: truncate if over budget
  let truncated = false;
  let truncationDetail: string | undefined;
  if (tokenEstimate > contextBudget) {
    truncated = true;

    // Strategy: keep system-presets entries and top keyword matches,
    // drop lowest-scoring matches until under budget
    const systemEntries = matchedEntries.filter((e) => e.section === "system-presets");
    const otherEntries = matchedEntries.filter((e) => e.section !== "system-presets");
    const originalOtherCount = otherEntries.length;

    // Remove entries from the back (lowest scores) until under budget
    while (tokenEstimate > contextBudget && otherEntries.length > 0) {
      otherEntries.pop();
      // Rebuild preloaded content with reduced entries
      preloadedContent = buildPreloadedContent(
        world,
        [...systemEntries, ...otherEntries],
        matchedBehaviors,
        matchedRules,
        matchedUI,
      );
      tokenEstimate = estimateTokens(inventory) + estimateTokens(preloadedContent);
    }

    const droppedEntries = originalOtherCount - otherEntries.length;
    let droppedBehaviors = 0;
    let droppedRules = 0;
    let droppedUI = 0;

    // If still over budget, drop behaviors and rules
    if (tokenEstimate > contextBudget) {
      droppedBehaviors = matchedBehaviors.length;
      droppedRules = matchedRules.length;
      droppedUI = matchedUI.length;
      preloadedContent = buildPreloadedContent(
        world,
        [...systemEntries, ...otherEntries],
        [],
        [],
        [],
      );
      tokenEstimate = estimateTokens(inventory) + estimateTokens(preloadedContent);
    }

    // Build human-readable truncation summary
    const parts: string[] = [];
    if (droppedEntries > 0) parts.push(`${droppedEntries} keyword-matched entries`);
    if (droppedBehaviors > 0) parts.push(`${droppedBehaviors} behaviors`);
    if (droppedRules > 0) parts.push(`${droppedRules} rules`);
    if (droppedUI > 0) parts.push(`${droppedUI} UI components`);
    truncationDetail = parts.length > 0 ? `Dropped: ${parts.join(", ")}` : "Content trimmed to fit budget";
  }

  return {
    inventory,
    preloadedEntities: preloadedContent,
    tokenEstimate,
    truncated,
    truncationDetail,
    lorebookHealth: computeLorebookHealth(world),
  };
}
