import type {
  WorldDefinition,
  GameState,
  WorldEntry,
  Directive,
} from "../types/index.js";
import { expandMacros } from "./macros.js";
import { estimateTokens } from "./token-utils.js";
import { filterEntriesByActiveWorldbooks } from "../lorebook/worldbook.js";
import { filterEntriesByActiveLoreSlots } from "../lorebook/lore-slot.js";
import { isVariableBoundEntry } from "../lorebook/entry-triggers.js";
import { isAiReadable } from "../state/variable-activation.js";
import { getAiAudioTracks } from "../audio/ai-audio.js";

/** Static (state-free) check: could the AI ever see this variable? Used by the
 *  cached prefix blocks, which must not depend on per-turn activation — the
 *  dynamic <game-state> block applies the full isAiReadable/isAiWritable gate. */
function isAiExposedStatic(v: { internal?: boolean; aiAccess?: "write" | "read" | "none" }): boolean {
  return !v.internal && (v.aiAccess ?? "write") !== "none";
}

/** Static check: may AI directives ever write this variable? */
function isAiWritableStatic(v: { internal?: boolean; aiAccess?: "write" | "read" | "none" }): boolean {
  return !v.internal && (v.aiAccess ?? "write") === "write";
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/**
 * A user-defined global prompt that gets injected into the prompt assembly.
 * These are additive — they never override world entries, they append after them
 * in the same section.
 */
export interface UserPrompt {
  id: string;
  name: string;
  content: string;
  section: WorldEntry["section"];
  position?: number;
  enabled: boolean;
  /** Depth value for "chat-history" section — how many messages from the end to inject. */
  depth?: number;
}
/** Escape special regex characters in a string */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Sort entries by position (ascending numeric) */
function entrySort(a: WorldEntry, b: WorldEntry): number {
  const aPos = a.position ?? Infinity;
  const bPos = b.position ?? Infinity;
  return aPos - bPos;
}

// ─── Variable-value sanitization for prompt injection ───────────────────────
// Game-state variables are echoed into every prompt's <game-state> block so the
// model can see current state. But a customUI can write arbitrary blobs into a
// declared variable via api.setVariable — most damagingly a base64 `data:` image
// (e.g. a portrait-upload feature that stores readAsDataURL output instead of an
// asset URL). A single 2 MB photo then balloons the prompt past the model's
// context window and EVERY generation 400s ("context length exceeded"). The
// image bytes are useless to the model anyway. So before serializing a value
// into the prompt we strip data: URIs and cap pathologically long values —
// always on a COPY, never mutating the stored state (the customUI still reads
// the real value client-side, so on-screen portraits are unaffected).

/** A single string field longer than this is replaced wholesale (raw blobs). */
const PROMPT_STRING_MAX_CHARS = 20_000;
/** A whole rendered variable longer than this is replaced wholesale (backstop). */
const PROMPT_VAR_MAX_CHARS = 50_000;
/** Matches `data:<mime>;base64,<payload>` data URIs (e.g. inline images). */
const DATA_URI_RE = /data:[\w.+-]+\/[\w.+-]+;base64,[A-Za-z0-9+/=\s]*/g;

/** Strip inline data: URIs and over-long blobs from a single string value. */
function sanitizePromptString(s: string): string {
  const stripped = s.replace(DATA_URI_RE, "[image omitted]");
  if (stripped.length > PROMPT_STRING_MAX_CHARS) {
    return `[omitted ${stripped.length} chars]`;
  }
  return stripped;
}

/** Recursively sanitize a value for prompt injection. Returns a sanitized COPY;
 *  object keys/structure are preserved so the model still sees which fields
 *  exist, only oversized/image string values are replaced. */
function sanitizePromptValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizePromptString(value);
  if (Array.isArray(value)) return value.map(sanitizePromptValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizePromptValue(v);
    return out;
  }
  return value;
}

/** Render a single variable value for the <game-state> block, with sanitization. */
function renderVariableValueForPrompt(value: unknown): string {
  let rendered: string;
  if (value !== null && typeof value === "object") {
    // JSON-typed variables stringify so the AI can target sub-fields by dot-path.
    rendered = JSON.stringify(sanitizePromptValue(value));
  } else if (typeof value === "string") {
    rendered = sanitizePromptString(value);
  } else {
    rendered = String(value);
  }
  if (rendered.length > PROMPT_VAR_MAX_CHARS) {
    return `[large value omitted: ${rendered.length} chars]`;
  }
  return rendered;
}

/** One persisted variable change from a previous turn (directive, behavior, or
 *  seed write) — the shape GameStateManager.applyEffects reports and the server
 *  stores on each assistant message. */
export interface VariableChange {
  variableId: string;
  oldValue?: unknown;
  newValue?: unknown;
}

/** A change-line value is context, not state — cap it much harder than the
 *  <game-state> values so a json blob can't double the dynamic tail. */
const CHANGE_VALUE_MAX_CHARS = 160;
/** Bound the whole block on pathological turns (mass merge / seed writes). */
const MAX_CHANGE_LINES = 12;

