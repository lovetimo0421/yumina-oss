import { expandMacros, isAiReadable, PromptBuilder, type GameState, type WorldDefinition } from "@yumina/engine";
import { aiGenerationConfigSchema, resolveLorebookBudget, sideCompletionWorldbookIdsSchema } from "@yumina/shared";
import { z } from "zod";
import type { playSessions } from "../db/schema.js";
import type { ChatMessage, GenerateParams } from "./llm/types.js";
import { retrieveLorebookEntries } from "./lorebook-retriever.js";
import { applyPersonaMetadataToState, type AccountLike } from "./persona-metadata.js";
import { buildPersonaSystemMessage } from "./persona-prompt.js";
import { resolvePersonaForSession } from "./resolve-persona.js";
import { loadUserPrompts } from "./user-prompts.js";

export const sessionCompletionSettingsSchema = z.object({
  maxTokens: z.number().finite().int().positive().optional(),
  temperature: z.number().finite().optional(),
  includeLorebook: z.union([z.boolean(), z.literal("all"), z.literal("matched")]).optional(),
  worldbookIds: sideCompletionWorldbookIdsSchema.optional(),
  // Supplied by the parent renderer from the player's current config, never by
  // the sandbox SDK. Validate at the HTTP boundary as with ordinary chat.
  overrides: aiGenerationConfigSchema.pick({
    maxTokens: true, maxContext: true, temperature: true, topP: true,
    frequencyPenalty: true, presencePenalty: true, repetitionPenalty: true,
    topK: true, minP: true, reasoningEffort: true, streaming: true,
  }).optional(),
});

type Settings = z.infer<typeof sessionCompletionSettingsSchema>;
type CompletionSession = Pick<typeof playSessions.$inferSelect, "id" | "userId" | "state" | "sessionPersona" | "personaLocked">;

export function resolveSessionCompletionSettings(input: Settings, world: WorldDefinition): Pick<GenerateParams,
  "maxTokens" | "temperature" | "topP" | "frequencyPenalty" | "presencePenalty" | "repetitionPenalty" | "topK" | "minP" | "reasoningEffort" | "stream"
> {
  const prefs = input.overrides;
  const defaults = world.settings;
  return {
    maxTokens: Math.max(1, Math.min(input.maxTokens ?? prefs?.maxTokens ?? defaults?.maxTokens ?? 2048, 8192)),
    temperature: Math.max(0, Math.min(input.temperature ?? prefs?.temperature ?? defaults?.temperature ?? 1, 2)),
    topP: prefs?.topP ?? defaults?.topP,
    frequencyPenalty: prefs?.frequencyPenalty ?? defaults?.frequencyPenalty,
    presencePenalty: prefs?.presencePenalty ?? defaults?.presencePenalty,
    repetitionPenalty: prefs?.repetitionPenalty,
    topK: prefs?.topK ?? defaults?.topK,
    minP: prefs?.minP ?? defaults?.minP,
    reasoningEffort: prefs?.reasoningEffort,
    stream: prefs?.streaming,
  };
}

function messageText(message: ChatMessage): string {
  return typeof message.content === "string" ? message.content : message.content.filter(p => p.type === "text").map(p => p.text).join("\n");
}

/** Read-only side-call assembly. Uses the same persona, user-prompt selector,
 * matcher and section builders as chat, but only the caller's bounded history.
 * No stored chat/memory, pending effects, variable directives or persistence. */
