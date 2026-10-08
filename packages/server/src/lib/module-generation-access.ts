import { and, eq } from "drizzle-orm";
import { RETIRED_PLAY_MODEL_IDS } from "@yumina/shared";
import { db } from "../db/index.js";
import { playSessions, user, worlds } from "../db/schema.js";
import { acquireConcurrency, checkSideCallRateLimit, releaseConcurrency, SIDE_CALL_MAX_CONCURRENT } from "../middleware/rate-limit.js";
import { calculateCost, checkBalance, estimateTokensFromChars, validateModelAccess } from "./credit-service.js";
import { imagePromptChars } from "./chat-images.js";
import type { ChatMessage } from "./llm/types.js";
import { PLANS } from "./plan-config.js";
import { resolveProviderForModel } from "./resolve-provider.js";

/** All station calls carry creator-authored prompts, even when the call is
 * scheduled in the background. Resolve access from the live session/world,
 * never from the card's editable schema or the caller's cached definition. */
export async function beginModuleGeneration(args: {
  userId: string;
  sessionId: string;
  model: string;
  prompt: ChatMessage[];
  maxTokens: number;
}) {
  const [access] = await db.select({
    creatorId: worlds.creatorId,
    allowCustomApi: worlds.allowCustomApi,
    isSuspended: user.isSuspended,
  }).from(playSessions)
    .innerJoin(worlds, eq(worlds.id, playSessions.worldId))
    .innerJoin(user, eq(user.id, playSessions.userId))
    .where(and(eq(playSessions.id, args.sessionId), eq(playSessions.userId, args.userId)))
    .limit(1);
  if (!access) throw new Error("SESSION_NOT_FOUND");

  const forceOfficial = access.allowCustomApi === false && access.creatorId !== args.userId;
  const resolved = await resolveProviderForModel(args.userId, args.model, {
    forceOfficial, allowOfficialFallback: false, allowRetiredForAccessCheck: true,
  });
  if (!resolved) throw new Error(forceOfficial ? "PROTECTED_WORLD" : "NO_API_KEY");

  if (!resolved.isByok) {
    if (access.isSuspended) throw new Error("SUSPENDED");
    if (RETIRED_PLAY_MODEL_IDS.has(args.model)) throw new Error("MODEL_UNAVAILABLE");
    const balance = await checkBalance(args.userId);
    const modelAccess = await validateModelAccess(balance.wallet.plan, args.model);
    if (!modelAccess.allowed) throw new Error("MODEL_NOT_ALLOWED");
    if (!(PLANS[balance.wallet.plan] ?? PLANS.free).unlimited) {
      // Budget for the bounded answer too. A tiny positive wallet must not
      // admit an expensive call that fails billing only after inference.
      const cost = await calculateCost(args.model, estimateTokensFromChars(imagePromptChars(args.prompt)), args.maxTokens);
      if (!balance.ok || cost > balance.balance) throw new Error("NO_CREDITS");
    }
  }

  const limited = await checkSideCallRateLimit(args.userId);
  if (limited) throw new Error(limited.code);
  // Share the existing side-call pool, not the narrator's slot: background
  // stations can legitimately run while the triggering turn is finishing.
  const key = `side:${args.userId}`;
  if (!await acquireConcurrency(key, SIDE_CALL_MAX_CONCURRENT)) throw new Error("CONCURRENT_LIMIT");
  let released = false;
  return {
    resolved,
    release: async () => {
      if (released) return;
      released = true;
      await releaseConcurrency(key);
    },
  };
}