function renderChangeValueForPrompt(value: unknown): string {
  const rendered = renderVariableValueForPrompt(value);
  return rendered.length > CHANGE_VALUE_MAX_CHARS
    ? `${rendered.slice(0, CHANGE_VALUE_MAX_CHARS)}…`
    : rendered;
}

/**
 * Composes LLM prompts from world definition + current state.
 * Uses the unified WorldEntry[] model — entries are grouped by position slot,
 * sorted by priority DESC within each slot, and concatenated.
 */
export class PromptBuilder {
  /**
   * Build the system prompt from world entries.
   * @param world The world definition with entries[]
   * @param state Current game state
   * @param matchedEntries Triggered entries from the matcher (keyword/vector matched)
   * @param userPrompts User-defined global prompts
   * @param directives Active directives from rules (injected at configured positions)
   * @param toggledEntries Entry enabled/disabled overrides from rules
   */
  buildSystemPrompt(
    world: WorldDefinition,
    state: GameState,
    matchedEntries?: WorldEntry[],
    userPrompts?: UserPrompt[],
    directives?: Directive[],
    toggledEntries?: Record<string, boolean>
  ): string {
    const entries = this.collectEntries(world, matchedEntries, userPrompts, toggledEntries, state);
    return this.assemblePrompt(world, state, entries, directives);
  }

  /**
   * Find and interpolate the greeting entry.
   */
  buildGreeting(world: WorldDefinition, state: GameState): string {
    const greetingEntry = world.entries.find(
      (e) => e.role === "greeting" && e.enabled
    );
    if (!greetingEntry) return "";
    return this.interpolate(greetingEntry.content, world, state);
  }

  /**
   * Find and interpolate ALL enabled greeting entries, sorted by order.
   * Returns an array of interpolated greeting strings.
   */
  buildGreetings(world: WorldDefinition, state: GameState): string[] {
    return world.entries
      .filter((e) => e.role === "greeting" && e.enabled)
      .sort(entrySort)
      .map((e) => this.interpolate(e.content, world, state));
  }

  /** The ordered greeting ENTRIES (same filter + entrySort order as
   *  buildGreetings), so callers can read per-greeting metadata — e.g.
   *  initialVariables for "scenario presets" — aligned index-for-index with
   *  the strings buildGreetings returns. */
  buildGreetingEntries(world: WorldDefinition): WorldEntry[] {
    return world.entries
      .filter((e) => e.role === "greeting" && e.enabled)
      .sort(entrySort);
  }

  /**
   * Get depth entries for in-chat injection.
   * Returns entries with their depth value and apiRole for the message router to place.
   */
  buildDepthEntries(
    world: WorldDefinition,
    state: GameState,
    matchedEntries?: WorldEntry[],
    userPrompts?: UserPrompt[],
    toggledEntries?: Record<string, boolean>,
    preCollected?: WorldEntry[]
  ): { content: string; depth: number; apiRole: "system" | "user" | "assistant" }[] {
    const allEntries = preCollected ?? this.collectEntries(world, matchedEntries, userPrompts, toggledEntries, state);
    return allEntries
      .filter((e) => e.section === "chat-history" && e.depth !== undefined)
      .sort(entrySort)
      .map((e) => ({
        content: this.interpolate(e.content, world, state),
        depth: e.depth!,
        apiRole: (e.apiRole ?? "system") as "system" | "user" | "assistant",
      }));
  }

  /**
   * Get post-history entries (jailbreak / post-history instructions).
   * These go AFTER all chat history as the final messages before AI responds.
   * Returns content with apiRole so entries can be sent as assistant/user prefill.
   */
  buildPostHistoryEntries(
    world: WorldDefinition,
    state: GameState,
    matchedEntries?: WorldEntry[],
    userPrompts?: UserPrompt[],
    preCollected?: WorldEntry[]
  ): { content: string; apiRole: "system" | "user" | "assistant" }[] {
    const allEntries = preCollected ?? this.collectEntries(world, matchedEntries, userPrompts, undefined, state);
    return allEntries
      .filter((e) => e.section === "post-history")
      .sort(entrySort)
      .map((e) => ({
        content: this.interpolate(e.content, world, state),
        apiRole: (e.apiRole ?? "system") as "system" | "user" | "assistant",
      }));
  }

