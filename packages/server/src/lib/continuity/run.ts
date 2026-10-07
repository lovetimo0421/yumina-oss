/**
 * Continuity judge — per-turn orchestration.
 *
 * Runs after the narrative reply is parsed and before the turn's effects are
 * applied: builds the plan (engine), asks the decision model (jev-client),
 * applies the answers (engine) and hands back what the turn should merge in.
 * Never throws: any failure means "this turn had no judge" and the reply goes
 * through exactly as before. Timeout is short on purpose — the player is
 * already waiting on the completion event.
 */
import {
  applyContinuityPlan,
  buildContinuityPlan,
  hasSceneImageHandle,
  isContinuityEnabled,
  isSceneImageJudgeOn,
  reclaimCopiedSceneImages,
  type AudioEffect,
  type ContinuityDecision,
  type ContinuityMemory,
  type JevQuestion,
  type Effect,
  type GameStateManager,
  type WorldDefinition,
} from "@yumina/engine";
import { env } from "../env.js";
import { recordUsageLog } from "../usage-log.js";
import { decide, decisionModelConfigured, DecisionError } from "./jev-client.js";
import { sideCallTier } from "../side-call-key.js";

export const CONTINUITY_USAGE_ENDPOINT = "continuity";
const MEMORY_KEY = "continuity";

export interface ContinuityTurnArgs {
  world: WorldDefinition;
  stateManager: GameStateManager;
  /** The player's message this turn ("" for continue). */
  playerText: string;
  /** The parsed reply text (directives already stripped, images not yet expanded). */
  replyText: string;
  /** Whether the reply carried its own `[audio: …]` directives. */
  hasAudioDirective: boolean;
  userId: string;
  sessionId: string;
  path: "send" | "regenerate" | "continue";
  signal?: AbortSignal;
  /** Set only when this turn ran on the player's own OpenRouter key: resolves
   *  that key so the judge runs on it too (falls back to the platform key on
   *  any fast failure). Custom endpoints and local models leave it unset. */
  playerOpenRouterKey?: () => Promise<string | null>;
}

export interface ContinuityTurnOutcome {
  /** The typed questions the judge was asked (playtest shows them). */
  questions?: Record<string, JevQuestion>;
  /** Set-effects for judge-owned variables. Apply AFTER the AI write filter. */
  effects: Effect[];
  /** Judge-picked BGM crossfade / one-shot SFX for this turn. */
  audioEffects: AudioEffect[];
  /** Scene images whose author condition this reply met; each is appended as
   *  `[image: id]` before directive expansion (see `appendJudgeImages`). */
  imageIds: string[];
  ran: boolean;
  decisions: ContinuityDecision[];
}

const NOTHING: ContinuityTurnOutcome = { effects: [], audioEffects: [], imageIds: [], ran: false, decisions: [] };

/** Appends the judge's scene images to the reply as `[image: id]` lines. */
export function appendJudgeImages(text: string, imageIds: readonly string[]): string {
  if (imageIds.length === 0) return text;
  return `${text.trimEnd()}\n\n${imageIds.map((id) => `[image: ${id}]`).join("\n\n")}`;
}

/**
 * The reply's scene images after the judge: scene image embeds the story
 * model copied out of history are taken back (dropped when the judge decides
 * images this turn, turned back into `[image: id]` otherwise), then the
 * judge's own picks are appended. The result still needs
 * `resolveSceneImageDirectives` to expand the handles.
 */
export function applyJudgeSceneImages(world: WorldDefinition, replyText: string, outcome: Pick<ContinuityTurnOutcome, "ran" | "imageIds">): string {
  const judgeOwnsImages = outcome.ran && isSceneImageJudgeOn(world);
  const base = reclaimCopiedSceneImages(replyText, world.sceneImages ?? [], judgeOwnsImages ? "strip" : "handle");
  return appendJudgeImages(base, outcome.imageIds);
}

