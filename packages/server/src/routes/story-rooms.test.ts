import "../test/database-fixture.js";
import assert from "node:assert/strict";
import { afterEach, before, beforeEach, test } from "node:test";
import { mock } from "node:test";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { creditTransactions, creditWallets, follows, notifications, playSessions, usageLogs, storyRoomActions, storyRoomMembers, storyRooms, user, userBlocks, worlds } from "../db/schema.js";
import { auth } from "../lib/auth.js";
import { ROSTER_GUIDE, markRoomTurnSent, resolveRoomTurn, roomWithholdsUnrestrict, touchOnline } from "../lib/story-rooms.js";
import { isRoundRunning, registerStoryRoomRunner, stopStoryRoomRunner } from "../lib/story-room-runner.js";
import { INTERNAL_ACTOR_HEADER, takeInternalActor } from "../lib/internal-actor.js";
import { plainExcerpt, storyRoomRoutes, storySoFar } from "./story-rooms.js";
import { messageRoutes } from "./messages.js";
import { sessionRoutes } from "./sessions.js";

const app = new Hono().route("/api/story-rooms", storyRoomRoutes).route("/api/sessions", sessionRoutes).route("/api", messageRoutes);
const p = `sroom-${crypto.randomUUID().slice(0, 8)}`;
const adultYear = new Date().getFullYear() - 30;
const ids = {
  host: `${p}-host`,
  ann: `${p}-ann`,
  bea: `${p}-bea`,
  dan: `${p}-dan`,
  minor: `${p}-minor`,
  limited: `${p}-limited`,
  eve: `${p}-eve`,
};
const sessions = { safe: `${p}-s-safe`, adult: `${p}-s-adult`, off: `${p}-s-off`, rules: `${p}-s-rules`, roles: `${p}-s-roles`, auto: `${p}-s-auto`, real: `${p}-s-real`, ui: `${p}-s-ui`, cap: `${p}-s-cap` };
const storyOn = { enabled: true, mode: "story", minSeats: 2, maxSeats: 6 };
const cardRoles = [
  { id: "knight", name: "Knight", note: "Holds the line" },
  { id: "mage", name: "Mage" },
  { id: "rogue", name: "Rogue" },
  { id: "bard", name: "Bard" },
];