  /**
   * Build the STATIC format reference block — behavior rules, directive syntax, audio tracks.
   * These are per-world constants that never change between turns.
   * Designed to be placed in the system prefix (cacheable).
   */
  buildStaticFormatBlock(world: WorldDefinition): string {
    const hasVariables = world.variables.length > 0;
    const audioTracks = getAiAudioTracks(world.audioTracks ?? []);
    const hasAudio = audioTracks.length > 0;

    if (!hasVariables && !hasAudio) return "";

    const parts: string[] = [];

    // Behavior rules section — variables with detailed AI instructions
    const behaviorRulesSection = this.buildBehaviorRulesSection(world);
    if (behaviorRulesSection) {
      parts.push(`<behavior-rules>\n${behaviorRulesSection}\n</behavior-rules>`);
    }

    // Directive syntax is only worth teaching when the AI may actually write
    // something. A card whose variables are all engine-owned (aiAccess read/
    // none) skips the whole block — fewer tokens, and no invitation to emit
    // directives that would just be dropped.
    const hasWritableVariables = world.variables.some(isAiWritableStatic);
    if (hasWritableVariables) {
      const hasJsonVar = world.variables.some(
        (v) => v.type === "json" && isAiWritableStatic(v)
      );
      const lines = [
        "<directive-format>",
        "State changes ONLY happen through directives. Describing a change in prose alone does nothing.",
        "",
        "Format: [variableId: operation value]",
        "",
        'Numbers:   [hp: -10]   [gold: +50]   [score: *2]',
        'Strings:   [location: set "forest"]   [log: append ", found the key"]',
        'Booleans:  [hasKey: toggle]   [armed: set true]',
        "",
        // `append` was supported by the engine but absent here, so a card whose
        // string variable is a running list left the model no legal way to add
        // to it. It reached for `add`, which is a silent no-op on strings, and
        // the variable simply never moved. Spell both halves out.
        "To extend a string, use `append` — `add` only works on numbers and is",
        "ignored on a string. `append` concatenates exactly what you pass, so put",
        'any separator inside the value: [items: append ", rope"].',
      ];
      if (hasJsonVar) {
        lines.push(
          "",
          "JSON variables — use dot-paths to target nested fields:",
          '  [npcs.aria.affinity: +3]               number at a nested path',
          '  [npcs.aria.mood: set "happy"]          string at a nested path',
          '  [npcs.aria: merge {"trust": 80}]       patch several fields at once',
          '  [inventory: push {"name": "Sword"}]    append to a JSON array',
          '  [npcs: delete "aria"]                  remove a key from an object',
          '  [inventory: delete 0]                  remove element at index 0',
          "",
          "JSON values must use double quotes around keys and strings."
        );
      }
      lines.push(
        "",
        "Put all directives at the END of your reply, after the narrative.",
        "</directive-format>"
      );
      parts.push(lines.join("\n"));
    }

    if (hasAudio) {
      const trackList = audioTracks
        .map((t) => `  - ${t.id} (${t.type}): ${t.name}`)
        .join("\n");
      parts.push(
        `<audio>\nAvailable audio tracks:\n${trackList}\n\n` +
        "To trigger audio, use: [audio: trackId action]\n" +
        "Examples: [audio: battle_bgm play], [audio: tavern_ambient stop]\n" +
        "</audio>"
      );
    }

    return parts.join("\n\n");
  }

  /**
   * Build the DYNAMIC game-state block — current variable values plus a short
   * per-turn reminder to emit update directives. Sits in the dynamic tail
   * (uncached), nearest the generation point, so the call-to-action lands where
   * the model's recall is strongest.
   *
   * The directive SYNTAX (and all `[...]` examples) stays in the cached prefix
   * (buildStaticFormatBlock); this block only re-states the *action*. With many
   * variables the model tends to skip updates because the "how/when" instructions
   * are thousands of tokens up in the cached prefix and the tail shows only a
   * passive wall of values — this anchors a fresh "now update what changed" nudge
   * right next to those values.
   *
   * Two deliberate safety choices:
   *  - The reminder contains NO literal `[id: op value]` examples. Models echo the
   *    <game-state> block verbatim (see ThinkingTagFilter ECHOED_TAGS); a literal
   *    bracket example could be mirrored back and then parsed as a real directive
   *    by ResponseParser — and a dot-path example like `[npcs.x: set ...]` would
   *    bypass the unknown-variable guard in GameStateManager and corrupt state.
   *    Prose-only here means nothing parseable can ever survive an echo.
   *  - The reminder is wrapped in its own <state-reminder> tag, also registered in
   *    ECHOED_TAGS, so if a model mirrors the tail it gets stripped from the reply
   *    instead of leaking instruction text into the narrative.
   */
  buildFormatBlock(
    world: WorldDefinition,
    state: GameState,
    lastTurnChanges?: VariableChange[],
  ): string {
    if (world.variables.length === 0) return "";

    const varSummary = this.buildVariableSummary(world, state);
    if (!varSummary) return "";

    // JSON vars render as a whole stringified object above, so the model tends to
    // re-set the entire blob (wasteful, clobbers sibling sub-fields) or skip a
    // nested change entirely. Mirror the `hasJsonVar` gate used in the cached
    // directive-format block and nudge dot-path targeting — only for cards that
    // actually have a json variable, so non-json cards pay zero extra tokens.
    // Prose only: no literal bracket example (see method doc).
    const hasJsonVar = world.variables.some(
      (v) => v.type === "json" && isAiReadable(v, state)
    );
    const jsonClause = hasJsonVar
      ? " For JSON variables, target the specific changed sub-field with a dot-path rather than rewriting the whole object."
      : "";

    // What already changed last turn — the model's own directives AND engine-side
    // behavior writes, which it otherwise can't distinguish from values that were
    // always that way (directives are stripped from stored history). Gives it a
    // bookkeeping trace ("the +1 already happened") and lets it narrate engine
    // changes ("day rolled over") without a tell-AI hack. Same prose-only /
    // echo-suppressed rules as the blocks around it: the tag is registered in
    // ThinkingTagFilter ECHOED_TAGS, and lines use `→`, not directive syntax.
    const changesBlock = this.buildLastTurnChangesBlock(world, state, lastTurnChanges);
    const changesClause = changesBlock
      ? " The last-turn-changes block lists what ALREADY changed on the previous turn — treat those as done; do not re-apply them."
      : "";

    return (
      `<game-state>\n${varSummary}\n</game-state>\n` +
      changesBlock +
      "<state-reminder>\n" +
      "The block above is the current state. After your narrative, output a state-change " +
      "directive for every value that changed this turn — and only those." +
      jsonClause +
      changesClause +
      "\n</state-reminder>"
    );
  }

