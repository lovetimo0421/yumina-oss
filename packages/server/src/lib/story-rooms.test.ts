import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { storyRoomsSql } from "../db/story-rooms.js";
import {
  ROOM_CODE_ALPHABET,
  ROSTER_GUIDE,
  decideRound,
  hostGone,
  roundActionKey,
  adultGateFailure,
  buildMergedTurn,
  buildRosterLine,
  canJoinAdultWorld,
  generateRoomCode,
  hasBlockWithAny,
  isAdultWorld,
  joinDecision,
  normalizeRoomCode,
  roleDecision,
  storyRoomCard,
  uniqueRoomCode,
} from "./story-rooms.js";
import { StoryRoomTee } from "./story-room-tee.js";

const thisYear = new Date().getFullYear();

test("the SQL file applied by hand is exactly the boot DDL", () => {
  const file = readFileSync(new URL("../../scripts/story-rooms.sql", import.meta.url), "utf8").replace(/\r\n?/g, "\n");
  assert.equal(file.replace(/^(--.*\n)+/, ""), storyRoomsSql());
});

test("room codes are 6 characters from the unambiguous alphabet", () => {
  assert.equal(ROOM_CODE_ALPHABET, "ABCDEFGHJKLMNPQRSTUVWXYZ23456789");
  for (let i = 0; i < 200; i++) assert.match(generateRoomCode(), /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(generateRoomCode(() => 0), "AAAAAA");
  assert.equal(generateRoomCode((max) => max - 1), "999999");
});

test("room codes normalize case and reject look-alikes", () => {
  assert.equal(normalizeRoomCode(" ab2c9z "), "AB2C9Z");
  assert.equal(normalizeRoomCode("AB0C9Z"), null);
  assert.equal(normalizeRoomCode("ABIC9Z"), null);
  assert.equal(normalizeRoomCode("ABC"), null);
});

test("a colliding code is retried, and a full space gives up", async () => {
  const seen: string[] = [];
  let n = 0;
  const code = await uniqueRoomCode(async (c) => { seen.push(c); return seen.length < 3; }, () => n++ % 32);
  assert.equal(seen.length, 3);
  assert.equal(code, seen[2]);
  await assert.rejects(uniqueRoomCode(async () => true, undefined, 4));
});

test("the merged turn is one [Name]: text line per action, oldest first", () => {
  const merged = buildMergedTurn([
    { id: "b", userId: "u2", name: "Bea", text: "  I draw my sword. ", createdAt: "2026-11-14T10:00:02Z" },
    { id: "a", userId: "u1", name: "Ann", text: "I open the door.", createdAt: new Date("2026-11-14T10:00:01Z") },
    { id: "c", userId: "u1", name: "Ann", text: "Then I wave.", createdAt: "2026-11-14T10:00:02Z" },
  ]);
  assert.equal(merged.content, "[Ann]: I open the door.\n[Bea]: I draw my sword.\n[Ann]: Then I wave.");
  assert.deepEqual(merged.contributions, [
    { userId: "u1", name: "Ann", text: "I open the door." },
    { userId: "u2", name: "Bea", text: "I draw my sword." },
    { userId: "u1", name: "Ann", text: "Then I wave." },
  ]);
});

test("a display name cannot forge another speaker's line", () => {
  const merged = buildMergedTurn([{ userId: "u", name: "Ann]: hi\n[Host", text: "x", createdAt: "2026-01-01" }]);
  assert.equal(merged.content, "[Ann : hi Host]: x");
  assert.equal(buildMergedTurn([{ userId: "u", name: "  ", text: "x", createdAt: "2026-01-01" }]).content, "[Player]: x");
});

test("a held role joins the speaker label and the contribution", () => {
  const merged = buildMergedTurn([
    { id: "a", userId: "u1", name: "Ann", text: "I raise my shield.", createdAt: "2026-11-14T10:00:01Z", roleId: "knight", roleName: "Knight" },
    { id: "b", userId: "u2", name: "Bea", text: "I watch.", createdAt: "2026-11-14T10:00:02Z", roleId: null, roleName: null },
    { id: "c", userId: "u3", name: "Cy", text: "Hi.", createdAt: "2026-11-14T10:00:03Z", roleId: "x", roleName: "Sly]: hi\n[Host" },
  ]);
  assert.equal(merged.content, "[Knight (Ann)]: I raise my shield.\n[Bea]: I watch.\n[Sly : hi Host (Cy)]: Hi.");
  assert.deepEqual(merged.contributions, [
    { userId: "u1", name: "Ann", text: "I raise my shield.", roleId: "knight", roleName: "Knight" },
    { userId: "u2", name: "Bea", text: "I watch." },
    { userId: "u3", name: "Cy", text: "Hi.", roleId: "x", roleName: "Sly : hi Host" },
  ]);
});

test("a roster line leads the merged turn when given", () => {
  const actions = [{ userId: "u1", name: "Ann", text: "Go.", createdAt: "2026-01-01", roleId: "knight", roleName: "Knight" }];
  assert.equal(buildMergedTurn(actions, "[Players: Knight (Ann), Host]").content, "[Players: Knight (Ann), Host]\n[Knight (Ann)]: Go.");
  assert.equal(buildMergedTurn(actions, null).content, "[Knight (Ann)]: Go.");
});

test("the roster line lists members in order, roles leading names, cleaned, then how to read the round", () => {
  assert.equal(
    buildRosterLine([{ name: "Ann", roleName: "Knight" }, { name: "Bea", roleName: "Mage" }, { name: "Host", roleName: null }]),
    `[Players: Knight (Ann), Mage (Bea), Host]\n${ROSTER_GUIDE}`,
  );
  assert.equal(buildRosterLine([{ name: "[Evil]\nName", roleName: " [Ro]le " }, { name: " " }]), `[Players: Ro le (Evil Name), Player]\n${ROSTER_GUIDE}`);
});

test("a round goes when its countdown runs out or everyone online has acted; hold, host mode and failures wait", () => {
  const room = { status: "open", turnMode: "free", mergeWindowMs: 60_000, minSeats: 2 };
  const members = [
    { userId: "h", online: true, ready: false },
    { userId: "a", online: true, ready: false },
    { userId: "b", online: false, ready: false },
  ];
  const act = (id: string, userId: string, at: number, hold = false) => ({ id, userId, createdAt: at, hold, turnId: null });
  const base = { room, members, actions: [] as ReturnType<typeof act>[], writing: false, lastDoneAt: null, failed: null, now: 1_000 };
  assert.deepEqual(decideRound(base), { round: { status: "idle", dueAt: null, windowMs: 60_000 }, fire: false });
  // One action starts a minute; the offline member does not hold it up.
  const one = decideRound({ ...base, actions: [act("1", "h", 1_000)], now: 5_000 });
  assert.deepEqual(one, { round: { status: "counting", dueAt: 61_000, windowMs: 60_000 }, fire: false });
  assert.equal(decideRound({ ...base, actions: [act("1", "h", 1_000)], now: 61_000 }).fire, true, "time is up");
  assert.equal(decideRound({ ...base, actions: [act("1", "h", 1_000), act("2", "a", 2_000)], now: 3_000 }).fire, true, "everyone online acted");
  assert.equal(decideRound({ ...base, members: members.map((m) => (m.userId === "a" ? { ...m, ready: true } : m)), actions: [act("1", "h", 1_000)], now: 3_000 }).fire, true, "ready counts as acted");
  // Actions written while the AI wrote count from the end of the reply.
  assert.equal(decideRound({ ...base, actions: [act("1", "h", 1_000)], lastDoneAt: 30_000, now: 62_000 }).round.dueAt, 90_000);
  // AI 先别接: a held round neither counts down nor goes when everyone acted.
  const held = decideRound({ ...base, actions: [act("1", "h", 1_000, true), act("2", "a", 2_000, true)], now: 99_000 });
  assert.deepEqual([held.round.status, held.fire], ["held", false]);
  assert.equal(decideRound({ ...base, actions: [act("1", "h", 1_000, true), act("2", "a", 50_000)], now: 52_000 }).round.dueAt, 110_000, "the first non-hold action starts it");
  assert.equal(decideRound({ ...base, room: { ...room, turnMode: "host" }, actions: [act("1", "h", 1_000)], now: 99_000 }).round.status, "held");
  assert.equal(decideRound({ ...base, writing: true, actions: [act("1", "h", 1_000)] }).round.status, "writing");
  assert.deepEqual(decideRound({ ...base, members: members.slice(0, 1), actions: [act("1", "h", 1_000)] }).round,
    { status: "waiting", dueAt: null, windowMs: 60_000, need: { have: 1, need: 2 } });
  // The same failed set waits; a new action tries again.
  const failed = { ids: roundActionKey(["1"]), code: "NO_CREDITS" };
  assert.deepEqual(decideRound({ ...base, actions: [act("1", "h", 1_000)], failed, now: 99_000 }),
    { round: { status: "failed", dueAt: null, windowMs: 60_000, failedCode: "NO_CREDITS" }, fire: false });
  assert.equal(decideRound({ ...base, actions: [act("1", "h", 1_000), act("2", "a", 2_000)], failed, now: 99_000 }).fire, true);
});

test("an untimed room never sends on the clock, only when everyone online is done", () => {
  const room = { status: "open", turnMode: "free", mergeWindowMs: 0, minSeats: 2 };
  const members = [
    { userId: "h", online: true, ready: false },
    { userId: "a", online: true, ready: false },
  ];
  const act = (id: string, userId: string, at: number) => ({ id, userId, createdAt: at, hold: false, turnId: null });
  const base = { room, members, actions: [act("1", "h", 1_000)], writing: false, lastDoneAt: null, failed: null, now: 10_000_000 };
  assert.deepEqual(decideRound(base), { round: { status: "counting", dueAt: null, windowMs: 0 }, fire: false }, "an hour later, still waiting");
  assert.equal(decideRound({ ...base, actions: [act("1", "h", 1_000), act("2", "a", 2_000)] }).fire, true, "everyone acted");
  assert.equal(decideRound({ ...base, members: [members[0]!, { ...members[1]!, ready: true }] }).fire, true, "ready counts");
});

test("the room dissolves once the host has been away past the grace", () => {
  const min = 60_000;
  assert.equal(hostGone({ hostOnline: true, lastSeenAt: 0, openedAt: 0, now: 99 * min }), false, "online host");
  assert.equal(hostGone({ hostOnline: false, lastSeenAt: 10 * min, openedAt: 0, now: 11 * min }), false, "a refresh or a short drop");
  assert.equal(hostGone({ hostOnline: false, lastSeenAt: 10 * min, openedAt: 0, now: 12 * min + 1 }), true, "gone over two minutes");
  assert.equal(hostGone({ hostOnline: false, lastSeenAt: null, openedAt: 5 * min, now: 6 * min }), false, "a fresh room before the host's page connects");
  assert.equal(hostGone({ hostOnline: false, lastSeenAt: null, openedAt: 5 * min, now: 8 * min }), true, "never came back");
});

test("role decision: required, unknown, taken, keep, switch, drop", () => {
  const roles = [{ id: "knight", name: "Knight" }, { id: "mage", name: "Mage" }];
  const holders: Record<string, string> = { knight: "ann" };
  const base = { roles, rolesRequired: true, holderOf: (id: string) => holders[id] ?? null, userId: "bea", currentRoleId: null };
  assert.deepEqual(roleDecision({ ...base, requested: undefined }), { error: "role-required" });
  assert.deepEqual(roleDecision({ ...base, requested: null }), { error: "role-required" });
  assert.deepEqual(roleDecision({ ...base, requested: "bard" }), { error: "unknown-role" });
  assert.deepEqual(roleDecision({ ...base, requested: "knight" }), { error: "role-taken" });
  assert.deepEqual(roleDecision({ ...base, requested: "mage" }), { role: roles[1] });
  // Ann keeps her own role, by asking for it again or by not asking.
  assert.deepEqual(roleDecision({ ...base, userId: "ann", currentRoleId: "knight", requested: "knight" }), { role: roles[0] });
  assert.deepEqual(roleDecision({ ...base, userId: "ann", currentRoleId: "knight", requested: undefined }), { role: roles[0] });
  assert.deepEqual(roleDecision({ ...base, userId: "ann", currentRoleId: "knight", requested: "mage" }), { role: roles[1] });
  // Optional roles: none is fine, dropping is fine, a stale kept role reads as none.
  const optional = { ...base, rolesRequired: false };
  assert.deepEqual(roleDecision({ ...optional, requested: undefined }), { role: null });
  assert.deepEqual(roleDecision({ ...optional, userId: "ann", currentRoleId: "knight", requested: null }), { role: null });
  assert.deepEqual(roleDecision({ ...optional, currentRoleId: "gone", requested: undefined }), { role: null });
  assert.deepEqual(roleDecision({ ...base, currentRoleId: "gone", requested: undefined }), { error: "role-required" });
  assert.deepEqual(roleDecision({ ...optional, roles: [], requested: "knight" }), { error: "unknown-role" });
});

test("story rooms read the card's multiplayer setting, story mode only", () => {
  assert.equal(storyRoomCard(undefined).enabled, false);
  assert.equal(storyRoomCard({ enabled: false, mode: "story" }).enabled, false);
  const rules = storyRoomCard({ enabled: true, mode: "rules", roles: [{ id: "a", name: "A" }], rolesRequired: true });
  assert.deepEqual([rules.enabled, rules.roles, rules.rolesRequired], [false, [], false]);
  const story = storyRoomCard({ enabled: true, mode: "story", minSeats: 3, maxSeats: 40, roles: [{ id: "a", name: "A", note: "n" }], rolesRequired: true });
  assert.deepEqual(story, { enabled: true, minSeats: 3, maxSeats: 12, roles: [{ id: "a", name: "A", note: "n" }], rolesRequired: true });
});

test("adult gate: birth year, 18+, non-safe level, not Limited-only", () => {
  const adult = { birthYear: thisYear - 30, contentLevel: "r18", limitedContentOnly: false };
  assert.equal(adultGateFailure(adult), null);
  assert.equal(canJoinAdultWorld(adult), true);
  assert.equal(adultGateFailure({ ...adult, birthYear: null }), "birth-year-required");
  assert.equal(adultGateFailure({ ...adult, birthYear: thisYear - 15 }), "adult-required");
  assert.equal(adultGateFailure({ ...adult, contentLevel: "safe" }), "adult-required");
  assert.equal(adultGateFailure({ ...adult, contentLevel: undefined }), "adult-required");
  assert.equal(adultGateFailure({ ...adult, limitedContentOnly: true }), "limited-content-only");
  // preferences.contentLevel is read when the flat field is absent.
  assert.equal(adultGateFailure({ birthYear: thisYear - 30, preferences: { contentLevel: "sensitive" } }), null);
  assert.equal(canJoinAdultWorld({ birthYear: thisYear - 30, preferences: { contentLevel: "safe" } }), false);
});

test("a world is adult when rated above Limited or flagged NSFW", () => {
  assert.equal(isAdultWorld({ ageRating: "all", isNsfw: false }), false);
  assert.equal(isAdultWorld({ ageRating: null, isNsfw: null }), false);
  assert.equal(isAdultWorld({ ageRating: "r18", isNsfw: false }), true);
  assert.equal(isAdultWorld({ ageRating: "all", isNsfw: true }), true);
});

test("block check looks both ways and only at current members", () => {
  const blocks = [
    { blockerId: "x", blockedId: "me" },
    { blockerId: "me", blockedId: "y" },
  ];
  assert.equal(hasBlockWithAny("me", ["a", "b"], blocks), false);
  assert.equal(hasBlockWithAny("me", ["a", "x"], blocks), true);
  assert.equal(hasBlockWithAny("me", ["y"], blocks), true);
  assert.equal(hasBlockWithAny("me", ["me"], [{ blockerId: "me", blockedId: "me" }]), false);
});

test("join decision: closed, kicked, blocked, adult gate, then seats", () => {
  const base = {
    status: "open" as const, kicked: false, alreadyActive: false, activeCount: 3, maxSeats: 12,
    blocked: false, adultWorld: false, gate: null,
  };
  assert.equal(joinDecision(base), null);
  assert.equal(joinDecision({ ...base, status: "closed" }), "closed");
  assert.equal(joinDecision({ ...base, kicked: true }), "kicked");
  assert.equal(joinDecision({ ...base, blocked: true }), "blocked");
  assert.equal(joinDecision({ ...base, adultWorld: true, gate: "birth-year-required" }), "birth-year-required");
  assert.equal(joinDecision({ ...base, adultWorld: false, gate: "adult-required" }), null);
  assert.equal(joinDecision({ ...base, activeCount: 12 }), "room-full");
  assert.equal(joinDecision({ ...base, activeCount: 12, alreadyActive: true }), null);
});

test("the tee mirrors stream events in order, keeps the host's receipts, and ends with turn-done", async () => {
  const published: Array<{ key: string; event: string; payload: Record<string, unknown> }> = [];
  const tee = new StoryRoomTee("room1", "turn1", async (key, event, payload) => {
    await new Promise((r) => setTimeout(r, Math.random() * 3));
    published.push({ key, event, payload });
  });
  tee.forward({ event: "text", data: JSON.stringify({ content: "Hel" }) });
  tee.forward({ event: "ping", data: "{}" });
  tee.forward({ event: "text", data: JSON.stringify({ content: "lo" }) });
  tee.forward({ event: "done", data: JSON.stringify({ messageId: "m2", userMessageId: "m1", content: "Hello", promptTrace: { secret: 1 }, credits: { balance: 5 }, consentNeeded: [] }) });
  await tee.finish();
  tee.forward({ event: "text", data: "{}" });
  await tee.finish();

  assert.ok(published.every((p) => p.key === "story-room:room1"));
  assert.deepEqual(published.map((p) => p.event), ["stream", "stream", "stream", "turn-done"]);
  assert.deepEqual(published[0]!.payload, { event: "text", data: { content: "Hel" } });
  assert.deepEqual(published[2]!.payload, { event: "done", data: { messageId: "m2", userMessageId: "m1", content: "Hello" } });
  assert.deepEqual(published[3]!.payload, { messageId: "m2", userMessageId: "m1", turnId: "turn1" });
});

test("the tee flags an errored or unfinished turn", async () => {
  const events: Array<Record<string, unknown>> = [];
  const failed = new StoryRoomTee("r", null, async (_k, event, payload) => { if (event === "turn-done") events.push(payload); });
  failed.forward({ event: "error", data: JSON.stringify({ error: "boom" }) });
  await failed.finish();
  const stopped = new StoryRoomTee("r", "t", async (_k, event, payload) => { if (event === "turn-done") events.push(payload); });
  stopped.forward({ event: "text", data: "not json" });
  await stopped.finish();
  assert.deepEqual(events, [
    { messageId: null, userMessageId: null, turnId: null, error: true },
    { messageId: null, userMessageId: null, turnId: "t", error: true },
  ]);
});

test("a failing publish never breaks the host's stream", async () => {
  const tee = new StoryRoomTee("r", null, async () => { throw new Error("redis down"); });
  const warn = console.warn;
  console.warn = () => {};
  try {
    tee.forward({ event: "text", data: "{}" });
    await tee.finish();
  } finally {
    console.warn = warn;
  }
});

test("a player with no card role plays as their own persona", () => {
  const merged = buildMergedTurn([
    { userId: "a", name: "林雾", text: "我推开门", createdAt: "2026-01-01T00:00:00Z", personaName: "莉娅" },
    { userId: "b", name: "阿岚", text: "我跟上", createdAt: "2026-01-01T00:00:01Z", roleId: "r1", roleName: "骑士", personaName: "不用" },
    { userId: "c", name: "Bo", text: "看看", createdAt: "2026-01-01T00:00:02Z" },
  ]);
  assert.equal(merged.content, "[莉娅 (林雾)]: 我推开门\n[骑士 (阿岚)]: 我跟上\n[Bo]: 看看");
  assert.deepEqual(merged.contributions[0], { userId: "a", name: "林雾", text: "我推开门", roleName: "莉娅" });
  assert.equal(merged.contributions[1]!.roleName, "骑士", "a card role wins over the persona");
  const roster = buildRosterLine([
    { name: "林雾", persona: { name: "莉娅", about: "红发的酒馆老板娘，说话很冲" } },
    { name: "阿岚", roleName: "骑士", persona: { name: "不用", about: "不该出现" } },
    { name: "Bo" },
  ]);
  assert.match(roster, /^\[Players: 莉娅 \(林雾\), 骑士 \(阿岚\), Bo\]/);
  assert.match(roster, /\[莉娅 \(林雾\): 红发的酒馆老板娘，说话很冲\]$/);
  assert.doesNotMatch(roster, /不该出现/);
});
