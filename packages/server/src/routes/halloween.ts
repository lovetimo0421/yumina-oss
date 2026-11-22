/**
 * Halloween 2026 — see lib/halloween.ts.
 *
 * GET  /api/halloween               — the window for everyone; the pumpkins this
 *                                     account found and the turn quest when signed in.
 * POST /api/halloween/pumpkins/:spot — open one pumpkin.
 * POST /api/halloween/turns/claim    — collect the 13-turn reward.
 */
import { Hono } from "hono";
import { authMiddleware, optionalAuthMiddleware } from "../middleware/auth.js";
import {
  PUMPKIN_SPOTS, claimHalloweenTurns, halloweenActive, halloweenState, halloweenWindow, openPumpkin, type PumpkinSpot,
} from "../lib/halloween.js";
import type { AppEnv } from "../lib/types.js";

const halloweenRoutes = new Hono<AppEnv>();

halloweenRoutes.get("/", optionalAuthMiddleware, async (c) => {
  const userId = c.get("user")?.id;
  if (!userId) {
    const { startsAt, endsAt } = halloweenWindow();
    return c.json({ data: { active: halloweenActive(), startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), guest: true } });
  }
  return c.json({ data: await halloweenState(userId) });
});

halloweenRoutes.post("/pumpkins/:spot", authMiddleware, async (c) => {
  const spot = c.req.param("spot") as PumpkinSpot;
  if (!PUMPKIN_SPOTS.includes(spot)) return c.json({ error: "Unknown pumpkin", code: "PUMPKIN_UNKNOWN" }, 404);
  const outcome = await openPumpkin(c.get("user")!.id, spot);
  if (outcome.kind === "closed") return c.json({ error: "The event is not running", code: "HALLOWEEN_CLOSED" }, 409);
  if (outcome.kind === "ineligible") return c.json({ error: "Play one turn first", code: "HALLOWEEN_INELIGIBLE" }, 403);
  return c.json({ data: outcome });
});

halloweenRoutes.post("/turns/claim", authMiddleware, async (c) => {
  const outcome = await claimHalloweenTurns(c.get("user")!.id);
  if (outcome.kind === "closed") return c.json({ error: "The event is not running", code: "HALLOWEEN_CLOSED" }, 409);
  if (outcome.kind === "ineligible") return c.json({ error: "Play one turn first", code: "HALLOWEEN_INELIGIBLE" }, 403);
  if (outcome.kind === "incomplete") return c.json({ error: "Not finished", code: "HALLOWEEN_INCOMPLETE", progress: outcome.progress }, 409);
  return c.json({ data: outcome });
});

export { halloweenRoutes };