  /**
   * Render persisted last-turn changes as `id: old → new` lines. Collapses
   * multiple writes to the same variable into first-old → last-new, hides
   * engine-internal variables, and drops lines whose rendered old/new are
   * identical (sub-field churn inside an omitted blob). Returns "" when
   * nothing survives so callers pay zero tokens on quiet turns.
   */
  private buildLastTurnChangesBlock(
    world: WorldDefinition,
    state: GameState,
    changes?: VariableChange[],
  ): string {
    if (!changes || changes.length === 0) return "";

    const byId = new Map<string, { oldValue: unknown; newValue: unknown }>();
    for (const ch of changes) {
      if (!ch || typeof ch.variableId !== "string") continue;
      const rootId = ch.variableId.split(".")[0]!;
      const variable = world.variables.find((v) => v.id === rootId);
      // Same visibility gate as <game-state>: a change the AI can't see the
      // variable for would just be confusing bookkeeping noise.
      if (!variable || !isAiReadable(variable, state)) continue;
      const prev = byId.get(rootId);
      byId.set(rootId, {
        oldValue: prev ? prev.oldValue : ch.oldValue,
        newValue: ch.newValue,
      });
    }

    const lines: string[] = [];
    for (const [id, { oldValue, newValue }] of byId) {
      const oldRendered = renderChangeValueForPrompt(oldValue);
      const newRendered = renderChangeValueForPrompt(newValue);
      if (oldRendered === newRendered) continue;
      lines.push(`${id}: ${oldRendered} → ${newRendered}`);
    }
    if (lines.length === 0) return "";

    const shown = lines.slice(0, MAX_CHANGE_LINES);
    if (lines.length > shown.length) {
      shown.push(`(+${lines.length - shown.length} more)`);
    }
    return `<last-turn-changes>\n${shown.join("\n")}\n</last-turn-changes>\n`;
  }

  /**
   * Build system prompt as SEPARATE messages — one per position slot.
   * Matches SillyTavern's multi-message approach for better LLM attention.
   * Each position slot (top, before_char, character, after_char, persona, bottom)
   * becomes its own system message instead of being concatenated into one blob.
   */
  buildSystemMessages(
    world: WorldDefinition,
    state: GameState,
    matchedEntries?: WorldEntry[],
    userPrompts?: UserPrompt[],
    directives?: Directive[],
    toggledEntries?: Record<string, boolean>,
    preCollected?: WorldEntry[]
  ): ChatMessage[] {
    const entries = preCollected ?? this.collectEntries(world, matchedEntries, userPrompts, toggledEntries, state);
    const result: ChatMessage[] = [];
    const activeDirectives = directives ?? [];

    const getDirectivesForPosition = (pos: string) =>
      activeDirectives
        .filter((d) => d.position === pos)
        .map((d) => this.interpolate(d.content, world, state));

    const autoDirectives = activeDirectives
      .filter((d) => d.position === "auto")
      .map((d) => this.interpolate(d.content, world, state));

    // Collect system-presets entries (not chat-history, post-history, or examples with keyword triggers)
    const systemEntries = entries
      .filter((e) => {
        if (e.section === "chat-history" || e.section === "post-history") return false;
        if (e.role === "example" || e.role === "greeting") return false;
        return true;
      })
      .sort(entrySort);

    const systemParts: string[] = [];

    // Top directives go before all entries
    systemParts.push(...getDirectivesForPosition("top"));
    systemParts.push(...getDirectivesForPosition("before_char"));

    for (const entry of systemEntries) {
      const content = this.interpolate(entry.content, world, state);
      const effectiveApiRole = entry.apiRole ?? "system";

      if (effectiveApiRole === "system") {
        systemParts.push(content);
      } else {
        // Flush accumulated system parts before emitting non-system message
        if (systemParts.length > 0) {
          result.push({ role: "system", content: systemParts.join("\n\n") });
          systemParts.length = 0;
        }
        result.push({ role: effectiveApiRole, content });
      }
    }

    // after_char and auto directives go after entries
    systemParts.push(...getDirectivesForPosition("after_char"));
    systemParts.push(...autoDirectives);
    systemParts.push(...getDirectivesForPosition("bottom"));

    if (systemParts.length > 0) {
      result.push({ role: "system", content: systemParts.join("\n\n") });
    }

    return result;
  }

