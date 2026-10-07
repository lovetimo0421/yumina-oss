import type {
  WorldDefinition,
  WorldEntry,
  Rule,
  CustomUIComponent,
} from "@yumina/engine";
import { resolveStation } from "@yumina/engine";
import type { Reaction } from "@yumina/engine";
import { isContinuityEnabled, isContinuityOwned, isSceneImageJudgeOn } from "@yumina/engine";
import { loadAssetCatalog, formatAssetCatalog } from "./asset-catalog.js";
import { uiDocOwnedFiles } from "./ui-doc-tools.js";
import { stickyNotes } from "./sticky-notes.js";

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
  /** What the creator pointed the assistant at on the canvas, when anything.
   *  Only these were preloaded in full; everything else is inventory only. */
  focus?: { labels: string[] };
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

// Exported for tests: the snapshot's shape IS the agent's world model, so the
// blackboard lines (module notes, canvas notes) are asserted, not assumed.
export function buildInventory(world: WorldDefinition, assets: AssetSummary[]): string {
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
      if (e.role === "character" && e.portrait) flags.push("portrait");
      if (e.role === "character" && e.voice) flags.push(`voice=${e.voice}`);

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
    parts.push(`\nMODULES / WORLDBOOKS (${worldbooks.length}) — members with no book = always-on Core; an inactive module gates its entries AND variables AND behaviors:`);
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
      const entryCount = world.entries.filter((e) => e.worldbookId === wb.id).length;
      const varCount = world.variables.filter((v) => v.worldbookId === wb.id).length;
      const behCount = (world.reactions ?? []).filter((r) => r.worldbookId === wb.id).length;
      const members = [`${entryCount} entr${entryCount === 1 ? "y" : "ies"}`];
      if (varCount > 0) members.push(`${varCount} var${varCount === 1 ? "" : "s"}`);
      if (behCount > 0) members.push(`${behCount} behavior${behCount === 1 ? "" : "s"}`);
      const off = wb.enabled === false ? " DISABLED" : "";
      const st = resolveStation(wb);
      const run = !st
        ? ""
        : st.kind === "worker"
          ? " [WORKER station: background AI, never speaks to the player; its output is context for others]"
          : ` [NARRATOR station: its own AI answers the player while active${st.onClose === "archive" ? "; on deactivation its span folds into a summary (副本)" : ""}${st.memoryPool ? `; memory pool "${st.memoryPool}" — remembers only the runs of modules in that pool` : ""}]`;
      parts.push(`  ${wb.id}: "${wb.name}" — activation=${actStr}; ${members.join(", ")}${off}${run}`);
      // The sticky note is the creator's own statement of what this module IS
      // and what they intend for it — read it before touching the module, and
      // keep it current via write_worldbook { note } when intent changes.
      if (wb.note) {
        const noteText = wb.note.length > 300 ? wb.note.slice(0, 300) + "… (full via read_entities)" : wb.note;
        parts.push(`    📌 note: ${noteText.replace(/\n/g, " / ")}`);
      }
      if (wb.description) {
        const desc = wb.description.length > 160 ? wb.description.slice(0, 160) + "..." : wb.description;
        parts.push(`    description: ${desc.replace(/\n/g, " ")}`);
      }
      if (wb.frontendFile) parts.push(`    frontend scene: ${wb.frontendFile}`);
      if (st) {
        if (st.model) parts.push(`    model: ${st.model}`);
        if (st.inputs.length > 0) {
          const wires = st.inputs
            .map((i) => `${i.kind}<-${i.from}(${i.as ?? "history"}${"limit" in i && i.limit ? `, ${i.limit}` : ""})`)
            .join(", ");
          parts.push(`    context in: ${wires}`);
        }
        if (st.kind === "worker") {
          const trig = st.trigger
            ? st.trigger.on === "module-closed"
              ? `when ${st.trigger.from} closes`
              : st.trigger.on === "turns"
                ? `every ${st.trigger.every} turns`
                : st.trigger.on === "after"
                  ? `right after ${st.trigger.from}'s AI answers the player`
                : st.trigger.on === "quiet"
                  ? `after ${st.trigger.seconds}s with nothing happening — speaks into the story itself`
                  : "on conditions"
            : "NEVER (no trigger set — this worker will not run)";
          parts.push(`    runs: ${trig}`);
          parts.push(`    task: ${st.task ? st.task.slice(0, 200) : "NONE SET — this worker will not run"}`);
        }
        if (st.archivePrompt) parts.push(`    archive instruction: ${st.archivePrompt.slice(0, 160)}`);
      }
    }
  }

  // Sticky notes — the creator's notes on the canvas, loose or stuck to one
  // part of the card. They are about the card's DESIGN (never play content):
  // what a part is for, what hand-written code expects, what to do next. Read
  // them as the creator's own instructions about the part they are on.
  const canvasNotes = stickyNotes(world);
  if (canvasNotes.length > 0) {
    parts.push(`\nCANVAS NOTES (${canvasNotes.length}) — the creator's sticky notes on the canvas; one stuck to a part is about that part (treat it as the creator's instruction or explanation for it):`);
    for (const n of canvasNotes) {
      const text = n.text.length > 600 ? n.text.slice(0, 600) + "..." : n.text;
      parts.push(`  - ${n.on ? `[on ${n.on}] ` : ""}${text.replace(/\n/g, " / ")}`);
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
      // Precise = smart tracking writes it after each reply, not the story
      // model — the assistant must know which writer it is tuning.
      const precise = isContinuityOwned(world, v)
        ? ` precise${v.type === "number" ? `(−${v.deltaDown ?? 0}/+${v.deltaUp ?? 0} per turn)` : ""}`
        : "";
      const options = v.type === "string" && v.options?.length ? ` options=[${v.options.join(", ")}]` : "";
      const book = v.worldbookId ? ` book=${v.worldbookId}` : "";
      parts.push(`  ${v.id}: "${v.name}" (${v.type}${scope}, default: ${JSON.stringify(v.defaultValue)})${book}${range}${precise}${options}${desc}${rules}`);
    }
  }

  // Behaviors/Reactions
  const reactions = world.reactions ?? [];
  if (reactions.length > 0) {
    parts.push(`\nBEHAVIORS (${reactions.length}):`);
    for (const r of reactions) {
      const flags = !r.enabled ? " DISABLED" : "";
      const book = r.worldbookId ? ` book=${r.worldbookId}` : "";
      parts.push(`  ${r.id}: "${r.name}" [${r.when.eventType}] priority=${r.priority}${book}${flags}`);
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
    const owned = uiDocOwnedFiles(world);
    parts.push(`\nROOT COMPONENT:`);
    parts.push(`  ${rc.id}: "${rc.name}" entry=${rc.entryFile}`);
    // List each file with its size — agent uses filenames as IDs for read_entities and
    // write_custom_ui, and the size tells it which files to page through rather than read whole.
    for (const fn of fileNames) {
      const code = rc.files[fn] ?? "";
      const kb = Math.max(1, Math.round(code.length / 1024));
      const entryMark = (fn === rc.entryFile ? " (entry)" : "") + (owned.has(fn) ? " (compiled from the interface document — never edit; use edit_ui_doc)" : "");
      const bigMark = code.length > UI_PRELOAD_MAX_FILE_CHARS
        ? " — large; read on demand with grep_world / read_entities(offset_lines)"
        : "";
      parts.push(`    file: "${fn}" [${kb}KB]${entryMark}${bigMark}`);
    }
  }
  // The no-code interface document. One line per page keeps the inventory
  // cheap; read_ui_doc gives the parts.
  if (world.uiDoc) {
    const doc = world.uiDoc;
    const pages = doc.pages.map((p) => `${p.id} "${p.name}" (${p.elements.length} parts)`).join(", ");
    parts.push(`\n界面文档 uiDoc (visual editor — change it with edit_ui_doc after load_skill "ui-doc"; read_ui_doc for parts): entry=${doc.entryPageId}; pages: ${pages}${doc.base ? `; base layer ${doc.base.file}` : ""}${doc.surface ? "; over platform chat" : ""}`);
  }
  // Every migrated world has rootComponent — the customUI[]-only branch that
  // used to live here was removed in the v1→v2 unification.

  // Style knobs of a decomposed base frontend. Listing id + kind + CURRENT
  // value is what makes set_ui_knobs usable in one shot — the agent restyles
  // without reading a line of the base code (and must not edit that code for
  // anything a knob already covers).
  const knobGroups = world.uiDoc?.base?.groups ?? [];
  if (knobGroups.length > 0) {
    const total = knobGroups.reduce((n, g) => n + g.knobs.length, 0);
    parts.push(`\n界面旋钮 (decomposed base styles — edit via set_ui_knobs, ${total} knobs):`);
    for (const g of knobGroups) {
      parts.push(`  [${g.label}]`);
      for (const k of g.knobs) {
        const unit = k.unit ? ` ${k.unit}` : "";
        parts.push(`    ${k.id} (${k.kind}) = ${JSON.stringify(k.value)}${unit} — ${k.label}`);
      }
    }
  } else if (world.uiDoc?.base || (world.rootComponent && world.rootComponent.generatedFrom !== "uiDoc")) {
    // A hand-written frontend with no knobs yet. Naming the path here is what
    // lets "把前端拆成积木" work in one turn instead of a tool-name guessing game.
    parts.push(
      `\n界面旋钮: none yet — this card's hand-written frontend has NOT been decomposed. To make it visually editable (拆积木): rewrite its visual constants to K["…"] via edit_custom_ui and install groups with write_ui_knob_groups, all in ONE reply (see the front-ui skill).`,
    );
  }

  // Audio tracks
  if (world.audioTracks.length > 0) {
    parts.push(`\nAUDIO (${world.audioTracks.length}):`);
    for (const a of world.audioTracks) {
      const note = a.aiNote?.trim() ? ` aiNote: "${a.aiNote.trim().slice(0, 80)}"` : "";
      const manual = a.allowAiControl === false ? " [rules/scripts only]" : "";
      parts.push(`  ${a.id}: "${a.name}" (${a.type})${manual}${note}`);
    }
  }

  // Scene images — what the gameplay AI can show mid-story
  if ((world.sceneImages ?? []).length > 0) {
    parts.push(isSceneImageJudgeOn(world)
      ? `\nSCENE IMAGES (${world.sceneImages!.length}) — after each reply smart tracking checks each image's condition and shows the ones that hold:`
      : `\nSCENE IMAGES (${world.sceneImages!.length}) — smart tracking is off for images; the story model places them with [image: id]:`);
    for (const img of world.sceneImages!) {
      parts.push(`  ${img.id}: "${img.name}" — ${img.scene || "(no scene text yet)"}${img.url ? "" : " [no picture yet]"}${img.allowAiControl === false ? " [manual only]" : ""}`);
    }
  }

  // Scene images — what the gameplay AI can show mid-story
  if ((world.sceneImages ?? []).length > 0) {
    parts.push(`\nSCENE IMAGES (${world.sceneImages!.length}) — the AI shows one with [image: id] when the story matches its scene:`);
    for (const img of world.sceneImages!) {
      parts.push(`  ${img.id}: "${img.name}" — ${img.scene || "(no scene text yet)"}${img.url ? "" : " [no picture yet]"}${img.allowAiControl === false ? " [manual only]" : ""}`);
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
    if (s.narratorVoice) settingParts.push(`narratorVoice=${s.narratorVoice}`);
    if (s.voiceInputMode) settingParts.push(`voiceInputMode=${s.voiceInputMode}`);
    if (settingParts.length > 0) {
      parts.push(`\nSETTINGS: ${settingParts.join(", ")}`);
    }
  }

  // Smart tracking — only worth a line when the author changed a default.
  const c = world.continuity;
  if (c && Object.keys(c).length > 0) {
    const cParts = [`enabled=${isContinuityEnabled(world)}`];
    for (const key of ["bgm", "sfx", "images"] as const) if (c[key] === false) cParts.push(`${key}=false`);
    if (c.music?.overRules) cParts.push("music.overRules");
    if (c.music?.once) cParts.push("music.once");
    if (c.music?.duck === false) cParts.push("music.duck=false");
    parts.push(`\nSMART TRACKING: ${cParts.join(", ")}`);
  }

  return parts.join("\n");
}

// Per-file size cap for force-preloading rootComponent TSX into the system prompt.
// Files at/under this load in full on a UI-related request; larger files are left for
// on-demand reads (grep_world / read_entities with offset_lines) so one huge component
// can't bloat every agent iteration to ~200K tokens. Tunable.
const UI_PRELOAD_MAX_FILE_CHARS = 32 * 1024;

/** The card's interface files worth carrying in a prompt: not too large, and
 *  not ones compiled from the interface document (output, not source). */
function preloadableUIFiles(world: WorldDefinition): CustomUIComponent[] {
  const rc = world.rootComponent;
  if (!rc) return [];
  const owned = uiDocOwnedFiles(world);
  return Object.entries(rc.files)
    .filter(([filename, code]) => code.length <= UI_PRELOAD_MAX_FILE_CHARS && !owned.has(filename))
    .map(([filename, code], i) => ({
      id: filename,
      name: `${rc.name} / ${filename}`,
      // Required by the legacy type; meaningless in v2.
      surface: "app" as const,
      language: "tsx" as const,
      tsxCode: code,
      description: filename === rc.entryFile ? "entry file" : "sub-file",
      order: i,
      visible: true,
      updatedAt: rc.updatedAt,
    }));
}

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

// ── Creator focus ──

/** The canvas ids the creator pointed at, resolved to what they contain.
 *  `entry:` / `greeting:` → that entry; `reaction:` / `rule:` → that rule;
 *  whole blocks → everything of their kind. Variables are already in full in
 *  the inventory, so pointing at one only names it. */
export function resolveFocusSelection(world: WorldDefinition, ids: readonly string[]) {
  const entries: WorldEntry[] = [];
  const behaviors: Reaction[] = [];
  const rules: Rule[] = [];
  let wantUI = false;
  const labels: string[] = [];
  const addEntry = (e: WorldEntry | undefined) => { if (e && !entries.includes(e)) entries.push(e); };
  const reactions = world.reactions ?? [];
  for (const id of ids) {
    const sep = id.indexOf(":");
    const prefix = sep < 0 ? id : id.slice(0, sep);
    const raw = sep < 0 ? "" : id.slice(sep + 1);
    if (prefix === "entry" || prefix === "greeting") {
      const e = world.entries.find((x) => x.id === raw);
      addEntry(e);
      if (e) labels.push(`${e.role === "greeting" ? "opening" : "entry"} "${e.name || e.id}" (${e.id})`);
    } else if (prefix === "var" || prefix === "variable") {
      const v = world.variables.find((x) => x.id === raw);
      if (v) labels.push(`variable "${v.name || v.id}" (${v.id})`);
    } else if (prefix === "reaction") {
      const b = reactions.find((x) => x.id === raw);
      if (b) { behaviors.push(b); labels.push(`behavior "${b.name || b.id}" (${b.id})`); }
    } else if (prefix === "rule") {
      const r = world.rules.find((x) => x.id === raw);
      if (r) { rules.push(r); labels.push(`rule "${r.name || r.id}" (${r.id})`); }
    } else if (prefix === "block") {
      if (/opening/.test(raw)) {
        world.entries.filter((e) => e.role === "greeting").forEach(addEntry);
        labels.push("the openings block (every opening)");
      } else if (/setting|lore/.test(raw)) {
        world.entries.filter((e) => e.role !== "greeting" && e.section !== "system-presets").forEach(addEntry);
        labels.push("the settings block (every lore entry)");
      } else if (/^state/.test(raw)) {
        labels.push("the variables block (every variable, listed in the inventory)");
      } else if (/^behavior/.test(raw)) {
        behaviors.push(...reactions);
        rules.push(...world.rules);
        labels.push("the behaviors block (every behavior)");
      } else if (/^frontend/.test(raw)) {
        wantUI = true;
        labels.push("the player interface (its code)");
      } else {
        labels.push(`block ${raw}`);
      }
    } else if (prefix === "world") {
      labels.push("the card itself (cover, description, settings)");
    }
  }
  return { entries, behaviors, rules, wantUI, labels };
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
    /** Canvas ids the creator pointed at. When set, only these are preloaded
     *  in full: no keyword guessing, no always-on presets, no unrelated code. */
    focusIds?: readonly string[];
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

  if (options.focusIds && options.focusIds.length > 0) {
    const focus = resolveFocusSelection(world, options.focusIds);
    if (focus.labels.length > 0) {
      const ui = focus.wantUI ? preloadableUIFiles(world) : [];
      let preloaded = buildPreloadedContent(world, focus.entries, focus.behaviors, focus.rules, ui);
      let truncated = false;
      let truncationDetail: string | undefined;
      // Whatever does not fit is still one read_entities away.
      if (tokenEstimate + estimateTokens(preloaded) > contextBudget) {
        truncated = true;
        truncationDetail = "The selection is larger than fits; part of it was not preloaded";
        const kept = [...focus.entries];
        while (kept.length > 0 && tokenEstimate + estimateTokens(preloaded) > contextBudget) {
          kept.pop();
          preloaded = buildPreloadedContent(world, kept, focus.behaviors, focus.rules, []);
        }
      }
      return {
        inventory,
        preloadedEntities: preloaded,
        tokenEstimate: tokenEstimate + estimateTokens(preloaded),
        truncated,
        truncationDetail,
        lorebookHealth: computeLorebookHealth(world),
        focus: { labels: focus.labels },
      };
    }
  }

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
  const matchedUI: CustomUIComponent[] = isUIRequest ? preloadableUIFiles(world) : [];

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
