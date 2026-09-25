/**
 * Invite Race API.
 *
 * GET  /api/invite-race/me            — the live board for the signed-in inviter
 * GET  /api/invite-race/friends       — paged friends: ?filter=&sort=&q=&offset=&limit=
 * GET  /api/invite-race/entry         — the one-line credit-popup entry
 * POST /api/invite-race/choose        — a $10+ winner picks cash or mushies
 *
 * Admin (role check on every call):
 * GET  /api/admin/invite-race                  — headline, inviters with flags, settlement preview, cash queue
 * GET  /api/admin/invite-race/friends/:userId  — one inviter's friends
 * POST /api/admin/invite-race/event            — create / update the event (rules lock once live)
 * POST /api/admin/invite-race/rollup           — recount now
 * POST /api/admin/invite-race/exclude          — exclude or restore a friend / void an inviter
 * POST /api/admin/invite-race/rounds/:n/approve
 * POST /api/admin/invite-race/payouts/:n/:userId/cash-sent
 */
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { inviteRaceRoundAt } from "@yumina/shared";
import { db } from "../db/index.js";
import { adminActions, user } from "../db/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { adminMiddleware } from "../middleware/admin.js";
import {
  approveInviteRaceRound, chooseInviteRacePrize, currentInviteRaceEvent, dispatchInviteRaceGiftCard, retryInviteRaceGiftCards, eventEndsAt, inviteRaceAdminFriends,
  inviteRaceAdminOverview, inviteRaceEntry, inviteRaceView, markInviteRaceCashSent, rollupInviteRace, setInviteRaceExclusion,
  upsertInviteRaceEvent,
} from "../lib/invite-race.js";
import { backfillInviteRaceHistory, inviteRaceBoardExtras, inviteRaceFriendsPage } from "../lib/invite-race-board.js";
import type { AppEnv } from "../lib/types.js";

const inviteRaceRoutes = new Hono<AppEnv>();

async function isAdmin(userId: string) {
  const [row] = await db.select({ role: user.role }).from(user).where(eq(user.id, userId));
  return row?.role === "admin";
}

async function audit(adminId: string, action: string, targetId: string, details: Record<string, unknown>) {
  try {
    await db.insert(adminActions).values({ adminId, actionType: action, targetType: "invite_race", targetId, metadata: details });
  } catch (error) {
    console.warn("[InviteRace] audit write failed", error instanceof Error ? error.message : error);
  }
}

inviteRaceRoutes.get("/invite-race/me", authMiddleware, async (c) => {
  const me = c.get("user");
  const admin = await isAdmin(me.id);
  const event = await currentInviteRaceEvent({ includePreview: admin });
  if (!event) return c.json({ data: null });
  // Admins can look at the board through any inviter's eyes, to check the numbers.
  const as = admin ? c.req.query("as") : undefined;
  const view = await inviteRaceView(event, as || me.id);
  return c.json({ data: { ...view, ...(await inviteRaceBoardExtras(event, as || me.id, view)) } });
});

inviteRaceRoutes.get("/invite-race/friends", authMiddleware, async (c) => {
  const me = c.get("user");
  const admin = await isAdmin(me.id);
  const event = await currentInviteRaceEvent({ includePreview: admin });
  if (!event) return c.json({ data: { total: 0, rows: [] } });
  const q = z.object({
    filter: z.enum(["all", "waiting", "active", "playing", "maxed"]).catch("all"),
    sort: z.enum(["tickets", "newest", "closest"]).catch("tickets"),
    q: z.string().max(60).catch(""),
    offset: z.coerce.number().int().min(0).catch(0),
    limit: z.coerce.number().int().min(1).max(100).catch(30),
  }).parse(c.req.query());
  const as = admin ? c.req.query("as") : undefined;
  return c.json({ data: await inviteRaceFriendsPage(event, as || me.id, { ...q, q: q.q.trim() }) });
});

// No sign-in needed: lets the Home banner show the race to visitors too. Nothing personal in it.
inviteRaceRoutes.get("/invite-race/public", async (c) => {
  const event = await currentInviteRaceEvent({ includePreview: false });
  if (!event || event.status !== "live") return c.json({ data: null });
  const roundNo = inviteRaceRoundAt(event.startsAt, event.roundCount, new Date());
  if (!roundNo) return c.json({ data: null });
  const endsAt = new Date(event.startsAt.getTime() + roundNo * 7 * 86_400_000).toISOString();
  c.header("Cache-Control", "public, max-age=60");
  return c.json({ data: { eventId: event.id, referralCode: null, roundNo, endsAt, tickets: 0, estimateUsd: 0 } });
});

inviteRaceRoutes.get("/invite-race/entry", authMiddleware, async (c) => {
  const me = c.get("user");
  const event = await currentInviteRaceEvent({ includePreview: await isAdmin(me.id) });
  return c.json({ data: event ? await inviteRaceEntry(event, me.id) : null });
});