export function continuityGloballyEnabled(): boolean {
  return env.CONTINUITY_DISABLED !== "true" && decisionModelConfigured();
}

function readMemory(stateManager: GameStateManager): ContinuityMemory {
  const raw = stateManager.getMetadata(MEMORY_KEY);
  return raw && typeof raw === "object" ? (raw as ContinuityMemory) : {};
}

export async function runContinuityTurn(args: ContinuityTurnArgs): Promise<ContinuityTurnOutcome> {
  if (!continuityGloballyEnabled() || !isContinuityEnabled(args.world)) return NOTHING;
  const state = args.stateManager.getSnapshot();
  const memory = readMemory(args.stateManager);
  // Planning reads the card's own data (variables, audio notes, scene images),
  // which older or imported cards can carry in shapes the schema never
  // checked. It runs after the reply was generated and paid for — a throw here
  // would lose the whole turn — so it sits under the same "no judge" fallback.
  let plan: ReturnType<typeof buildContinuityPlan>;
  try {
    plan = buildContinuityPlan(args.world, state, {
      playerText: args.playerText,
      replyText: isSceneImageJudgeOn(args.world)
        ? reclaimCopiedSceneImages(args.replyText, args.world.sceneImages ?? [], "strip")
        : args.replyText,
      turnCount: state.turnCount,
      memory,
      // Only a bare `[image: id]` the narrator wrote itself counts; an embed
      // copied out of history (a scene image or a per-turn picture) must not
      // switch off the author's image conditions for this turn.
      hasImageDirective: hasSceneImageHandle(args.replyText),
      hasAudioDirective: args.hasAudioDirective,
    });
  } catch (err) {
    console.warn(`[Continuity] skipped (plan): ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
    return NOTHING;
  }
  if (!plan) return NOTHING;

  const started = Date.now();
  let playerKey: string | null = null;
  if (args.playerOpenRouterKey) {
    try { playerKey = await args.playerOpenRouterKey(); } catch { /* platform key */ }
  }
  try {
    const res = await decide({
      state: plan.state, questions: plan.questions, signal: args.signal, timeoutMs: env.CONTINUITY_TIMEOUT_MS,
      playerKey: playerKey ? { userId: args.userId, apiKey: playerKey } : null,
    });
    const result = applyContinuityPlan(plan, res.answers, state.turnCount, memory);
    if (JSON.stringify(result.memory) !== JSON.stringify(memory)) args.stateManager.setMetadata(MEMORY_KEY, result.memory);
    const applied = result.decisions.filter((d) => d.applied).length;
    console.log(`[Continuity] ${args.path} turn=${state.turnCount} questions=${Object.keys(plan.questions).length} applied=${applied} ms=${res.ms} tokens=${res.usage.inputTokens} key=${res.keySource}${res.byokFallback ? ` byokFallback=${res.byokFallback}` : ""}`);
    // Never charged in mushies: free-by-design in USAGE_ENDPOINT_BILLING_POLICY.
    // Tier "byok" when the player's own key paid, else the platform's.
    void recordUsageLog({
      userId: args.userId, sessionId: args.sessionId, model: res.model, endpoint: CONTINUITY_USAGE_ENDPOINT,
      promptTokens: res.usage.inputTokens, completionTokens: res.usage.outputTokens, totalTokens: res.usage.inputTokens + res.usage.outputTokens,
      apiKeyTier: sideCallTier(res.keySource), generationTimeMs: Date.now() - started, tokenMeasurement: "provider",
    }).catch(() => { /* logged inside */ });
    return { effects: result.effects, audioEffects: result.audioEffects, imageIds: result.imageIds, ran: true, decisions: result.decisions, questions: plan.questions };
  } catch (err) {
    const code = err instanceof DecisionError ? err.code : "unknown";
    if (code !== "cancelled") console.warn(`[Continuity] skipped (${code}) after ${Date.now() - started}ms: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
    return NOTHING;
  }
}