function call(path: string, actor: string, method = "GET", body?: unknown) {
  return app.request(path, {
    method,
    headers: { "x-test-user": actor, "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const json = async (r: Response) => (await r.json()) as { data?: any; error?: string; code?: string };

before(async () => {
  const adult = { birthYear: adultYear, preferences: { contentLevel: "r18" } };
  await db.insert(user).values([
    { id: ids.host, name: "Host", email: `${ids.host}@test.invalid`, ...adult },
    { id: ids.ann, name: "Ann", email: `${ids.ann}@test.invalid`, ...adult },
    { id: ids.bea, name: "Bea", email: `${ids.bea}@test.invalid`, preferences: { contentLevel: "r18" } },
    { id: ids.dan, name: "Dan", email: `${ids.dan}@test.invalid`, ...adult },
    { id: ids.minor, name: "Min", email: `${ids.minor}@test.invalid`, birthYear: adultYear + 20, preferences: { contentLevel: "r18" } },
    { id: ids.limited, name: "Lim", email: `${ids.limited}@test.invalid`, ...adult, limitedContentOnly: true },
    { id: ids.eve, name: "Eve", email: `${ids.eve}@test.invalid`, ...adult },
  ]);
  const [safeWorld] = await db.insert(worlds).values({ creatorId: ids.host, name: "Harbor", status: "published", schema: { id: "w", name: "Harbor", entries: [], variables: [], settings: { multiplayer: storyOn } } }).returning();
  const [adultWorld] = await db.insert(worlds).values({ creatorId: ids.host, name: "Night", status: "published", ageRating: "r18", schema: { id: "w2", name: "Night", entries: [], variables: [], settings: { multiplayer: storyOn } } }).returning();
  const [offWorld] = await db.insert(worlds).values({ creatorId: ids.host, name: "Solo", status: "published", schema: { id: "w3", name: "Solo", entries: [], variables: [] } }).returning();
  const [rulesWorld] = await db.insert(worlds).values({ creatorId: ids.host, name: "Board", status: "published", schema: { id: "w4", name: "Board", entries: [], variables: [], settings: { multiplayer: { enabled: true, mode: "rules", rulesFile: "rules.ts" } } } }).returning();
  const [rolesWorld] = await db.insert(worlds).values({
    creatorId: ids.host, name: "Keep", status: "published",
    schema: { id: "w5", name: "Keep", entries: [], variables: [], settings: { multiplayer: { ...storyOn, maxSeats: 4, roles: cardRoles, rolesRequired: true } } },
  }).returning();
  await db.insert(playSessions).values([
    { id: sessions.safe, userId: ids.host, worldId: safeWorld!.id },
    { id: sessions.adult, userId: ids.host, worldId: adultWorld!.id },
    { id: sessions.off, userId: ids.host, worldId: offWorld!.id },
    { id: sessions.rules, userId: ids.host, worldId: rulesWorld!.id },
    { id: sessions.roles, userId: ids.host, worldId: rolesWorld!.id },
    { id: sessions.auto, userId: ids.host, worldId: safeWorld!.id },
    { id: sessions.real, userId: ids.host, worldId: safeWorld!.id },
    { id: sessions.cap, userId: ids.host, worldId: safeWorld!.id },
  ]);
  const [uiWorld] = await db.insert(worlds).values({
    creatorId: ids.host, name: "Manor", status: "published",
    schema: { id: "w6", name: "Manor", entries: [], settings: { multiplayer: storyOn },
      variables: [{ id: "door", name: "Door", type: "string", defaultValue: "shut" }] },
  }).returning();
  await db.insert(playSessions).values({ id: sessions.ui, userId: ids.host, worldId: uiWorld!.id });
  // Host and Ann are friends (mutual follows); Dan blocked Ann.
  await db.insert(follows).values([
    { followerId: ids.host, followingId: ids.ann },
    { followerId: ids.ann, followingId: ids.host },
  ]);
  await db.insert(userBlocks).values({ blockerId: ids.dan, blockedId: ids.ann });
});

beforeEach(() => {
  mock.method(auth.api, "getSession", async ({ headers }: { headers: Headers }) => {
    const id = headers.get("x-test-user");
    return id ? { user: { id, name: id }, session: { id: `${id}-session`, userId: id, expiresAt: new Date(Date.now() + 60_000), token: "fixture" } } : null;
  });
});
afterEach(() => mock.restoreAll());

// ── The server sends rounds (lib/story-room-runner.ts) ──────────────────
// A stand-in for the chat send: checks the request is the host's, resolves
// the claimed turn exactly as routes/messages.ts does, and writes it.
type Sent = { actor: string | null; body: any; content: string; contributions: any[]; roster: string | null; turnId: string };
const sent: Sent[] = [];
let sendAnswer: "ok" | "no-credits" = "ok";
const fakeSend = {
  fetch: async (req: Request) => {
    const actor = takeInternalActor(req)?.userId ?? null;
    const body = (await req.json()) as any;
    const sessionId = decodeURIComponent(new URL(req.url).pathname.split("/")[3]!);
    const resolved = await resolveRoomTurn(sessionId, actor ?? "", body.roomTurnId, { retry: false });
    if ("error" in resolved) return Response.json({ error: resolved.error, code: resolved.code }, { status: resolved.status });
    if (sendAnswer === "no-credits") return Response.json({ error: "no credits", code: "NO_CREDITS" }, { status: 402 });
    sent.push({ actor, body, content: resolved.content, contributions: resolved.contributions, roster: resolved.roster, turnId: resolved.turnId });
    await markRoomTurnSent(resolved.roomId, resolved.turnId, `msg-${resolved.turnId}`);
    return new Response("event: done\ndata: {}\n\n", { headers: { "content-type": "text/event-stream" } });
  },
};
before(() => registerStoryRoomRunner(fakeSend, { sweep: false }));

async function waitFor<T>(probe: () => T | undefined | null | false | Promise<T | undefined | null | false>, label = "condition", ms = 5000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}
const roundIdle = (roomId: string) => waitFor(async () => !(await isRoundRunning(roomId)), "the round to finish");
/** 让 AI 接 as `actor`; resolves with what the send carried once the round is written. */
async function askRound(code: string, roomId: string, actor: string): Promise<Sent> {
  const before = sent.length;
  const r = await call(`/api/story-rooms/${code}/turn`, actor, "POST");
  assert.equal(r.status, 202, await r.clone().text());
  const s = await waitFor(() => sent[before], "the round to be sent");
  await roundIdle(roomId);
  return s;
}

test("a story room round: open, join, act, claim a turn, send it once", async () => {
  const created = await call("/api/story-rooms", ids.host, "POST", { sessionId: sessions.safe });
  assert.equal(created.status, 201);
  const room = (await json(created)).data;
  assert.match(room.code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(room.status, "open");
  assert.equal(room.turnMode, "free");
  assert.equal(room.maxSeats, 6, "seats follow the card");
  assert.equal(room.minSeats, 2);

  const again = await call("/api/story-rooms", ids.host, "POST", { sessionId: sessions.safe });
  assert.equal(again.status, 200);
  assert.equal((await json(again)).data.id, room.id);
  assert.equal((await call("/api/story-rooms", ids.ann, "POST", { sessionId: sessions.safe })).status, 404, "only the owner opens a room");

  const outside = (await json(await call(`/api/story-rooms/${room.code.toLowerCase()}`, ids.ann))).data;
  assert.equal(outside.me, null);
  assert.deepEqual(outside.members.map((m: any) => m.name), ["Host"]);
  assert.equal(outside.session.worldName, "Harbor");
  assert.deepEqual(outside.roles, []);
  assert.equal(outside.rolesRequired, false);
  assert.equal((await call(`/api/sessions/${sessions.safe}/messages`, ids.ann)).status, 404, "no history before joining");

  const joined = await call(`/api/story-rooms/${room.code}/join`, ids.ann, "POST");
  assert.equal(joined.status, 200);
  const joinedData = (await json(joined)).data;
  assert.deepEqual(joinedData.me, { role: "player" });
  assert.equal(joinedData.members.find((m: any) => m.userId === ids.ann).roleId, null);
  assert.equal((await call(`/api/sessions/${sessions.safe}/messages`, ids.ann)).status, 200, "members read the history");
  const sessionView = await call(`/api/sessions/${sessions.safe}`, ids.ann);
  assert.equal(sessionView.status, 200);
  const sessionData = (await json(sessionView)).data;
  assert.equal(sessionData.roomMember, true);
  assert.equal(sessionData.userId, ids.host);
  assert.equal((await call(`/api/sessions/${sessions.safe}`, ids.dan)).status, 404);
  assert.equal((await call(`/api/sessions/${sessions.safe}`, ids.ann, "DELETE")).status, 404, "members never mutate the session");

  const blocked = await call(`/api/story-rooms/${room.code}/join`, ids.dan, "POST");
  assert.equal(blocked.status, 403);
  assert.equal((await json(blocked)).error, "blocked");
  assert.equal((await call(`/api/story-rooms/${room.code}/actions`, ids.dan, "POST", { text: "hi" })).status, 403);

  const a1 = await call(`/api/story-rooms/${room.code}/actions`, ids.ann, "POST", { text: "  I open the door. " });
  assert.equal(a1.status, 201);
  const annAction = (await json(a1)).data;
  assert.equal(annAction.text, "I open the door.");
  assert.equal(annAction.turnId, null);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await call(`/api/story-rooms/${room.code}/actions`, ids.host, "POST", { text: "I look around." })).status, 201);
  assert.equal((await call(`/api/story-rooms/${room.code}/actions`, ids.ann, "POST", { text: "x".repeat(4001) })).status, 400);

  // Withdraw: only the author, only while unclaimed.
  const extra = (await json(await call(`/api/story-rooms/${room.code}/actions`, ids.ann, "POST", { text: "oops" }))).data;
  assert.equal((await call(`/api/story-rooms/${room.code}/actions/${extra.id}`, ids.host, "DELETE")).status, 404);
  assert.equal((await call(`/api/story-rooms/${room.code}/actions/${extra.id}`, ids.ann, "DELETE")).status, 200);

  const view = (await json(await call(`/api/story-rooms/${room.code}`, ids.ann))).data;
  assert.equal(view.pending.length, 2);
  assert.deepEqual(view.members.map((m: any) => [m.name, m.role]), [["Host", "host"], ["Ann", "player"]]);

  // Any member asks for the round; the server sends it as the host.
  const turnData = await askRound(room.code, room.id, ids.ann);
  assert.equal(turnData.actor, ids.host, "the round is the host's send");
  const roster = `[Players: Host, Ann]\n${ROSTER_GUIDE}`;
  assert.equal(turnData.content, `${roster}\n[Ann]: I open the door.\n[Host]: I look around.`);
  assert.equal(turnData.roster, roster);
  assert.deepEqual(turnData.contributions.map((c: any) => c.userId), [ids.ann, ids.host]);

  // The send path: only the host, merged content, written once.
  assert.equal(("error" in await resolveRoomTurn(sessions.safe, ids.ann, turnData.turnId, { retry: false })), true);
  const resent = await resolveRoomTurn(sessions.safe, ids.host, turnData.turnId, { retry: false });
  assert.equal("error" in resent && resent.code, "turn-already-sent");
  const nothing = await call(`/api/story-rooms/${room.code}/turn`, ids.host, "POST");
  assert.equal(nothing.status, 409);
  assert.equal((await json(nothing)).error, "nothing-to-send");

  // Mute, unmute, settings, kick.
  assert.equal((await call(`/api/story-rooms/${room.code}/mute`, ids.host, "POST", { userId: ids.ann, minutes: 5 })).status, 200);
  const muted = await call(`/api/story-rooms/${room.code}/actions`, ids.ann, "POST", { text: "hello" });
  assert.equal((await json(muted)).error, "muted");
  assert.equal((await call(`/api/story-rooms/${room.code}/mute`, ids.host, "POST", { userId: ids.ann, minutes: 0 })).status, 200);
  assert.equal((await call(`/api/story-rooms/${room.code}/actions`, ids.ann, "POST", { text: "hello" })).status, 201);
  assert.equal((await call(`/api/story-rooms/${room.code}`, ids.host, "PATCH", { mergeWindowMs: 5000 })).status, 400);
  assert.equal(room.mergeWindowMs, 60000, "a new room counts down a minute");
  const patched = (await json(await call(`/api/story-rooms/${room.code}`, ids.host, "PATCH", { turnMode: "host", mergeWindowMs: 120000, openToFriends: true }))).data;
  assert.equal(patched.turnMode, "host");
  assert.equal(patched.mergeWindowMs, 120000);
  assert.equal(patched.openToFriends, true);
  assert.equal((await call(`/api/story-rooms/${room.code}/turn`, ids.ann, "POST")).status, 403, "host mode: only the host asks");
  assert.equal((await call(`/api/story-rooms/${room.code}/ready`, ids.ann, "POST", { ready: true })).status, 200);
  const readyView = (await json(await call(`/api/story-rooms/${room.code}`, ids.host))).data;
  assert.equal(readyView.members.find((m: any) => m.userId === ids.ann).ready, true);

  assert.equal((await call(`/api/story-rooms/${room.code}/kick`, ids.host, "POST", { userId: ids.ann })).status, 200);
  const unclaimed = await db.select().from(storyRoomActions).where(and(eq(storyRoomActions.roomId, room.id), eq(storyRoomActions.userId, ids.ann)));
  assert.equal(unclaimed.filter((a) => !a.messageId).length, 0, "a kicked member's pending actions go with them");
  const rejoin = await call(`/api/story-rooms/${room.code}/join`, ids.ann, "POST");
  assert.equal(rejoin.status, 403);
  assert.equal((await json(rejoin)).error, "kicked");
  assert.equal((await call(`/api/sessions/${sessions.safe}/messages`, ids.ann)).status, 404);
  assert.equal((await call(`/api/sessions/${sessions.safe}`, ids.ann)).status, 404);

  // Closing ends it for outsiders; reopening issues a new code and reads seats from the card again.
  await db.update(storyRooms).set({ maxSeats: 3, minSeats: 3 }).where(eq(storyRooms.id, room.id));
  assert.equal((await call(`/api/story-rooms/${room.code}/close`, ids.host, "POST")).status, 200);
  assert.equal((await call(`/api/story-rooms/${room.code}`, ids.eve)).status, 410);
  const closedJoin = await call(`/api/story-rooms/${room.code}/join`, ids.eve, "POST");
  assert.equal(closedJoin.status, 410);
  const reopened = (await json(await call("/api/story-rooms", ids.host, "POST", { sessionId: sessions.safe }))).data;
  assert.equal(reopened.id, room.id);
  assert.notEqual(reopened.code, room.code);
  assert.equal(reopened.status, "open");
  assert.equal(reopened.maxSeats, 6);
  assert.equal(reopened.minSeats, 2);
});

test("an adult card's room checks every joiner, and seats run out", async () => {
  const room = (await json(await call("/api/story-rooms", ids.host, "POST", { sessionId: sessions.adult }))).data;
  for (const [actor, code] of [[ids.bea, "birth-year-required"], [ids.minor, "adult-required"], [ids.limited, "limited-content-only"]] as const) {
    const r = await call(`/api/story-rooms/${room.code}/join`, actor, "POST");
    assert.equal(r.status, 403, code);
    assert.equal((await json(r)).error, code);
  }
  assert.equal((await call(`/api/story-rooms/${room.code}/join`, ids.ann, "POST")).status, 200);
  assert.equal(await roomWithholdsUnrestrict(sessions.adult), false, "everyone passes the adult gate");

  await db.update(storyRooms).set({ maxSeats: 2 }).where(eq(storyRooms.id, room.id));
  const full = await call(`/api/story-rooms/${room.code}/join`, ids.eve, "POST");
  assert.equal(full.status, 409);
  assert.equal((await json(full)).error, "room-full");
  assert.equal((await call(`/api/story-rooms/${room.code}/join`, ids.ann, "POST")).status, 200, "rejoining a held seat is fine");
});

test("a member who fails the adult gate withholds the host's unrestrict prompts", async () => {
  const room = (await json(await call("/api/story-rooms", ids.host, "POST", { sessionId: sessions.safe }))).data;
  assert.equal(await roomWithholdsUnrestrict(sessions.safe), false);
  assert.equal((await call(`/api/story-rooms/${room.code}/join`, ids.bea, "POST")).status, 200, "an all-ages card lets Bea in");
  assert.equal(await roomWithholdsUnrestrict(sessions.safe), true);
  assert.equal((await call(`/api/story-rooms/${room.code}/leave`, ids.bea, "POST")).status, 200);
  assert.equal(await roomWithholdsUnrestrict(sessions.safe), false);
});

test("invites go to friends only and land as room_invite notifications", async () => {
  const room = (await json(await call("/api/story-rooms", ids.host, "POST", { sessionId: sessions.safe }))).data;
  assert.equal((await call(`/api/story-rooms/${room.code}/invite`, ids.ann, "POST", { userIds: [ids.eve] })).status, 403);
  assert.equal((await call(`/api/story-rooms/${room.code}/invite`, ids.host, "POST", { userIds: Array.from({ length: 12 }, (_, i) => `u${i}`) })).status, 400);
  const sent = await call(`/api/story-rooms/${room.code}/invite`, ids.host, "POST", { userIds: [ids.ann, ids.eve] });
  assert.equal(sent.status, 201);
  assert.deepEqual((await json(sent)).data, { sent: 1, skipped: 1 });
  let rows: Array<typeof notifications.$inferSelect> = [];
  for (let i = 0; i < 50 && !rows.length; i++) {
    rows = await db.select().from(notifications).where(and(eq(notifications.userId, ids.ann), eq(notifications.type, "room_invite")));
    if (!rows.length) await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(rows.length, 1);
  assert.equal((rows[0]!.payload as any).joinUrl, `/app/room/${room.code}`);
});

test("rooms open only on cards whose author turned on story multiplayer", async () => {
  for (const sessionId of [sessions.off, sessions.rules]) {
    const r = await call("/api/story-rooms", ids.host, "POST", { sessionId });
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json(), { error: "multiplayer-off", code: "multiplayer-off" });
  }
  assert.equal((await call("/api/story-rooms", ids.ann, "POST", { sessionId: sessions.off })).status, 404, "ownership first");
});

test("card roles: picked on join, one holder each, switched, freed on leave; the roster leads when the table changes", async () => {
  const created = await call("/api/story-rooms", ids.host, "POST", { sessionId: sessions.roles });
  assert.equal(created.status, 201);
  const room = (await json(created)).data;
  assert.deepEqual([room.minSeats, room.maxSeats], [2, 4]);
  const at = (path = "") => `/api/story-rooms/${room.code}${path}`;

  const outside = (await json(await call(at(), ids.ann))).data;
  assert.equal(outside.rolesRequired, true);
  assert.deepEqual(outside.roles, [
    { id: "knight", name: "Knight", note: "Holds the line", userId: null },
    { id: "mage", name: "Mage", userId: null },
    { id: "rogue", name: "Rogue", userId: null },
    { id: "bard", name: "Bard", userId: null },
  ]);

  const alone = await call(at("/turn"), ids.host, "POST");
  assert.equal(alone.status, 409);
  assert.equal((await json(alone)).error, "waiting-for-players");

  for (const [body, status, error] of [[undefined, 400, "role-required"], [{}, 400, "role-required"], [{ roleId: "pirate" }, 400, "unknown-role"]] as const) {
    const r = await call(at("/join"), ids.ann, "POST", body);
    assert.equal(r.status, status, error);
    assert.equal((await json(r)).error, error);
  }
  const joined = await call(at("/join"), ids.ann, "POST", { roleId: "knight" });
  assert.equal(joined.status, 200);
  const joinedData = (await json(joined)).data;
  const ann = joinedData.members.find((m: any) => m.userId === ids.ann);
  assert.deepEqual([ann.roleId, ann.roleName], ["knight", "Knight"]);
  assert.equal(joinedData.roles.find((r: any) => r.id === "knight").userId, ids.ann);
  const taken = await call(at("/join"), ids.eve, "POST", { roleId: "knight" });
  assert.equal(taken.status, 409);
  assert.equal((await json(taken)).error, "role-taken");

  // The host picks too.
  for (const [roleId, status, error] of [["knight", 409, "role-taken"], [null, 400, "role-required"], ["pirate", 400, "unknown-role"]] as const) {
    const r = await call(at("/role"), ids.host, "POST", { roleId });
    assert.equal(r.status, status, error);
    assert.equal((await json(r)).error, error);
  }
  const picked = await call(at("/role"), ids.host, "POST", { roleId: "mage" });
  assert.equal(picked.status, 200);
  const pickedData = (await json(picked)).data;
  assert.deepEqual([pickedData.roleId, pickedData.roleName], ["mage", "Mage"]);
  assert.equal((await call(at("/role"), ids.dan, "POST", { roleId: "rogue" })).status, 403);
  assert.equal((await call(at("/role"), ids.ann, "POST", { roleId: "knight" })).status, 200, "keeping your own role is fine");

  // Turn 1: the roster leads, speakers carry their roles.
  assert.equal((await call(at("/actions"), ids.ann, "POST", { text: "I raise my shield." })).status, 201);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await call(at("/actions"), ids.host, "POST", { text: "I cast light." })).status, 201);
  const roster1 = `[Players: Mage (Host), Knight (Ann)]\n${ROSTER_GUIDE}`;
  const t1 = await askRound(room.code, room.id, ids.host);
  assert.equal(t1.roster, roster1);
  assert.equal(t1.content, `${roster1}\n[Knight (Ann)]: I raise my shield.\n[Mage (Host)]: I cast light.`);
  assert.deepEqual(t1.contributions[0], { userId: ids.ann, name: "Ann", text: "I raise my shield.", roleId: "knight", roleName: "Knight" });
  assert.deepEqual(t1.contributions[1], { userId: ids.host, name: "Host", text: "I cast light.", roleId: "mage", roleName: "Mage" });

  // Turn 2: same table, no roster.
  await call(at("/actions"), ids.ann, "POST", { text: "I advance." });
  const t2 = await askRound(room.code, room.id, ids.ann);
  assert.equal(t2.roster, null);
  assert.equal(t2.content, "[Knight (Ann)]: I advance.");

  // Someone joins: the roster comes back. A round the host cannot pay for
  // stays unsent and shows why; asking again re-claims it, roster kept.
  assert.equal((await call(at("/join"), ids.eve, "POST", { roleId: "rogue" })).status, 200);
  await call(at("/actions"), ids.ann, "POST", { text: "I shout." });
  const roster3 = `[Players: Mage (Host), Knight (Ann), Rogue (Eve)]\n${ROSTER_GUIDE}`;
  sendAnswer = "no-credits";
  const before3 = sent.length;
  assert.equal((await call(at("/turn"), ids.host, "POST")).status, 202);
  await roundIdle(room.id);
  assert.equal(sent.length, before3, "nothing was written");
  const failedView = (await json(await call(at(), ids.ann))).data;
  assert.deepEqual([failedView.round.status, failedView.round.failedCode], ["failed", "NO_CREDITS"]);
  assert.equal(failedView.pending.length, 1, "the action waits in the round");
  sendAnswer = "ok";
  const t3again = await askRound(room.code, room.id, ids.ann);
  assert.equal(t3again.roster, roster3);
  assert.equal(t3again.content, `${roster3}\n[Knight (Ann)]: I shout.`);
  assert.equal((await json(await call(at(), ids.ann))).data.round.status, "idle", "a sent round clears the failure");

  // A role change also brings the roster back; the member change shows in the snapshot.
  const switched = await call(at("/role"), ids.eve, "POST", { roleId: "bard" });
  assert.equal(switched.status, 200);
  assert.equal((await json(switched)).data.roleName, "Bard");
  const view = (await json(await call(at(), ids.host))).data;
  assert.deepEqual(view.roles.map((r: any) => [r.id, r.userId]), [["knight", ids.ann], ["mage", ids.host], ["rogue", null], ["bard", ids.eve]]);
  assert.equal(view.members.find((m: any) => m.userId === ids.eve).roleName, "Bard");
  await call(at("/actions"), ids.eve, "POST", { text: "I play a song." });
  const t4 = await askRound(room.code, room.id, ids.eve);
  assert.equal(t4.content, `[Players: Mage (Host), Knight (Ann), Bard (Eve)]\n${ROSTER_GUIDE}\n[Bard (Eve)]: I play a song.`);

  // Leaving frees the role; coming back means picking again.
  assert.equal((await call(at("/leave"), ids.eve, "POST")).status, 200);
  const after = (await json(await call(at(), ids.host))).data;
  assert.equal(after.roles.find((r: any) => r.id === "bard").userId, null);
  const [eveRow] = await db.select().from(storyRoomMembers).where(and(eq(storyRoomMembers.roomId, room.id), eq(storyRoomMembers.userId, ids.eve)));
  assert.deepEqual([eveRow!.roleId, eveRow!.roleName], [null, null]);
  assert.equal((await json(await call(at("/join"), ids.eve, "POST"))).error, "role-required");
  assert.equal((await call(at("/join"), ids.eve, "POST", { roleId: "bard" })).status, 200);
});

test("the server sends the round itself once everyone online has acted; hold waits; table talk never reaches the AI", async () => {
  const room = (await json(await call("/api/story-rooms", ids.host, "POST", { sessionId: sessions.auto }))).data;
  const at = (path = "") => `/api/story-rooms/${room.code}${path}`;
  assert.equal((await call(at("/join"), ids.ann, "POST")).status, 200);
  await touchOnline(room.id, ids.host);
  await touchOnline(room.id, ids.ann);

  // The host's line waits (AI 先别接): no countdown, nothing sent.
  const held = await call(at("/actions"), ids.host, "POST", { text: "I wait by the gate.", hold: true });
  assert.equal(held.status, 201);
  assert.equal((await json(held)).data.hold, true);
  const talk = await call(at("/actions"), ids.ann, "POST", { text: "go left?", kind: "talk" });
  assert.equal(talk.status, 201);
  assert.equal((await call(at("/actions"), ids.ann, "POST", { text: "x".repeat(1001), kind: "talk" })).status, 400);
  assert.equal((await call(at("/actions"), ids.ann, "POST", { text: "hm", kind: "shout" })).status, 400);
  await new Promise((r) => setTimeout(r, 60));
  const heldView = (await json(await call(at(), ids.ann))).data;
  assert.equal(heldView.round.status, "held");
  assert.equal(heldView.pending.length, 1, "talk is not part of the round");
  assert.deepEqual(heldView.talk.map((l: any) => [l.name, l.text]), [["Ann", "go left?"]]);
  assert.equal(heldView.recap, null, "no story yet, no recap");
  assert.equal(heldView.profileSet, undefined, "only the host learns whether a profile is set");

  // The host registers what rounds are sent with.
  assert.equal((await call(at("/profile"), ids.ann, "PUT", { model: "x" })).status, 403);
  assert.equal((await call(at("/profile"), ids.host, "PUT", "nope")).status, 400);
  assert.equal((await call(at("/profile"), ids.host, "PUT", {
    model: "deepseek/deepseek-v4", overrides: { temperature: 0.8, maxTokens: 2048, evil: "x" }, scene: { panel: "gate" },
  })).status, 200);
  assert.equal((await json(await call(at(), ids.host))).data.profileSet, true);

  // Ann acts: everyone online has acted, so it goes now, without anyone asking.
  const before = sent.length;
  assert.equal((await call(at("/actions"), ids.ann, "POST", { text: "I climb the wall." })).status, 201);
  const round = await waitFor(() => sent[before], "the round to go on its own");
  await roundIdle(room.id);
  assert.equal(round.actor, ids.host);
  assert.equal(round.body.model, "deepseek/deepseek-v4");
  assert.deepEqual(round.body.overrides, { temperature: 0.8, maxTokens: 2048 });
  assert.deepEqual(round.body.scene, { panel: "gate" });
  assert.match(round.content, /\[Host\]: I wait by the gate\.\n\[Ann\]: I climb the wall\.$/);
  assert.doesNotMatch(round.content, /go left/);
  const after = (await json(await call(at(), ids.ann))).data;
  assert.equal(after.round.status, "idle");
  assert.equal(after.pending.length, 0);
  assert.equal(after.talk.length, 1, "talk stays");

  // Typing is accepted for members only.
  assert.equal((await call(at("/typing"), ids.ann, "POST", {})).status, 200);
  assert.equal((await call(at("/typing"), ids.eve, "POST", {})).status, 403);
});

test("friends see a room on the card page only when the host lets friends in", async () => {
  const room = (await json(await call("/api/story-rooms", ids.host, "POST", { sessionId: sessions.real }))).data;
  const worldId = room.worldId;
  assert.deepEqual((await json(await call(`/api/story-rooms/friends/${worldId}`, ids.ann))).data, []);
  assert.equal((await call(`/api/story-rooms/${room.code}`, ids.host, "PATCH", { openToFriends: true })).status, 200);
  const listed = (await json(await call(`/api/story-rooms/friends/${worldId}`, ids.ann))).data;
  assert.deepEqual(listed.map((r: any) => [r.code, r.hostName, r.members]), [[room.code, "Host", 1]]);
  assert.deepEqual((await json(await call(`/api/story-rooms/friends/${worldId}`, ids.eve))).data, [], "not a friend of the host");
  assert.equal((await call(`/api/story-rooms/${room.code}/close`, ids.host, "POST")).status, 200);
  assert.deepEqual((await json(await call(`/api/story-rooms/friends/${worldId}`, ids.ann))).data, []);
});

test("a real round goes through the chat send as the host", async () => {
  // The whole app this time: the round reaches routes/messages.ts with the host as the actor,
  // through a middleware that rebuilds the Request first (as request-body-limit does in production).
  const rebuilt = new Hono();
  rebuilt.use("*", async (c, next) => {
    c.req.raw = new Request(c.req.raw, { body: await c.req.raw.clone().arrayBuffer() });
    await next();
  });
  rebuilt.route("/", app);
  registerStoryRoomRunner(rebuilt, { sweep: false });
  try {
    const room = (await json(await call("/api/story-rooms", ids.host, "POST", { sessionId: sessions.real }))).data;
    const at = (path = "") => `/api/story-rooms/${room.code}${path}`;
    assert.equal((await call(at("/join"), ids.ann, "POST")).status, 200);
    assert.equal((await call(at("/actions"), ids.ann, "POST", { text: "I knock." })).status, 201);
    assert.equal((await call(at("/turn"), ids.ann, "POST")).status, 202);
    await roundIdle(room.id);
    const view = (await json(await call(at(), ids.ann))).data;
    // Whatever the send answered (no AI key in tests), it was the host's send of this round:
    // either the user message was written, or the round failed with the send's own code.
    const [row] = await db.select().from(storyRoomActions).where(eq(storyRoomActions.roomId, room.id));
    if (row!.messageId) assert.equal(view.round.status, "idle");
    else assert.equal(view.round.status, "failed");
    assert.notEqual(view.round.failedCode, "error", `the send answered with a real code (${view.round.failedCode})`);
  } finally {
    registerStoryRoomRunner(fakeSend, { sweep: false });
  }
});

test("the recap reads the memory summary's story section, as plain text", () => {
  assert.equal(storySoFar("## Story So Far\nAnn left.\nBea stayed.\n\n## Major Open Threads\n- x"), "Ann left.\nBea stayed.");
  assert.equal(storySoFar("plain summary"), "plain summary");
  assert.equal(plainExcerpt("<p>Hi <b>there</b></p>\n\n\n\n[hp: -3] ok", 50), "Hi there\n\nok");
  assert.equal(plainExcerpt("abcdef", 3), "abc…");
});

test("an internal actor token works once, only from this process", async () => {
  const forged = await call(`/api/sessions/${sessions.safe}/messages`, "", "POST", {});
  assert.equal(forged.status, 401);
  const guessed = await app.request(`/api/sessions/${sessions.safe}/messages`, { method: "POST", headers: { [INTERNAL_ACTOR_HEADER]: "guess", "content-type": "application/json" }, body: "{}" });
  assert.equal(guessed.status, 401, "an unknown token is no one");
  const { internalActorHeaders } = await import("../lib/internal-actor.js");
  const headers = internalActorHeaders(ids.host, "story-room-round");
  const probe = new Request("http://x/", { headers });
  assert.equal(takeInternalActor(probe)?.userId, ids.host);
  assert.equal(takeInternalActor(probe), null, "used up");
});

test("another player's action reads as acted, not its words, until the round is sent", async () => {
  const room = (await json(await call("/api/story-rooms", ids.host, "POST", { sessionId: sessions.ui }))).data;
  const at = (path = "") => `/api/story-rooms/${room.code}${path}`;
  assert.equal((await call(at("/join"), ids.ann, "POST")).status, 200);
  assert.equal((await call(at("/actions"), ids.ann, "POST", { text: "I read the will in secret.", hold: true })).status, 201);
  const hostView = (await json(await call(at(), ids.host))).data;
  assert.deepEqual(hostView.pending.map((a: any) => [a.name, a.text]), [["Ann", ""]], "the host sees Ann acted, not what she wrote");
  const annView = (await json(await call(at(), ids.ann))).data;
  assert.equal(annView.pending[0].text, "I read the will in secret.", "Ann sees her own");

  // A member's press on the card's screen changes the shared game, variables only.
  const pressed = await call(`/api/sessions/${sessions.ui}/state`, ids.ann, "PATCH", { state: { variables: { door: "open" }, metadata: { pendingContext: [{ message: "x" }] } } });
  assert.equal(pressed.status, 200, await pressed.clone().text());
  const [row] = await db.select({ state: playSessions.state }).from(playSessions).where(eq(playSessions.id, sessions.ui));
  assert.equal((row!.state as any).variables.door, "open");
  assert.equal((row!.state as any).metadata?.pendingContext, undefined, "a member writes variables only");
  assert.equal((await call(`/api/sessions/${sessions.ui}/state`, ids.eve, "PATCH", { state: { variables: { door: "gone" } } })).status, 404, "outsiders cannot");
  assert.equal((await call(`/api/sessions/${sessions.ui}/execute-action`, ids.ann, "POST", { clock: 5 })).status, 404, "the clock is the host's");
  assert.equal((await call(`/api/story-rooms/${room.code}/mute`, ids.host, "POST", { userId: ids.ann, minutes: 10 })).status, 200);
  assert.equal((await call(`/api/sessions/${sessions.ui}/state`, ids.ann, "PATCH", { state: { variables: { door: "shut" } } })).status, 404, "a muted player cannot move the game");
});

test("the host's spend limit stops the room's rounds until it is raised", async () => {
  const room = (await json(await call("/api/story-rooms", ids.host, "POST", { sessionId: sessions.cap }))).data;
  const at = (path = "") => `/api/story-rooms/${room.code}${path}`;
  assert.equal(room.spendCap, 5000, "a generous limit by default");
  assert.equal((await call(at("/join"), ids.ann, "POST")).status, 200);
  assert.equal((await call(at(), ids.ann, "PATCH", { spendCap: 100 })).status, 403);
  assert.equal((await call(at(), ids.host, "PATCH", { spendCap: 5 })).status, 400);
  assert.equal((await call(at(), ids.host, "PATCH", { spendCap: 100 })).status, 200);

  // 150 mushies already went on this room's session.
  const [wallet] = await db.insert(creditWallets).values({ userId: ids.host, balance: 1000 }).onConflictDoNothing().returning();
  const walletId = wallet?.id ?? (await db.select().from(creditWallets).where(eq(creditWallets.userId, ids.host)))[0]!.id;
  const [log] = await db.insert(usageLogs).values({ userId: ids.host, sessionId: sessions.cap, model: "m", endpoint: "send" }).returning();
  await db.insert(creditTransactions).values({ walletId, amount: -150, type: "usage", referenceId: log!.id, balanceAfter: 850 });
  assert.equal((await json(await call(at(), ids.host))).data.spent, 150);
  assert.equal((await json(await call(at(), ids.ann))).data.spent, undefined, "only the host sees it");

  assert.equal((await call(at("/actions"), ids.ann, "POST", { text: "I knock." })).status, 201);
  const refused = await call(at("/turn"), ids.ann, "POST");
  assert.equal(refused.status, 409);
  assert.equal((await json(refused)).code, "spend-cap");
  const stopped = await waitFor(async () => {
    const v = (await json(await call(at(), ids.ann))).data;
    return v.round.status === "failed" && v;
  }, "the round to stop at the limit");
  assert.equal(stopped.round.failedCode, "spend-cap");

  // Raising it lets the same round go.
  const before = sent.length;
  assert.equal((await call(at(), ids.host, "PATCH", { spendCap: null })).status, 200);
  await askRound(room.code, room.id, ids.ann);
  assert.match(sent[before]!.content, /I knock\./);
});

test("public rooms: only on a published card, split by default, consent to join and to act, listed with a free seat", async () => {
  const [pub] = await db.insert(worlds).values({ creatorId: ids.host, name: "Plaza", status: "published", isPublished: true, schema: { id: "w-pub", name: "Plaza", entries: [], variables: [], settings: { multiplayer: storyOn } } }).returning();
  const sid = `${p}-s-pub`;
  await db.insert(playSessions).values({ id: sid, userId: ids.host, worldId: pub!.id });
  const room = (await json(await call("/api/story-rooms", ids.host, "POST", { sessionId: sid }))).data;

  // A draft card has no public rooms.
  const draft = (await json(await call("/api/story-rooms", ids.host, "POST", { sessionId: sessions.auto }))).data;
  assert.equal((await json(await call(`/api/story-rooms/${draft.code}`, ids.host, "PATCH", { isPublic: true }))).code, "card-not-published");

  const made = (await json(await call(`/api/story-rooms/${room.code}`, ids.host, "PATCH", { isPublic: true }))).data;
  assert.deepEqual([made.isPublic, made.costMode], [true, "split"], "public splits unless the host says they treat");
  const listed = (await json(await call(`/api/story-rooms/public/${pub!.id}`, ids.eve))).data;
  assert.deepEqual(listed.map((r: any) => [r.code, r.costMode, r.members]), [[room.code, "split", 1]], "a stranger sees it");
  assert.deepEqual((await json(await call(`/api/story-rooms/public/${pub!.id}`, ids.host))).data, [], "not my own room");

  assert.equal((await json(await call(`/api/story-rooms/${room.code}/join`, ids.eve, "POST", {}))).code, "split-consent-required");
  const joined = await json(await call(`/api/story-rooms/${room.code}/join`, ids.eve, "POST", { acceptSplit: true }));
  assert.equal(joined.data.cost.mode, "split");
  assert.equal(joined.data.members.find((m: any) => m.userId === ids.eve).splitOk, true);

  // The host treats, then switches back to split: Eve agrees again before acting.
  await call(`/api/story-rooms/${room.code}`, ids.host, "PATCH", { costMode: "host" });
  assert.equal((await call(`/api/story-rooms/${room.code}/join`, ids.ann, "POST", {})).status, 200, "a host-pays room asks nothing");
  await call(`/api/story-rooms/${room.code}`, ids.host, "PATCH", { costMode: "split" });
  assert.equal((await json(await call(`/api/story-rooms/${room.code}/actions`, ids.eve, "POST", { text: "I wave" }))).code, "split-consent-required");
  assert.equal((await call(`/api/story-rooms/${room.code}/actions`, ids.eve, "POST", { text: "psst", kind: "talk" })).status, 201, "table talk costs nothing");
  assert.equal((await call(`/api/story-rooms/${room.code}/split-ok`, ids.eve, "POST")).status, 200);
  const acted = await call(`/api/story-rooms/${room.code}/actions`, ids.eve, "POST", { text: "I wave", hold: true });
  assert.ok(acted.status === 201 || (await json(acted)).code === "split-no-credits", `acts once agreed (${acted.status})`);

  // The host leaving dissolves it, and it leaves the list.
  assert.equal((await call(`/api/story-rooms/${room.code}/leave`, ids.host, "POST")).status, 200);
  assert.equal((await json(await call(`/api/story-rooms/${room.code}`, ids.host))).data.room.status, "closed");
  assert.deepEqual((await json(await call(`/api/story-rooms/public/${pub!.id}`, ids.dan))).data, []);
  await call(`/api/story-rooms/${draft.code}/close`, ids.host, "POST");
});

test("an untimed room accepts window 0; other windows stay in range", async () => {
  const room = (await json(await call("/api/story-rooms", ids.host, "POST", { sessionId: sessions.cap }))).data;
  assert.equal((await json(await call(`/api/story-rooms/${room.code}`, ids.host, "PATCH", { mergeWindowMs: 0 }))).data.mergeWindowMs, 0);
  assert.equal((await call(`/api/story-rooms/${room.code}`, ids.host, "PATCH", { mergeWindowMs: 5 })).status, 400);
  await call(`/api/story-rooms/${room.code}/close`, ids.host, "POST");
});
