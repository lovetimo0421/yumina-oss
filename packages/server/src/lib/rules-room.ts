// Rules rooms (game-rt `rules:<CODE>` tables): the card's rules file, the
// join gate, and the AI seat move. The game server runs the rules; this side
// only serves the file, admits players and plays AI seats on the host's bill.
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { normaliseMultiplayer, parseCompletionResponseFormat } from "@yumina/shared";
import { db, readOwn, type DrizzleDB } from "../db/index.js";
import { user, worlds } from "../db/schema.js";
import { canJoinAdultWorld, isAdultWorld, type AdultGateReason } from "./adult-world-gate.js";
import { resolveProviderForModel } from "./resolve-provider.js";
import { applyModelRedirect } from "./llm/model-redirects.js";
import { DEFAULT_STORY_SUMMARY_MODEL } from "./background-model-defaults.js";
import { isZeroCostPlayModel, isZeroCostRates } from "./llm/fallback-models.js";
import { planFallbackModel } from "./plan-model-gate.js";
import {
  calculateCost,
  checkBalance,
  deductCreditsUpToBalance,
  estimateCreditsFromChars,
  estimateTokensFromChars,
  getModelCostRates,
  validateModelAccess,
} from "./credit-service.js";
import { PLANS } from "./plan-config.js";
import { recordUsageLog } from "./usage-log.js";
import { usageObservation } from "./usage-observation.js";
import { acquireConcurrency, checkSideCallRateLimit, releaseConcurrency } from "../middleware/rate-limit.js";
import type { ChatMessage } from "./llm/types.js";

export const MAX_RULES_SEATS = 12;
const MAX_SOURCE_BYTES = 256 * 1024;
const AI_MAX_TOKENS = 300;
const AI_TIMEOUT_MS = 20_000;
const AI_MAX_CONCURRENT = 4;

/** `schema.settings.multiplayer` of a rules card, as a table needs it. */
export interface RulesMultiplayer {
  mode: "rules";
  rulesFile: string;
  minSeats: number;
  maxSeats: number;
  aiModel?: string;
  aiNames: string[];
}

/** A rules table needs the card's multiplayer on, in rules mode, with a rules
 *  file. Read through the shared reader, so an older `{ mode: "rules", ... }`
 *  without `enabled` still counts and `aiModel` is read as `ai.model`. */