  /**
   * Build system messages from KEYWORD-TRIGGERED entries only (alwaysSend=false).
   * Produces messages for entries whose section is neither chat-history nor post-history,
   * and whose role is neither example nor greeting — i.e. entries that belong in the
   * system block but were gated by keyword matching.
   *
   * These messages are dynamic (change when different keywords fire), so callers should
   * place them AFTER the stable alwaysSend prefix to preserve prompt caching on the prefix.
   */
  buildTriggeredSystemMessages(
    world: WorldDefinition,
    state: GameState,
    triggeredEntries: WorldEntry[],
    toggledEntries?: Record<string, boolean>
  ): ChatMessage[] {
    const isEnabled = (e: WorldEntry) => {
      if (toggledEntries && e.id in toggledEntries) return toggledEntries[e.id];
      return e.enabled;
    };

    const systemTriggered = triggeredEntries
      .filter((e) => {
        if (!isEnabled(e)) return false;
        // Variable-bound entries are condition-gated by the matcher; a stale
        // alwaysSend=true on them (e.g. clobbered by an old bundle import)
        // must not drop a legitimately triggered entry here.
        if (e.alwaysSend && !isVariableBoundEntry(e)) return false;
        if (e.section === "chat-history" || e.section === "post-history") return false;
        if (e.role === "example" || e.role === "greeting") return false;
        return true;
      })
      .sort(entrySort);

    if (systemTriggered.length === 0) return [];

    const result: ChatMessage[] = [];
    const systemParts: string[] = [];

    for (const entry of systemTriggered) {
      const content = this.interpolate(entry.content, world, state);
      const effectiveApiRole = entry.apiRole ?? "system";

      if (effectiveApiRole === "system") {
        systemParts.push(content);
      } else {
        if (systemParts.length > 0) {
          result.push({ role: "system", content: systemParts.join("\n\n") });
          systemParts.length = 0;
        }
        result.push({ role: effectiveApiRole, content });
      }
    }

    if (systemParts.length > 0) {
      result.push({ role: "system", content: systemParts.join("\n\n") });
    }

    return result;
  }

  /**
   * Build example dialogue messages from entries with role "example".
   * Parses SillyTavern's mes_example format (<START>\n{{user}}: ...\n{{char}}: ...)
   * into actual user/assistant message pairs with [Example Chat] markers.
   */
  buildExampleMessages(
    world: WorldDefinition,
    state: GameState,
    matchedEntries?: WorldEntry[],
    userPrompts?: UserPrompt[],
    toggledEntries?: Record<string, boolean>,
    preCollected?: WorldEntry[]
  ): ChatMessage[] {
    const entries = preCollected ?? this.collectEntries(world, matchedEntries, userPrompts, toggledEntries, state);
    const exampleEntries = entries
      .filter((e) => e.role === "example")
      .sort(entrySort);

    if (exampleEntries.length === 0) return [];

    const result: ChatMessage[] = [];
    const charName = this.resolveCharName(world);
    const userName = world.settings?.playerName || "User";

    for (const entry of exampleEntries) {
      const text = this.interpolate(entry.content, world, state);
      const parsed = this.parseExampleDialogue(text, charName, userName);

      if (parsed.length > 0) {
        result.push({ role: "system", content: "[Example Chat]" });
        result.push(...parsed);
      }
    }

    return result;
  }

  /**
   * Parse a mes_example-format string into user/assistant message pairs.
   * Handles: <START>\n{{user}}: text\n{{char}}: text
   * Also handles: {{user}}: text\n{{char}}: text (no <START>)
   */
  private parseExampleDialogue(text: string, charName: string, userName: string): ChatMessage[] {
    const result: ChatMessage[] = [];
    // Split on <START> to get individual example blocks
    const blocks = text.split(/<START>/i).filter((b) => b.trim());

    for (const block of blocks) {
      const lines = block.split("\n");
      let currentRole: "user" | "assistant" | null = null;
      let currentContent: string[] = [];

      const flush = () => {
        if (currentRole && currentContent.length > 0) {
          result.push({ role: currentRole, content: currentContent.join("\n").trim() });
        }
        currentContent = [];
      };

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Check for {{user}}: or {{char}}: or actual name: prefixes
        const userMatch = trimmed.match(new RegExp(`^(?:\\{\\{user\\}\\}|${escapeRegex(userName)}):\\s*(.*)`, "i"));
        const charMatch = trimmed.match(new RegExp(`^(?:\\{\\{char\\}\\}|${escapeRegex(charName)}):\\s*(.*)`, "i"));

        if (userMatch) {
          flush();
          currentRole = "user";
          if (userMatch[1]) currentContent.push(userMatch[1]);
        } else if (charMatch) {
          flush();
          currentRole = "assistant";
          if (charMatch[1]) currentContent.push(charMatch[1]);
        } else if (currentRole) {
          currentContent.push(trimmed);
        }
      }
      flush();
    }

