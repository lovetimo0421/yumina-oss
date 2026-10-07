// Scene video (the realtime film) is an experimental, paid feature. Two gates, both server-side:
//
//   1. The server flag REALTIME_FILM=1 (plus our Comfy Cloud and OpenRouter keys). Off: nobody
//      is offered it, the player and its Settings switch stay hidden (GET /users/me → filmOffered).
//   2. The player's own switch, preferences.experimentalFilm. Off unless the player turned it
//      on (Settings › Display, or the first time a film starts). Every film route refuses
//      everyone else.
//
// Everything a film spends is our money (Comfy GPU time, fal stream seconds, director calls),
// so every player pays it in mushies at provider cost times FILM_MARKUP, BYOK and unlimited
// plans included (owner decision 2026-10-06).

import { eq } from "drizzle-orm";
import { readOwn } from "../../db/index.js";
import { user } from "../../db/schema.js";
import { env } from "../env.js";
import { checkBalance, deductCredits } from "../credit-service.js";
import { providerCostUsdToCredits } from "../provider-cost.js";

/** Same markup as chat models. */
export const FILM_MARKUP = 1.2;
/** Comfy Cloud bills GPU time: 0.266 credits per GPU-second at 211 credits per dollar. */
export const COMFY_USD_PER_GPU_SECOND = Number(env.REALTIME_FILM_GPU_USD_PER_SEC) || 0.00126;
/** fal minimax/h3-max/director: $0.08 per streamed second, at least 60 s per session. */
export const FAL_USD_PER_SECOND = 0.08;
export const FAL_MIN_SECONDS = 60;
/** What one ~10 s Comfy clip costs at most, for the balance check before it renders. */
export const CLIP_ESTIMATE_CREDITS = providerCostUsdToCredits(55 * COMFY_USD_PER_GPU_SECOND, FILM_MARKUP);

export function realtimeFilmEnabled(): boolean {
  return env.REALTIME_FILM === "1" && !!env.COMFY_CLOUD_API_KEY && !!env.YUMINA_OPENROUTER_KEY;
}

export function readFilmOptIn(preferences: unknown): boolean {
  return ((preferences ?? {}) as Record<string, unknown>).experimentalFilm === true;
}

/** The player's own switch, read from the primary (they may have just flipped it). */
export async function filmOptedIn(userId: string): Promise<boolean> {
  const rd = await readOwn(userId);
  const [row] = await rd.select({ preferences: user.preferences }).from(user).where(eq(user.id, userId)).limit(1);
  return readFilmOptIn(row?.preferences);
}

/** Enough mushies for the next spend of about `credits`? */
export async function canAffordFilm(userId: string, credits: number): Promise<boolean> {
  const wallet = await checkBalance(userId);
  return wallet.ok && wallet.balance >= credits;
}

export type FilmEndpoint = "film-clip" | "film-director" | "film-stream";

/**
 * Take a film spend's mushies (the caller has logged its usage). The spend already happened,
 * so a wallet that a concurrent spend emptied is charged what is left; the next balance check
 * stops the film. Returns the mushies taken.
 */
export async function takeFilmCredits(userId: string, credits: number, referenceId: string, description: string): Promise<number> {
  if (credits <= 0) return 0;
  try {
    await deductCredits(userId, credits, referenceId, description);
    return credits;
  } catch (err) {
    const balance = err instanceof Error && err.message === "INSUFFICIENT_CREDITS" ? (err as { balance?: unknown }).balance : null;
    if (typeof balance !== "number" || balance <= 0) {
      if (typeof balance !== "number") console.error("[Film] deduction failed:", err instanceof Error ? err.message : err);
      return 0;
    }
    try {
      await deductCredits(userId, balance, `${referenceId}:clamped`, `${description} (clamped to balance)`);
      return balance;
    } catch {
      return 0;
    }
  }
}
