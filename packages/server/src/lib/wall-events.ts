/**
 * `wallet_wall_hit` — the single most important funnel event the billing plan
 * asks for (docs/billing/2026-09-14-billing-plan-final.md). Emitted every time
 * a generation is refused for lack of mushies, so wall → pack / upgrade
 * conversion can be measured per lineup, plan, stage and model.
 *
 * Fire-and-forget; never affects the response.
 */
import { posthog } from "./posthog.js";

export interface WallHit {
  userId: string;
  plan?: string | null;
  planVersion?: number | null;
  balance: number;
  model?: string | null;
  endpoint: string;
  /** preflight = wallet empty before the turn; prompt_too_long = balance can't cover the prompt; mid_stream = ran dry while streaming. */
  stage: "preflight" | "prompt_too_long" | "mid_stream";
}

export function recordWallHit(hit: WallHit): void {
  try {
    posthog.capture({
      distinctId: hit.userId,
      event: "wallet_wall_hit",
      properties: {
        plan: hit.plan ?? null,
        plan_version: hit.planVersion ?? null,
        balance: Math.floor(hit.balance),
        model: hit.model ?? null,
        endpoint: hit.endpoint,
        stage: hit.stage,
      },
    });
  } catch {
    /* diagnostics must never change the outcome of a request */
  }
}