export function readRulesMultiplayer(raw: unknown): RulesMultiplayer | null {
  const mp = normaliseMultiplayer(raw);
  if (!mp || !mp.enabled || mp.mode !== "rules" || !mp.rulesFile) return null;
  // The source query strips the same leading "./" (loadRulesSource).
  const rulesFile = mp.rulesFile.replace(/^\.?\//, "");
  if (!rulesFile) return null;
  return {
    mode: "rules", rulesFile, minSeats: mp.minSeats, maxSeats: mp.maxSeats,
    ...(mp.ai.model ? { aiModel: mp.ai.model } : {}),
    aiNames: mp.ai.names,
  };
}

export function rulesSourceVersion(source: string): string {
  return createHash("sha256").update(source).digest("hex").slice(0, 20);
}

// ── Join gate (POST /api/game/ticket for rules:<CODE>) ─────────────────────

export type RulesTicketRefusal =
  | { error: "world-not-found"; status: 404 }
  | { error: "world-unavailable"; status: 403 }
  | { error: "not-a-rules-world"; status: 400 }
  | { error: AdultGateReason; status: 403 };

export interface RulesGateWorld {
  status: string;
  creatorId: string | null;
  ageRating: string | null;
  isNsfw: boolean | null;
  multiplayer: unknown;
}
export interface RulesGateAccount {
  birthYear: number | null;
  preferences: unknown;
  limitedContentOnly: boolean | null;
}

/** Pure decision: can this account sit at a rules table for this world? */
export function decideRulesTicket(userId: string, world: RulesGateWorld | null, account: RulesGateAccount | null): RulesTicketRefusal | null {
  if (!world) return { error: "world-not-found", status: 404 };
  if (world.status !== "published" && world.creatorId !== userId) return { error: "world-unavailable", status: 403 };
  if (!readRulesMultiplayer(world.multiplayer)) return { error: "not-a-rules-world", status: 400 };
  if (isAdultWorld(world)) {
    const gate = canJoinAdultWorld(account ?? { birthYear: null, preferences: null, limitedContentOnly: false });
    if (!gate.ok) return { error: gate.reason, status: 403 };
  }
  return null;
}

/** Reads on the primary: this is an access check before a seat is granted. */
export async function checkRulesTicket(userId: string, worldId: string, database?: DrizzleDB): Promise<RulesTicketRefusal | null> {
  const reader = database ?? await readOwn(userId);
  const [world] = await reader.select({
    status: worlds.status, creatorId: worlds.creatorId, ageRating: worlds.ageRating, isNsfw: worlds.isNsfw,
    multiplayer: sql<unknown>`${worlds.schema} #> '{settings,multiplayer}'`,
  }).from(worlds).where(eq(worlds.id, worldId)).limit(1);
  if (!world) return decideRulesTicket(userId, null, null);
  const [account] = await reader.select({ birthYear: user.birthYear, preferences: user.preferences, limitedContentOnly: user.limitedContentOnly })
    .from(user).where(eq(user.id, userId)).limit(1);
  return decideRulesTicket(userId, world, account ?? null);
}

// ── Rules source (GET /api/internal/rules-source/:worldId) ─────────────────

export interface RulesSourcePayload {
  worldId: string;
  version: string;
  source: string;
  name?: string;
  minSeats?: number;
  maxSeats?: number;
  aiModel?: string;
  aiNames?: string[];
}

export async function loadRulesSource(worldId: string, database: DrizzleDB = db): Promise<RulesSourcePayload | { error: "no-rules" | "rules-too-large" }> {
  const [row] = await database.select({
    name: worlds.name,
    multiplayer: sql<unknown>`${worlds.schema} #> '{settings,multiplayer}'`,
    // The file named by settings.multiplayer.rulesFile, read without loading the whole schema.
    source: sql<string | null>`jsonb_extract_path_text(${worlds.schema}, 'rootComponent', 'files', regexp_replace(btrim(${worlds.schema} #>> '{settings,multiplayer,rulesFile}'), '^\\.?/', ''))`,
  }).from(worlds).where(eq(worlds.id, worldId)).limit(1);
  const mp = readRulesMultiplayer(row?.multiplayer);
  if (!row || !mp || typeof row.source !== "string" || !row.source.trim()) return { error: "no-rules" };
  if (Buffer.byteLength(row.source) > MAX_SOURCE_BYTES) return { error: "rules-too-large" };
  return {
    worldId, version: rulesSourceVersion(row.source), source: row.source,
    ...(row.name ? { name: row.name } : {}),
    minSeats: mp.minSeats,
    maxSeats: mp.maxSeats,
    ...(mp.aiModel ? { aiModel: mp.aiModel } : {}),
    ...(mp.aiNames.length ? { aiNames: mp.aiNames } : {}),
  };
}

// ── AI seat (POST /api/internal/rules-ai) ─────────────────────────────────

const jsonBounded = (max: number) => z.unknown().refine((v) => {
  try { const s = JSON.stringify(v); return s === undefined || s.length <= max; } catch { return false; }
}, `must be JSON under ${max} chars`);

export const rulesAiInputSchema = z.object({
  roomId: z.string().regex(/^rules:[A-Z0-9]{2,10}$/),
  worldId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  payerUserId: z.string().min(1).max(128),
  seat: z.string().min(1).max(64),
  view: jsonBounded(24_000),
  legal: jsonBounded(8_000).optional(),
  prompt: z.string().max(4000).nullable().optional(),
  aiModel: z.string().max(200).optional(),
});
export type RulesAiInput = z.infer<typeof rulesAiInputSchema>;

export function rulesAiMessages(input: Pick<RulesAiInput, "seat" | "view" | "legal" | "prompt">): ChatMessage[] {
  const legalList = Array.isArray(input.legal) && input.legal.length > 0;
  const system = [
    `You are an AI player in a turn-based game, playing seat "${input.seat}". Read your view of the game and choose one move.`,
    `Reply with only a JSON object: {"action": <your move>}.${legalList ? " The action must be exactly one of the legal moves." : ""}`,
    ...(input.prompt ? ["", "Game guidance from the card:", input.prompt] : []),
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: JSON.stringify({ view: input.view ?? null, ...(input.legal !== undefined && input.legal !== null ? { legal: input.legal } : {}) }) },
  ];
}

