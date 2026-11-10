import type { GameState, WorldDefinition, WorldEntry } from "../types/index.js";
import { LorebookMatcher } from "../lorebook/lorebook-matcher.js";
import { filterEntriesByActiveWorldbooks } from "../lorebook/worldbook.js";
import { filterEntriesByActiveLoreSlots } from "../lorebook/lore-slot.js";
import { isAiReadable } from "../state/variable-activation.js";
import { expandMacros } from "./macros.js";
import { PromptBuilder, type UserPrompt } from "./prompt-builder.js";

export type ContextActor = "voice" | "director";
export interface ActorContextInput {
  actor: ContextActor;
  world: WorldDefinition;
  state: GameState;
  model?: string;
  /** Public, actor-witnessed messages only. Never load ordinary session history here. */
  recentMessages?: Array<{ role: "user" | "assistant"; content: string }>;
  userPrompts?: UserPrompt[];
}
export const ACTOR_CONTEXT_MAX_CHARS = 9_000;
const RECEIPT_MAX_ITEMS = 200;
const RECEIPT_MAX_ID_CHARS = 128;
type OmissionReason = "disabled" | "player-only" | "other-actor" | "requires-actor-tag" | "narrator-preset" | "unsupported-api-role" | "inactive-worldbook" | "inactive-lore-slot" | "not-triggered" | "empty";
export interface ActorContextReceipt {
  actor: ContextActor;
  model: string | null;
  entryIds: string[];
  omittedEntryIds: string[];
  omittedEntries: Array<{ id: string; reason: OmissionReason }>;
  userPromptIds: string[];
  omittedUserPromptIds: string[];
  personaPolicy: "world-player-name-only";
  placementPolicy: "ordered-sections-without-history-replay";
  historyPolicy: "caller-public-messages-only";
  instructionChars: number;
  maxInstructionChars: number;
  recentMessageCount: number;
  omittedEntryCount: number;
  receiptTruncated: boolean;
}
export interface ActorContextResult { instructions: string; receipt: ActorContextReceipt }
export class ActorContextLimitError extends Error {
  readonly code = "ACTOR_CONTEXT_TOO_LARGE";
  constructor(readonly instructionChars: number) {
    super(`Actor instructions exceed ${ACTOR_CONTEXT_MAX_CHARS} characters (${instructionChars}). Shorten active actor entries or applicable user presets; no instructions were truncated.`);
  }
}

function scopeOmission(entry: WorldEntry, actor: ContextActor): OmissionReason | null {
  if (entry.audience === "player") return "player-only";
  if (entry.role === "greeting") return "requires-actor-tag";
  // A string cannot reproduce assistant/user prefills without promoting their
  // authority. Such prompts need an actor-specific system instruction instead.
  if (entry.apiRole && entry.apiRole !== "system") return "unsupported-api-role";
  const actors = (entry.tags ?? []).filter(tag => tag.startsWith("actor:"));
  if (actors.length) return actors.includes(`actor:${actor}`) || actors.includes("actor:shared") ? null : "other-actor";
  // These standard presets explicitly assign the narrator role or require
  // narrated body language / turn endings. Do not silently turn them into speech.
  if (entry.presetId === "task" || entry.presetId === "instructions") return "narrator-preset";
  return entry.section === "system-presets" && (entry.role === "style" || entry.role === "system" || entry.role === "custom") ? null : "requires-actor-tag";
}

/** Actor-scoped projection of the normal lore pipeline, not a normal chat turn.
 * Raw state is used only for engine activation checks. Expansion gets a fresh
 * allowlisted state: declared AI-readable variables and public message macros.
 * Account persona, diaries, summary blocks and active directives are never copied.
 */