inviteRaceRoutes.post("/invite-race/choose", authMiddleware, async (c) => {
  const me = c.get("user");
  const body = z.object({ roundNo: z.number().int().min(1), choice: z.enum(["cash", "mushies"]) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Invalid choice" }, 400);
  const event = await currentInviteRaceEvent({ includePreview: await isAdmin(me.id) });
  if (!event) return c.json({ error: "No event" }, 404);
  try {
    const data = await chooseInviteRacePrize(event, body.data.roundNo, me.id, body.data.choice);
    // Gift card: place the order right away. If it fails it stays in the admin queue for a retry.
    if (body.data.choice === "cash") await dispatchInviteRaceGiftCard(event, body.data.roundNo, me.id).catch(() => undefined);
    return c.json({ data });
  } catch (error) {
    const code = error instanceof Error ? error.message : "FAILED";
    return c.json({ error: code, code }, code === "NO_PRIZE" ? 404 : 409);
  }
});

// ─── Admin ───────────────────────────────────────────────────────────

const admin = new Hono<AppEnv>();
admin.use("/*", authMiddleware, adminMiddleware);

admin.get("/", async (c) => {
  const event = await currentInviteRaceEvent({ includePreview: true });
  if (!event) return c.json({ data: null });
  const now = new Date();
  const fallback = inviteRaceRoundAt(event.startsAt, event.roundCount, now) ?? (now >= eventEndsAt(event) ? event.roundCount : 1);
  const roundNo = Math.min(event.roundCount, Math.max(1, Number(c.req.query("round")) || fallback));
  return c.json({ data: await inviteRaceAdminOverview(event, roundNo) });
});

admin.get("/friends/:userId", async (c) => {
  const event = await currentInviteRaceEvent({ includePreview: true });
  if (!event) return c.json({ data: [] });
  return c.json({ data: await inviteRaceAdminFriends(event, c.req.param("userId")) });
});

admin.post("/event", async (c) => {
  const body = z.object({
    id: z.string().min(3).max(64).regex(/^[a-z0-9-]+$/),
    startsAt: z.string().datetime(),
    roundCount: z.number().int().min(1).max(12),
    status: z.enum(["draft", "preview", "live", "paused", "ended"]),
  }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Invalid event", issues: body.error.issues }, 400);
  // Any moment works: each period is exactly 7 × 24 hours from the start.
  const startsAt = new Date(body.data.startsAt);
  try {
    await upsertInviteRaceEvent({ ...body.data, startsAt });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "FAILED" }, 409);
  }
  await audit(c.get("user").id, "invite_race_event", body.data.id, body.data);
  return c.json({ ok: true });
});

admin.post("/rollup", async (c) => {
  const event = await currentInviteRaceEvent({ includePreview: true });
  if (!event) return c.json({ error: "No event" }, 404);
  return c.json({ data: await rollupInviteRace(event) });
});

admin.post("/backfill-history", async (c) => {
  const event = await currentInviteRaceEvent({ includePreview: true });
  if (!event) return c.json({ error: "No event" }, 404);
  const roundNo = Number(c.req.query("round")) || inviteRaceRoundAt(event.startsAt, event.roundCount, new Date()) || 1;
  return c.json({ data: { roundNo, points: await backfillInviteRaceHistory(event, roundNo) } });
});

admin.post("/exclude", async (c) => {
  const body = z.object({
    userId: z.string().min(1),
    kind: z.enum(["friend", "inviter"]),
    reason: z.string().trim().max(300).nullable(),
  }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Invalid exclusion" }, 400);
  const event = await currentInviteRaceEvent({ includePreview: true });
  if (!event) return c.json({ error: "No event" }, 404);
  await setInviteRaceExclusion(event, { ...body.data, reason: body.data.reason || null }, c.get("user").id);
  await audit(c.get("user").id, body.data.reason ? "invite_race_exclude" : "invite_race_restore", body.data.userId, body.data);
  await rollupInviteRace(event);
  return c.json({ ok: true });
});

admin.post("/rounds/:n/approve", async (c) => {
  const roundNo = Number(c.req.param("n"));
  const body = z.object({ confirmRound: z.number().int() }).safeParse(await c.req.json().catch(() => null));
  if (!body.success || body.data.confirmRound !== roundNo) return c.json({ error: "Type the round number to confirm" }, 400);
  const event = await currentInviteRaceEvent({ includePreview: true });
  if (!event) return c.json({ error: "No event" }, 404);
  try {
    await rollupInviteRace(event);
    const settlement = await approveInviteRaceRound(event, roundNo, c.get("user").id);
    await audit(c.get("user").id, "invite_race_approve", `${event.id}:${roundNo}`, { totalTickets: settlement.totalTickets, payouts: settlement.payouts.length });
    return c.json({ data: settlement });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "FAILED" }, 409);
  }
});

admin.post("/gift-cards/retry", async (c) => {
  const event = await currentInviteRaceEvent({ includePreview: true });
  if (!event) return c.json({ error: "No event" }, 404);
  const data = await retryInviteRaceGiftCards(event);
  await audit(c.get("user").id, "invite_race_gift_card_retry", event.id, data);
  return c.json({ data });
});

admin.post("/payouts/:n/:userId/cash-sent", async (c) => {
  const event = await currentInviteRaceEvent({ includePreview: true });
  if (!event) return c.json({ error: "No event" }, 404);
  await markInviteRaceCashSent(event, Number(c.req.param("n")), c.req.param("userId"));
  await audit(c.get("user").id, "invite_race_cash_sent", c.req.param("userId"), { roundNo: Number(c.req.param("n")) });
  return c.json({ ok: true });
});

inviteRaceRoutes.route("/admin/invite-race", admin);

export { inviteRaceRoutes };