    return result;
  }

  /** Resolve the character name from world entries */
  private resolveCharName(world: WorldDefinition): string {
    const charEntry = world.entries.find(
      (e) => e.role === "character" && e.enabled
    );
    return charEntry?.name || world.name || "Character";
  }

  /**
   * Trim messages to fit within a token budget.
   * Pinned prefix (system prompts, persona, examples) and pinned suffix
   * (format block, post-history) are always kept. Only the middle portion
   * (chat history + depth entries) is trimmed from oldest first.
   *
   * @param pinnedPrefix Number of messages at the start to always keep
   * @param pinnedSuffix Number of messages at the end to always keep
   * @param modelId Optional model id so the budget uses the right tokenizer
   *                (CJK-aware for Gemini/Claude, cl100k_base otherwise)
   */
  buildMessageHistory(
    messages: ChatMessage[],
    maxTokens?: number,
    pinnedPrefix?: number,
    pinnedSuffix?: number,
    modelId?: string
  ): ChatMessage[] {
    const steps = this.messageHistorySteps(messages, maxTokens, pinnedPrefix, pinnedSuffix, modelId);
    let step = steps.next();
    while (!step.done) step = steps.next();
    return step.value;
  }

  /** Same trimming decisions as the synchronous API, with a host-supplied
   * scheduler so long histories cannot monopolize the server's request loop. */
  async buildMessageHistoryAsync(
    messages: ChatMessage[],
    yieldControl: () => Promise<unknown>,
    maxTokens?: number,
    pinnedPrefix?: number,
    pinnedSuffix?: number,
    modelId?: string,
  ): Promise<ChatMessage[]> {
    const steps = this.messageHistorySteps(messages, maxTokens, pinnedPrefix, pinnedSuffix, modelId);
    let deadline = performance.now() + 8;
    let step = steps.next();
    while (!step.done) {
      if (performance.now() >= deadline) {
        await yieldControl();
        deadline = performance.now() + 8;
      }
      step = steps.next();
    }
    return step.value;
  }

  private *messageHistorySteps(
    messages: ChatMessage[],
    maxTokens?: number,
    pinnedPrefix?: number,
    pinnedSuffix?: number,
    modelId?: string,
  ): Generator<void, ChatMessage[], void> {
    if (!maxTokens || messages.length === 0) return [...messages];

    const pPrefix = pinnedPrefix ?? 0;
    const pSuffix = pinnedSuffix ?? 0;

    // Split into pinned prefix, trimmable history, and pinned suffix
    const prefix = messages.slice(0, pPrefix);
    const suffix = pSuffix > 0 ? messages.slice(messages.length - pSuffix) : [];
    const history = messages.slice(pPrefix, pSuffix > 0 ? messages.length - pSuffix : undefined);

    // Budget consumed by pinned messages (always included)
    let pinnedTokens = 0;
    for (const msg of prefix) {
      pinnedTokens += estimateTokens(msg.content, modelId);
      yield;
    }
    for (const msg of suffix) {
      pinnedTokens += estimateTokens(msg.content, modelId);
      yield;
    }

    const historyBudget = maxTokens - pinnedTokens;

    if (historyBudget <= 0 || history.length === 0) {
      return [...prefix, ...suffix];
    }

    // Trim history from oldest, keeping most recent messages
    const trimmed: ChatMessage[] = [];
    let totalTokens = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i]!;
      const msgTokens = estimateTokens(msg.content, modelId);
      yield;
      if (totalTokens + msgTokens > historyBudget && trimmed.length > 0) break;
      totalTokens += msgTokens;
      trimmed.unshift(msg);
    }

    return [...prefix, ...trimmed, ...suffix];
  }

  /**
   * Collect all relevant entries: alwaysSend + matched.
   * Includes all positions — callers filter by position as needed.
   * @param toggledEntries Runtime overrides from toggle-entry rule actions
   */
  collectEntries(
    world: WorldDefinition,
    matchedEntries?: WorldEntry[],
    userPrompts?: UserPrompt[],
    toggledEntries?: Record<string, boolean>,
    state?: GameState,
  ): WorldEntry[] {
    // Helper: check if an entry is enabled (with toggle overrides)
    const isEnabled = (e: WorldEntry) => {
      if (toggledEntries && e.id in toggledEntries) return toggledEntries[e.id];
      return e.enabled;
    };

    const alwaysSend = world.entries.filter(
      (e) =>
        isEnabled(e) &&
        e.alwaysSend &&
        // Variable-bound entries are gated by their conditions (evaluated in
        // the lorebook matcher) and reach the prompt via matchedEntries only.
        // Without this guard an entry whose alwaysSend was clobbered to true
        // (bundle import used to do this) bypasses its conditions every turn
        // — mirror of lorebook-matcher.ts's alwaysSend bucket check.
        !isVariableBoundEntry(e) &&
        e.role !== "greeting"
    );

    // Merge matched entries (deduplicate by id)
    const seenIds = new Set(alwaysSend.map((e) => e.id));
    const matched = (matchedEntries ?? []).filter(
      (e) =>
        isEnabled(e) &&
        e.role !== "greeting" &&
        !seenIds.has(e.id)
    );

    // Convert user prompts to synthetic WorldEntry objects
    const userEntries: WorldEntry[] = (userPrompts ?? [])
      .filter((p) => p.enabled && p.content.trim())
      .map((p, i) => ({
        id: `user-prompt-${p.id}`,
        name: p.name,
        content: p.content,
        role: "custom" as const,
        position: p.position ?? (10000 + i),
        alwaysSend: true,
        keywords: [],
        conditions: [],
        conditionLogic: "all" as const,
        enabled: true,
        section: p.section,
        ...(p.section === "chat-history" && p.depth !== undefined && { depth: p.depth }),
      }));

    const merged = [...alwaysSend, ...matched, ...userEntries];

    // OUTER GATE — worldbook activation. A worldbook bound to a greeting (or to
    // variable conditions) is the FIRST-priority filter: entries belonging to an
    // inactive worldbook are dropped here, BEFORE alwaysSend/keyword/condition
    // logic has any say. So `alwaysSend` means "always send WHILE this entry's
    // worldbook is active" (e.g. only in the chosen opening), not globally. User
    // prompts carry no worldbookId → treated as Core → always kept. No-op for
    // cards without worldbooks, or when no state is supplied (full back-compat).
    if (!state) return merged;
    // OUTER GATE 1 — worldbook activation (see above).
    const afterWorldbooks = filterEntriesByActiveWorldbooks(merged, world.worldbooks, state);
    // OUTER GATE 2 — frontend lore bindings. An entry wired to a <LoreSlot> /
    // <LoreButton> is only eligible while the PLAYER has toggled that slot on
    // (state.metadata.activeLoreSlots). Without this, a bound entry's own
    // alwaysSend/keywords leak it into the prompt before the player ever clicks
    // — e.g. the AI revealing a "secret codex"暗号 unprompted.
    return filterEntriesByActiveLoreSlots(afterWorldbooks, world.loreUiBindings, state);
  }

  /**
   * Assemble the final prompt string from collected entries.
   */
  private assemblePrompt(
    world: WorldDefinition,
    state: GameState,
    entries: WorldEntry[],
    directives?: Directive[]
  ): string {
    const parts: string[] = [];
    const activeDirectives = directives ?? [];

    // Helper: get directives for a specific position
    const getDirectivesForPosition = (pos: string) =>
      activeDirectives
        .filter((d) => d.position === pos)
        .map((d) => this.interpolate(d.content, world, state));

    // "auto" position directives go after entries
    const autoDirectives = activeDirectives
      .filter((d) => d.position === "auto")
      .map((d) => this.interpolate(d.content, world, state));

    // Top directives before all entries
    parts.push(...getDirectivesForPosition("top"));
    parts.push(...getDirectivesForPosition("before_char"));

    // Collect system-presets entries (not chat-history, post-history, or greeting/example roles)
    const systemEntries = entries
      .filter((e) => {
        if (e.section === "chat-history" || e.section === "post-history") return false;
        if (e.role === "greeting" || e.role === "example") return false;
        return true;
      })
      .sort(entrySort);

    for (const entry of systemEntries) {
      parts.push(this.interpolate(entry.content, world, state));
    }

    // Directives after entries
    parts.push(...getDirectivesForPosition("after_char"));
    parts.push(...autoDirectives);
    parts.push(...getDirectivesForPosition("bottom"));

    return parts.join("\n\n");
  }

  private interpolate(template: string, world: WorldDefinition, state: GameState): string {
    return expandMacros(template, world, state);
  }

  /**
   * Build a compact variable summary for the dynamic game-state block.
   * Shows ALL variables as ID: value pairs — gives the AI a complete picture
   * of current state every turn. Behavior-rules in the cached prefix teaches
   * what each ID means; this block just shows the values.
   */
  private buildVariableSummary(
    world: WorldDefinition,
    state: GameState
  ): string {
    if (world.variables.length === 0) return "";

    return world.variables
      // Full AI-visibility gate: internal, aiAccess "none" and currently
      // inactive variables (enable gate / conditions / greeting) never render.
      .filter((v) => isAiReadable(v, state))
      .map((v) => {
        const value = state.variables[v.id] ?? v.defaultValue;
        // Sanitize before injecting: strips inline base64 images / oversized blobs
        // that a customUI may have stashed in a variable (see renderVariableValueForPrompt).
        // JSON-typed objects are stringified so the AI can target sub-fields by dot-path.
        // Read-only vars are labeled so the model narrates them without trying
        // to write them (directives targeting them are dropped server-side).
        const suffix = v.aiAccess === "read" ? " (read-only)" : "";
        return `${v.id}: ${renderVariableValueForPrompt(value)}${suffix}`;
      })
      .join("\n");
  }


  /**
   * Build the "Variable behavior rules" section for variables that have rules.
   * `updateHints` is the pre-rename field name; we read it as a fallback so
   * worlds exported before the rename still expose their rules to the LLM.
   */
  private buildBehaviorRulesSection(world: WorldDefinition): string {
    const lines: string[] = [];
    for (const v of world.variables) {
      // Engine-only variables never surface their rules to the AI. (Static
      // block — activation is per-turn, so currently-inactive vars keep their
      // rules here for cache stability; the dynamic block gates their values.)
      if (!isAiExposedStatic(v)) continue;
      const rules = v.behaviorRules || v.updateHints;
      if (rules) {
        // Compact header: [id | display-name] or just [id] if they match
        const header = v.id !== v.name ? `[${v.id} | ${v.name}]` : `[${v.id}]`;
        lines.push(header);
        lines.push(rules);
      }
    }
    if (lines.length === 0) return "";
    return lines.join("\n");
  }

  /**
   * Build a static cost breakdown of the world's prompt.
   * Only includes always-send + enabled entries (no matched entries —
   * this is a design-time analysis, not a runtime one).
   */
  buildPromptCostBreakdown(
    world: WorldDefinition,
    state: GameState,
  ): PromptCostBreakdown {
    const blocks: PromptCostBlock[] = [];

    // Entries grouped by section
    const alwaysSendEntries = world.entries.filter(
      (e) => e.enabled && e.alwaysSend && !isVariableBoundEntry(e) && e.role !== "greeting"
    );

    // System-presets entries
    const systemEntries = alwaysSendEntries
      .filter((e) => e.section !== "chat-history" && e.section !== "post-history" && e.role !== "example")
      .sort(entrySort);

    for (const entry of systemEntries) {
      const text = this.interpolate(entry.content, world, state);
      blocks.push({
        label: entry.name || `Entry (${entry.section})`,
        category: "entry",
        tokens: estimateTokens(text),
        chars: text.length,
      });
    }

    // Depth entries (chat-history section)
    const depthEntries = alwaysSendEntries
      .filter((e) => e.section === "chat-history")
      .sort(entrySort);

    for (const entry of depthEntries) {
      const text = this.interpolate(entry.content, world, state);
      blocks.push({
        label: entry.name || "Depth Entry",
        category: "entry",
        tokens: estimateTokens(text),
        chars: text.length,
      });
    }

    // Post-history entries
    const postHistoryEntries = alwaysSendEntries
      .filter((e) => e.section === "post-history")
      .sort(entrySort);

    for (const entry of postHistoryEntries) {
      const text = this.interpolate(entry.content, world, state);
      blocks.push({
        label: entry.name || "Post-History",
        category: "entry",
        tokens: estimateTokens(text),
        chars: text.length,
      });
    }

    // Variable summary
    const varSummary = this.buildVariableSummary(world, state);
    if (varSummary) {
      const fullText = `Current game state:\n${varSummary}`;
      blocks.push({
        label: "Variable Summary",
        category: "variable-summary",
        tokens: estimateTokens(fullText),
        chars: fullText.length,
      });
    }

    // Format instructions (approximate — actual text is built dynamically in buildFormatBlock)
    const formatText =
      "IMPORTANT — Variable directives are the ONLY way to change game state.\n" +
      "Directive format: [variableId: operation value]\n" +
      'Examples: [health: -10], [gold: +50], [location: set "forest"], [hasKey: toggle]';

    blocks.push({
      label: "Directive Format Instructions",
      category: "format-instructions",
      tokens: estimateTokens(formatText),
      chars: formatText.length,
    });

    // Behavior rules section
    const behaviorRulesSection = this.buildBehaviorRulesSection(world);
    if (behaviorRulesSection) {
      blocks.push({
        label: "Variable Behavior Rules",
        category: "variable-summary",
        tokens: estimateTokens(behaviorRulesSection),
        chars: behaviorRulesSection.length,
      });
    }

    // Audio instructions
    const audioTracks = getAiAudioTracks(world.audioTracks ?? []);
    if (audioTracks.length > 0) {
      const trackList = audioTracks
        .map((t) => `  - ${t.id} (${t.type}): ${t.name}`)
        .join("\n");
      const audioText = `Available audio tracks:\n${trackList}`;
      blocks.push({
        label: "Audio Instructions",
        category: "audio-instructions",
        tokens: estimateTokens(audioText),
        chars: audioText.length,
      });
    }

    const totalTokens = blocks.reduce((sum, b) => sum + b.tokens, 0);
    const totalChars = blocks.reduce((sum, b) => sum + b.chars, 0);

    return { blocks, totalTokens, totalChars };
  }
}

export interface PromptCostBlock {
  label: string;
  category: "entry" | "variable-summary" | "format-instructions" | "audio-instructions";
  tokens: number;
  chars: number;
}

export interface PromptCostBreakdown {
  blocks: PromptCostBlock[];
  totalTokens: number;
  totalChars: number;
}