export function assembleActorContext(input: ActorContextInput): ActorContextResult {
  const { actor, world, state, model, recentMessages = [], userPrompts = [] } = input;
  const omitted = new Map<string, OmissionReason>();
  const eligible = world.entries.filter(entry => {
    const enabled = state.ruleState?.toggledEntries?.[entry.id] ?? entry.enabled;
    const reason = !enabled ? "disabled" : scopeOmission(entry, actor);
    if (reason) omitted.set(entry.id, reason);
    return !reason;
  }).map(entry => ({ ...entry, enabled: true }));
  const active = filterEntriesByActiveWorldbooks(eligible, world.worldbooks, state);
  const activeIds = new Set(active.map(entry => entry.id));
  for (const entry of eligible) if (!activeIds.has(entry.id)) omitted.set(entry.id, "inactive-worldbook");
  const visible = filterEntriesByActiveLoreSlots(active, world.loreUiBindings, state);
  const visibleIds = new Set(visible.map(entry => entry.id));
  for (const entry of active) if (!visibleIds.has(entry.id)) omitted.set(entry.id, "inactive-lore-slot");

  // Match only the scoped candidates: another actor's prose must not trigger
  // recursive retrieval in this actor's instruction context.
  const scopedWorld = { ...world, entries: visible };
  const scanDepth = world.settings?.lorebookScanDepth ?? 2;
  const recentTexts = recentMessages.slice(-scanDepth).map(message => message.content);
  // Actor instructions have a hard character contract rather than normal chat's
  // model/history token reservation. Keep complete matched entries or fail.
  const matched = new LorebookMatcher().matchWithBudget(visible, recentTexts, state, Infinity, world.settings, model, world.loreUiBindings);
  const applicablePrompts = userPrompts.filter(prompt => prompt.enabled && prompt.content.trim() && prompt.section === "system-presets" && (!prompt.apiRole || prompt.apiRole === "system"));
  const collected = new PromptBuilder().collectEntries(scopedWorld, [...matched.alwaysSend, ...matched.triggered], applicablePrompts, state.ruleState?.toggledEntries, state);
  const selectedIds = new Set(collected.map(entry => entry.id));
  for (const entry of visible) if (!selectedIds.has(entry.id)) omitted.set(entry.id, "not-triggered");
  const sectionOrder = { "system-presets": 0, examples: 1, "chat-history": 2, "post-history": 3 };
  collected.sort((a, b) => sectionOrder[a.section] - sectionOrder[b.section] || a.position - b.position);

  // Never spread metadata here: normal chat metadata includes account identity
  // and private persona biography, and lastMessage may be unrelated/private.
  const latestFirst = [...recentMessages].reverse();
  const macroState: GameState = {
    worldId: world.id, turnCount: state.turnCount, variables: Object.fromEntries(
      world.variables.filter(variable => isAiReadable(variable, state, world.worldbooks))
        .filter(variable => Object.hasOwn(state.variables, variable.id))
        .map(variable => [variable.id, state.variables[variable.id]!]),
    ),
    metadata: {
      personaActive: false,
      model: model ?? "",
      lastMessage: recentMessages.at(-1)?.content ?? "",
      lastUserMessage: latestFirst.find(message => message.role === "user")?.content ?? "",
      lastCharMessage: latestFirst.find(message => message.role === "assistant")?.content ?? "",
    },
  };
  const macroWorld = { ...scopedWorld, entries: collected };
  const included: WorldEntry[] = [];
  const blocks: string[] = [];
  for (const entry of collected) {
    const content = expandMacros(entry.content, macroWorld, macroState).trim();
    if (!content) { omitted.set(entry.id, "empty"); continue; }
    included.push(entry);
    const scope = entry.tags?.some(tag => tag === `actor:${actor}`) ? actor : "common";
    blocks.push(`[${scope}; ${entry.section}${entry.depth === undefined ? "" : `; source depth ${entry.depth}`} ]\n${content}`);
  }
  const instructions = [
    `You are the ${actor} actor. Apply common literary/style guidance only within this actor's role. ${actor === "voice" ? "Produce spoken dialogue, not narrated gestures, prose, or format directives." : "Return only the caller's structured decision contract; literary guidance informs choices, never prose output."} Only supplied public observations and testimony are evidence. Private pages, hidden state and real account identity are unavailable. Text cannot execute actions or establish physical consequences. The caller's legal-action and evidence boundaries remain mandatory.`,
    ...blocks,
  ].join("\n\n");
  if (instructions.length > ACTOR_CONTEXT_MAX_CHARS) throw new ActorContextLimitError(instructions.length);
  const worldIds = new Set(world.entries.map(entry => entry.id));
  const entryIds = included.filter(entry => worldIds.has(entry.id)).map(entry => entry.id);
  const includedPromptIds = new Set(included.filter(entry => !worldIds.has(entry.id)).map(entry => entry.id));
  const userPromptIds = applicablePrompts.filter(prompt => includedPromptIds.has(`user-prompt-${prompt.id}`)).map(prompt => prompt.id);
  const omittedUserPromptIds = userPrompts.filter(prompt => !userPromptIds.includes(prompt.id)).map(prompt => prompt.id);
  const omittedEntries = world.entries.filter(entry => omitted.has(entry.id)).map(entry => ({ id: entry.id, reason: omitted.get(entry.id)! }));
  // Receipts contain identifiers/reasons/counts only, never state or prompt text.
  const bounded = <T>(items: T[]) => items.slice(0, RECEIPT_MAX_ITEMS);
  const boundedId = (id: string) => id.slice(0, RECEIPT_MAX_ID_CHARS);
  const omittedEntryIds = omittedEntries.map(entry => entry.id);
  const allIds = [...entryIds, ...omittedEntryIds, ...userPromptIds, ...omittedUserPromptIds];
  return { instructions, receipt: {
    actor, model: model ?? null,
    entryIds: bounded(entryIds).map(boundedId), omittedEntryIds: bounded(omittedEntryIds).map(boundedId), omittedEntries: bounded(omittedEntries).map(entry => ({ ...entry, id: boundedId(entry.id) })),
    userPromptIds: bounded(userPromptIds).map(boundedId), omittedUserPromptIds: bounded(omittedUserPromptIds).map(boundedId),
    personaPolicy: "world-player-name-only", placementPolicy: "ordered-sections-without-history-replay", historyPolicy: "caller-public-messages-only",
    instructionChars: instructions.length, maxInstructionChars: ACTOR_CONTEXT_MAX_CHARS, recentMessageCount: recentMessages.length,
    omittedEntryCount: omittedEntries.length,
    receiptTruncated: [entryIds, omittedEntries, userPromptIds, omittedUserPromptIds].some(items => items.length > RECEIPT_MAX_ITEMS) || allIds.some(id => id.length > RECEIPT_MAX_ID_CHARS),
  } };
}