/** The model's reply → one action. A legal list, when given, is binding. */
export function parseRulesAiReply(text: string, legal: unknown): { action: unknown } | { error: "unparsable" | "illegal-action" } {
  const stripped = text.replace(/```(?:json)?/gi, "").trim();
  const start = stripped.indexOf("{"), end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) return { error: "unparsable" };
  let parsed: unknown;
  try { parsed = JSON.parse(stripped.slice(start, end + 1)); } catch { return { error: "unparsable" }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("action" in parsed)) return { error: "unparsable" };
  const action = (parsed as { action: unknown }).action;
  if (!Array.isArray(legal) || legal.length === 0) return { action };
  const key = JSON.stringify(action);
  const exact = legal.find((l) => JSON.stringify(l) === key);
  if (exact !== undefined) return { action: exact };
  if (typeof action === "string") {
    const loose = legal.find((l) => typeof l === "string" && l.trim().toLowerCase() === action.trim().toLowerCase());
    if (loose !== undefined) return { action: loose };
  }
  return { error: "illegal-action" };
}

export type RulesAiOutcome =
  | { action: unknown }
  | { error: string; status: 402 | 403 | 404 | 409 | 422 | 429 | 502 | 503 };

/** One AI seat move, billed to the table's host exactly like a side call. */
export async function playRulesSeat(input: RulesAiInput, signal?: AbortSignal): Promise<RulesAiOutcome> {
  const payer = input.payerUserId;
  const [world] = await db.select({
    allowCustomApi: worlds.allowCustomApi, creatorId: worlds.creatorId, sealedContent: worlds.sealedContent,
    multiplayer: sql<unknown>`${worlds.schema} #> '{settings,multiplayer}'`,
  }).from(worlds).where(eq(worlds.id, input.worldId)).limit(1);
  const mp = readRulesMultiplayer(world?.multiplayer);
  if (!world || !mp) return { error: "no-rules", status: 404 };

  const limited = await checkSideCallRateLimit(payer);
  if (limited) return { error: "rate-limited", status: 429 };

  let model = applyModelRedirect(mp.aiModel ?? DEFAULT_STORY_SUMMARY_MODEL);
  const isProtected = !!world.sealedContent || (world.allowCustomApi === false && world.creatorId !== payer);
  const resolved = await resolveProviderForModel(payer, model, { forceOfficial: isProtected, allowRetiredForAccessCheck: true });
  if (!resolved) return { error: "no-provider", status: 402 };

  const messages = rulesAiMessages(input);
  const promptChars = messages.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0);
  if (!resolved.isByok) {
    const wallet = await checkBalance(payer);
    if (!wallet.ok && !isZeroCostPlayModel(model)) return { error: "insufficient-credits", status: 402 };
    const access = await validateModelAccess(wallet.wallet.plan, model);
    if (!access.allowed) {
      // The card's pick falls back on a plan miss, like a card's own AIs.
      const fallback = await planFallbackModel(wallet.wallet.plan, undefined, DEFAULT_STORY_SUMMARY_MODEL);
      if (!fallback) return { error: "model-not-allowed", status: 403 };
      model = fallback;
    }
    if (!(PLANS[wallet.wallet.plan] ?? PLANS.free).unlimited) {
      const rates = await getModelCostRates(model, estimateTokensFromChars(promptChars));
      if (!isZeroCostRates(rates) && estimateCreditsFromChars(rates, promptChars, AI_MAX_TOKENS * 3) >= wallet.balance) {
        return { error: "insufficient-credits", status: 402 };
      }
    }
  }

  const slot = `rules-ai:${payer}`;
  if (!(await acquireConcurrency(slot, AI_MAX_CONCURRENT, Math.ceil(AI_TIMEOUT_MS / 1000) + 10))) return { error: "busy", status: 429 };
  const startedAt = Date.now();
  const abort = AbortSignal.any([AbortSignal.timeout(AI_TIMEOUT_MS), ...(signal ? [signal] : [])]);
  let text = "";
  let promptTokens = 0, completionTokens = 0;
  let providerCostUsd: number | undefined, providerRequestId: string | undefined;
  let done = false;
  try {
    for await (const chunk of resolved.provider.generateStream({
      conversationId: `${input.roomId}:${input.seat}`,
      model,
      messages,
      maxTokens: AI_MAX_TOKENS,
      temperature: 0.7,
      responseFormat: resolved.providerName === "openrouter" ? parseCompletionResponseFormat({ type: "json_object" }) : undefined,
      signal: abort,
    })) {
      if (chunk.type === "error") throw new Error(chunk.content || "generation-failed");
      if (chunk.type === "text") text += chunk.content;
      if (chunk.type === "done") {
        done = true;
        promptTokens = chunk.usage?.promptTokens ?? 0;
        completionTokens = chunk.usage?.completionTokens ?? 0;
        providerCostUsd = chunk.usage?.providerCostUsd;
        providerRequestId = chunk.usage?.providerRequestId;
      }
    }
  } catch {
    done = false;
  } finally {
    await releaseConcurrency(slot);
  }

  // Tokens spent are billed whether or not the answer turns out usable.
  if (promptTokens || completionTokens) {
    const usageLogId = crypto.randomUUID();
    await recordUsageLog({
      ...usageObservation({ promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, providerCostUsd, providerRequestId }),
      id: usageLogId,
      userId: payer,
      analyticsWorldId: input.worldId,
      model,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      endpoint: "rules-ai",
      apiKeyTier: resolved.apiKeyTier,
      generationTimeMs: Date.now() - startedAt,
    });
    if (!resolved.isByok) {
      try {
        const cost = await calculateCost(model, promptTokens, completionTokens, { providerCostUsd });
        if (cost > 0) await deductCreditsUpToBalance(payer, cost, usageLogId, `Rules room AI seat: ${model} — ${promptTokens + completionTokens} tokens`);
      } catch (err) {
        console.error("[Credit] Rules AI deduction failed:", err instanceof Error ? err.message : err);
      }
    }
  }
  if (!done) return { error: "provider-unavailable", status: 502 };
  const parsed = parseRulesAiReply(text, input.legal);
  return "error" in parsed ? { error: parsed.error, status: 422 } : parsed;
}