export async function buildSessionCompletionMessages(options: {
  session: CompletionSession;
  account: AccountLike;
  world: WorldDefinition;
  model: string;
  messages: ChatMessage[];
  settings: Settings;
  json: boolean;
}): Promise<ChatMessage[]> {
  const { session, account, world, model, messages, settings } = options;
  const [persona, prompts] = await Promise.all([
    resolvePersonaForSession(session),
    loadUserPrompts(session.userId, { modelId: model }),
  ]);
  // Clone before overlaying identity/macros: prompt construction never writes
  // the session or exposes the private persona row to the client.
  const saved = structuredClone(session.state) as Partial<GameState>;
  const state: GameState = {
    ...saved,
    worldId: world.id,
    variables: { ...Object.fromEntries(world.variables.map(v => [v.id, v.defaultValue])), ...saved.variables },
    turnCount: saved.turnCount ?? 0,
    metadata: { ...saved.metadata },
  };
  applyPersonaMetadataToState(state, persona, account);
  const history = messages.filter(m => m.role !== "system");
  const textHistory = history.map(m => ({ role: m.role, content: messageText(m) }));
  const newestFirst = [...textHistory].reverse();
  Object.assign(state.metadata!, {
    model,
    lastMessage: textHistory.at(-1)?.content ?? "",
    lastUserMessage: newestFirst.find(m => m.role === "user")?.content ?? "",
    lastCharMessage: newestFirst.find(m => m.role === "assistant")?.content ?? "",
    lastUserMessageAt: undefined,
  });
  const toggles = state.ruleState?.toggledEntries ?? {};
  const allowedBooks = settings.worldbookIds === undefined ? undefined : new Set(settings.worldbookIds);
  const entries = settings.includeLorebook === false ? [] : world.entries
    // Scope narrows the candidate pool before native activation/conditions and
    // recursive keyword matching. Core has no book ID and remains available.
    .filter(e => allowedBooks === undefined || !e.worldbookId || allowedBooks.has(e.worldbookId))
    .filter(e => toggles[e.id] !== false)
    .map(e => ({ ...e, enabled: toggles[e.id] ?? e.enabled }));
  const all = settings.includeLorebook === true || settings.includeLorebook === "all";
  const generation = resolveSessionCompletionSettings(settings, world);
  const budget = resolveLorebookBudget({
    maxContext: settings.overrides?.maxContext ?? world.settings?.maxContext ?? 200_000,
    outputReserve: generation.maxTokens!,
    storyMemory: Math.ceil(textHistory.reduce((sum, m) => sum + m.content.length, 0) / 3),
    storyMemorySource: "chosen",
    budgetPercent: world.settings?.lorebookBudgetPercent,
    budgetCap: world.settings?.lorebookBudgetCap,
    reserveStoryMemory: true,
  });
  const matched = retrieveLorebookEntries({
    // All bypasses keyword selection, while conditions, active books and UI
    // bindings keep their native gates. Omitted/session defaults to matched.
    entries: all ? entries.map(e => ({ ...e, keywords: [], secondaryKeywords: [], alwaysSend: true })) : entries,
    // Side calls own their history. Scan every supplied user observation so a
    // trailing JSON repair instruction cannot displace the original scene.
    recentMessages: textHistory.filter(m => m.role === "user").map(m => m.content),
    state, tokenBudget: all ? Infinity : budget, settings: world.settings,
    modelId: model, loreUiBindings: world.loreUiBindings, worldbooks: world.worldbooks,
  });
  const builder = new PromptBuilder();
  // Precollect only retrieval survivors so disabled/toggled/conditional entries
  // cannot be reintroduced by the builder's always-send pass. Variable-bound
  // entries admitted by native retrieval are active even if manually disabled.
  const collected = builder.collectEntries({ ...world, entries: [] },
    [...matched.alwaysSend, ...matched.triggered].map(e => ({ ...e, enabled: true })), prompts, undefined, state);
  // Conditions need the real values above. Prompt macros must obey the same
  // visibility gate as automatic variable summaries, including whole arrays.
  // Empty strings also prevent a hidden macro from surviving as a placeholder.
  const promptState = { ...state, variables: { ...state.variables } };
  for (const variable of world.variables) {
    if (!isAiReadable(variable, state, world.worldbooks)) promptState.variables[variable.id] = "";
  }
  // {{char}} and example parsing must not resolve to a different role's book.
  // Preserve existing unscoped character selection for older callers.
  const promptWorld = allowedBooks === undefined ? world : { ...world, entries: [...matched.alwaysSend, ...matched.triggered] };
  const result: ChatMessage[] = builder.buildSystemMessages(promptWorld, promptState, undefined, undefined,
    state.ruleState?.activeDirectives ?? [], undefined, collected);
  const personaMessage = buildPersonaSystemMessage(persona);
  if (personaMessage) result.push({ role: "system", content: personaMessage });
  // Example parsing must recognize the same names that {{user}}/{{char}}
  // expand to, including active personas and cards without a character entry.
  const exampleWorld = { ...promptWorld, name: expandMacros("{{char}}", promptWorld, promptState),
    settings: { ...world.settings, playerName: expandMacros("{{user}}", promptWorld, promptState) } };
  result.push(...builder.buildExampleMessages(exampleWorld, promptState, undefined, undefined, undefined, collected));
  if (history.length) result.push({ role: "system", content: "[Start a new Chat]" });
  const contextualHistory = [...history];
  for (const entry of builder.buildDepthEntries(promptWorld, promptState, undefined, undefined, undefined, collected)) {
    contextualHistory.splice(Math.max(0, contextualHistory.length - entry.depth), 0, { role: entry.apiRole, content: entry.content });
  }
  result.push(...contextualHistory);
  for (const entry of builder.buildPostHistoryEntries(promptWorld, promptState, undefined, undefined, collected)) {
    result.push({ role: entry.apiRole, content: entry.content });
  }
  // Narrative preferences may shape content, but the caller owns the machine
  // protocol. Place its system messages after post-history/prefill presets.
  result.push(...messages.filter(m => m.role === "system"));
  if (options.json) result.push({ role: "system", content:
    "[Side-call output protocol]\nReturn exactly one valid JSON object satisfying the caller's requested schema. Narrative preferences apply only within that object's values. Do not emit Markdown fences, prose outside the object, or ordinary chat state directives. This output protocol takes precedence over conflicting narrative formatting instructions." });
  return result;
}
