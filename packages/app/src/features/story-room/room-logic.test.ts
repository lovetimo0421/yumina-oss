import assert from "node:assert/strict";
import test from "node:test";
import type { Action, Member, Room, RoomSnapshot } from "./api";
import {
  applyRoomEvent,
  mirrorRoomEvent,
  parseTableCode,
  roleChoices,
  normaliseRound,
  roundState,
  seatRange,
  storyRoomSetting,
  storyRoomUI,
  tableInvitePath,
  type MirrorState,
  applyStreamEvent,
  countdownFraction,
  EMPTY_ROOM_VIEW,
  IDLE_REPLY,
  joinErrorFix,
  nextSpendCap,
  roomInviteCode,
  splitContributions,
  typingIds,
} from "./room-logic";

const T0 = Date.parse("2026-11-14T10:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();

const room: Room = {
  id: "r1",
  code: "ABC234",
  sessionId: "s1",
  worldId: "w1",
  hostUserId: "host",
  turnMode: "free",
  minSeats: 2,
  maxSeats: 12,
  mergeWindowMs: 8000,
  status: "open",
  createdAt: at(0),
};

const member = (userId: string, over: Partial<Member> = {}): Member => ({
  userId,
  name: userId,
  image: null,
  role: userId === "host" ? "host" : "player",
  mutedUntil: null,
  ready: false,
  online: true,
  roleId: null,
  roleName: null,
  ...over,
});

const action = (id: string, userId: string, ms: number, turnId: string | null = null): Action => ({
  id,
  userId,
  name: userId,
  text: `${userId} acts`,
  createdAt: at(ms),
  turnId,
});

test("the server's round info is read defensively", () => {
  assert.deepEqual(normaliseRound({ status: "counting", dueAt: T0 + 60_000, windowMs: 60_000 }), {
    status: "counting",
    dueAt: T0 + 60_000,
    windowMs: 60_000,
    failedCode: null,
    need: null,
  });
  assert.equal(normaliseRound({ status: "held", dueAt: T0 }).dueAt, null, "only a counting round has a deadline");
  assert.equal(normaliseRound({ status: "failed", failedCode: "NO_CREDITS" }).failedCode, "NO_CREDITS");
  assert.deepEqual(normaliseRound({ status: "waiting", need: { have: 1, need: 2 } }).need, { have: 1, need: 2 });
  assert.equal(normaliseRound({ status: "bogus" }).status, "idle");
  assert.equal(normaliseRound(null, 8000).windowMs, 8000);
});

test("typing shows for a few seconds and never for me", () => {
  assert.deepEqual(typingIds({ a: T0, b: T0 + 3000, me: T0 + 3000 }, T0 + 4000, "me"), ["a", "b"]);
  assert.deepEqual(typingIds({ a: T0, b: T0 + 3000 }, T0 + 6000), ["b"]);
  assert.deepEqual(typingIds(undefined, T0), []);
});

test("countdown runs from 1 down to 0", () => {
  assert.equal(countdownFraction(T0 + 8000, 8000, T0), 1);
  assert.equal(countdownFraction(T0 + 8000, 8000, T0 + 4000), 0.5);
  assert.equal(countdownFraction(T0 + 8000, 8000, T0 + 9000), 0);
  assert.equal(countdownFraction(null, 8000, T0), 0);
});

test("join errors map to the fix the screen offers", () => {
  assert.deepEqual(joinErrorFix("birth-year-required"), { kind: "birth-year" });
  assert.deepEqual(joinErrorFix("adult-required"), { kind: "adult" });
  assert.deepEqual(joinErrorFix("limited-content-only"), { kind: "adult" });
  assert.deepEqual(joinErrorFix("closed"), { kind: "message", key: "closed" });
  assert.deepEqual(joinErrorFix("not-found"), { kind: "message", key: "closed" });
  assert.deepEqual(joinErrorFix("room-full"), { kind: "message", key: "full" });
  assert.deepEqual(joinErrorFix("kicked"), { kind: "message", key: "kicked" });
  assert.deepEqual(joinErrorFix("blocked"), { kind: "message", key: "blocked" });
  assert.deepEqual(joinErrorFix("500"), { kind: "message", key: "failed" });
});

const snapshot = (over: Partial<RoomSnapshot> = {}): RoomSnapshot => ({
  room,
  members: [member("host"), member("a")],
  me: { role: "player" },
  pending: [],
  session: { id: "s1", worldId: "w1", worldName: "World", worldCover: null },
  roles: [],
  rolesRequired: false,
  talk: [],
  round: { status: "idle", dueAt: null, windowMs: 8000 },
  recap: null,
  ...over,
});

test("room events fold into the view", () => {
  let view = applyRoomEvent(EMPTY_ROOM_VIEW, "member", member("x"));
  assert.equal(view.snapshot, null, "events before the snapshot are ignored");

  view = applyRoomEvent(view, "snapshot", snapshot({ pending: [action("2", "a", 2000), action("1", "a", 0)] }));
  assert.deepEqual(view.snapshot!.pending.map((a) => a.id), ["1", "2"], "pending is kept in time order");

  view = applyRoomEvent(view, "member", { member: member("b"), change: "joined" });
  assert.equal(view.snapshot!.members.length, 3);
  view = applyRoomEvent(view, "member", { member: member("b", { online: false }), change: "offline" });
  assert.equal(view.snapshot!.members.find((m) => m.userId === "b")!.online, false);
  view = applyRoomEvent(view, "member", { userId: "b", change: "left" });
  assert.equal(view.snapshot!.members.length, 2);
  view = applyRoomEvent(view, "member", { member: member("c"), change: "joined" });
  view = applyRoomEvent(view, "member", { userId: "c", change: "kicked" });
  assert.equal(view.snapshot!.members.length, 2);

  view = applyRoomEvent(view, "action", { action: action("3", "host", 3000) });
  view = applyRoomEvent(view, "action-removed", { id: "2" });
  assert.deepEqual(view.snapshot!.pending.map((a) => a.id), ["1", "3"]);

  view = applyRoomEvent(view, "ready", { userId: "a", ready: true });
  assert.equal(view.snapshot!.members.find((m) => m.userId === "a")!.ready, true);

  view = applyRoomEvent(view, "turn-start", { turnId: "t1" });
  assert.ok(view.snapshot!.pending.every((a) => a.turnId === "t1"));
  assert.ok(view.snapshot!.members.every((m) => !m.ready), "a new round resets ready");

  view = applyRoomEvent(view, "action", action("4", "a", 9000));
  view = applyRoomEvent(view, "turn-done", { messageId: "m1" });
  assert.deepEqual(view.snapshot!.pending.map((a) => a.id), ["4"], "only the sent round leaves");

  view = applyRoomEvent(view, "room", { room: { ...room, turnMode: "host" } });
  assert.equal(view.snapshot!.room.turnMode, "host");
  view = applyRoomEvent(view, "closed", {});
  assert.equal(view.closed, true);
  assert.equal(applyRoomEvent(view, "kicked", null).kicked, true);
});

test("turn-start with ids claims only those actions", () => {
  let view = applyRoomEvent(EMPTY_ROOM_VIEW, "snapshot", snapshot({ pending: [action("1", "a", 0), action("2", "a", 1000)] }));
  view = applyRoomEvent(view, "turn-start", { turnId: "t1", actionIds: ["1"] });
  assert.deepEqual(view.snapshot!.pending.map((a) => a.turnId), ["t1", null]);
});

test("a failed round puts its actions back in the pool", () => {
  let view = applyRoomEvent(EMPTY_ROOM_VIEW, "snapshot", snapshot({ pending: [action("1", "a", 0)] }));
  view = applyRoomEvent(view, "turn-start", { turnId: "t1", actionIds: ["1"], content: "[a]: a acts", contributions: [] });
  view = applyRoomEvent(view, "action", { action: action("2", "a", 5000) });
  view = applyRoomEvent(view, "turn-done", { messageId: null, turnId: "t1", error: true });
  assert.deepEqual(view.snapshot!.pending.map((a) => [a.id, a.turnId]), [["1", null], ["2", null]]);
});

test("the relayed chat stream builds the live reply", () => {
  let live = applyStreamEvent(IDLE_REPLY, { event: "reasoning", data: { content: "hmm" } });
  assert.deepEqual(live, { active: true, failed: false, content: "" });
  live = applyStreamEvent(live, { event: "text", data: { content: "Once " } });
  live = applyStreamEvent(live, { event: "text", data: { content: "upon" } });
  assert.equal(live.content, "Once upon");
  live = applyStreamEvent(live, { event: "done", data: { content: "Once upon a time." } });
  assert.deepEqual(live, { active: false, failed: false, content: "Once upon a time." });
  // The next round starts clean.
  live = applyStreamEvent(live, { event: "text", data: { content: "Next" } });
  assert.equal(live.content, "Next");
  assert.equal(applyStreamEvent(live, { event: "error", data: { error: "x" } }).failed, true);
  assert.equal(applyStreamEvent(live, "garbage"), live);
});

test("a merged turn splits back into who said what", () => {
  assert.deepEqual(splitContributions("[Ann]: I open the door\n[Bo]: I wait\nquietly"), [
    { name: "Ann", text: "I open the door" },
    { name: "Bo", text: "I wait\nquietly" },
  ]);
  assert.deepEqual(splitContributions("plain line"), [{ name: null, text: "plain line" }]);
  assert.deepEqual(
    splitContributions("ignored", [{ name: "Cy", text: "hi" }]),
    [{ name: "Cy", text: "hi" }],
  );
});

test("a room invite resolves to its room code", () => {
  assert.equal(roomInviteCode({ code: "abc234" }), "ABC234");
  assert.equal(roomInviteCode({ roomCode: "QWE345", joinUrl: "/app/room/QWE345" }), "QWE345");
  assert.equal(roomInviteCode({ joinUrl: "/app/room/XYZ789" }), "XYZ789");
  assert.equal(roomInviteCode({ joinUrl: "/app/room/XYZ789?name=a" }), "XYZ789");
  assert.equal(roomInviteCode({ joinUrl: "https://evil.example/app/room/XYZ789" }), null);
  assert.equal(roomInviteCode({}), null);
});

test("round, talk and typing events fold in", () => {
  let view = applyRoomEvent(EMPTY_ROOM_VIEW, "snapshot", snapshot());
  view = applyRoomEvent(view, "round", { round: { status: "counting", dueAt: T0 + 60_000, windowMs: 60_000 } });
  assert.equal(view.snapshot!.round.status, "counting");
  assert.equal(view.snapshot!.round.dueAt, T0 + 60_000);

  view = applyRoomEvent(view, "typing", { userId: "a" }, T0 + 100);
  assert.equal(view.snapshot!.typing!.a, T0 + 100);
  view = applyRoomEvent(view, "action", { action: { ...action("1", "a", 200), hold: true } });
  assert.equal(view.snapshot!.typing!.a, undefined, "their line landed: no longer writing");
  assert.equal(view.snapshot!.pending[0]!.hold, true);

  view = applyRoomEvent(view, "talk", { line: { id: "t1", userId: "a", name: "a", text: "left door?", createdAt: at(300) } });
  view = applyRoomEvent(view, "talk", { line: { id: "t1", userId: "a", name: "a", text: "left door?", createdAt: at(300) } });
  assert.deepEqual(view.snapshot!.talk.map((l) => l.id), ["t1"], "a repeated line is kept once");
  assert.deepEqual(view.snapshot!.pending.map((a) => a.id), ["1"], "talk never joins the round");

  view = applyRoomEvent(view, "turn-start", { turnId: "t1", actionIds: ["1"] });
  assert.equal(view.snapshot!.round.status, "writing");
});

test("role errors map to the role fix", () => {
  assert.deepEqual(joinErrorFix("role-required"), { kind: "role", key: "pickRole" });
  assert.deepEqual(joinErrorFix("role-taken"), { kind: "role", key: "roleTaken" });
  assert.deepEqual(joinErrorFix("unknown-role"), { kind: "role", key: "roleTaken" });
});

test("roles follow who holds them as members change", () => {
  const roles = [{ id: "knight", name: "Knight", userId: null }, { id: "mage", name: "Mage", userId: null }];
  let view = applyRoomEvent(EMPTY_ROOM_VIEW, "snapshot", snapshot({ roles, members: [member("host"), member("a", { roleId: "knight", roleName: "Knight" })] }));
  assert.deepEqual(view.snapshot!.roles.map((r) => r.userId), ["a", null], "the snapshot fills holders in");
  view = applyRoomEvent(view, "member", { member: { ...member("a"), roleId: "mage", roleName: "Mage" }, change: "role" });
  assert.deepEqual(view.snapshot!.roles.map((r) => r.userId), [null, "a"]);
  view = applyRoomEvent(view, "member", { userId: "a", change: "left" });
  assert.deepEqual(view.snapshot!.roles.map((r) => r.userId), [null, null], "leaving frees the role");

  const choices = roleChoices(
    [{ id: "knight", name: "Knight", userId: "a" }, { id: "mage", name: "Mage", userId: "me" }, { id: "bard", name: "Bard", userId: null }],
    [member("a", { name: "Ann" }), member("me")],
    "me",
  );
  assert.deepEqual(choices.map((c) => [c.id, c.free, c.mine, c.holder?.name ?? null]), [
    ["knight", false, false, "Ann"],
    ["mage", true, true, "me"],
    ["bard", true, false, null],
  ]);
});

test("the round: who acted, my withdrawable line, waiting, sending", () => {
  const members = [member("host"), member("a")];
  const pending = [action("1", "a", 0), action("2", "host", 10), action("3", "a", 20)];
  const round = roundState({ room, members, pending, meId: "a" });
  assert.deepEqual(round.actedIds, ["a", "host"]);
  assert.equal(round.mine?.id, "3");
  assert.equal(round.waiting, null);
  assert.equal(round.sending, false);
  const claimed = roundState({ room: { minSeats: 3 }, members, pending: [action("1", "a", 0, "t1")], meId: "a" });
  assert.equal(claimed.mine, null, "a claimed action can no longer be withdrawn");
  assert.equal(claimed.sending, true);
  assert.deepEqual(claimed.waiting, { have: 2, need: 3 });

  const clock = { status: "counting" as const, dueAt: T0 + 60_000, windowMs: 60_000 };
  const ui = storyRoomUI(
    snapshot({ members: [member("host"), member("a", { ready: true, roleName: "Knight" }), member("b"), member("c", { online: false })], pending, round: clock }),
    "a",
    false,
  );
  assert.equal(ui.people.a!.roleName, "Knight");
  assert.equal(ui.doneCount, 2, "host and a acted; b has not");
  assert.equal(ui.onlineCount, 3);
  assert.equal(ui.meReady, true);
  assert.equal(ui.round.dueAt, T0 + 60_000);
  assert.equal(ui.canSendNow, true, "anyone may send a free-mode round");
  assert.deepEqual(ui.heldIds, []);

  const hostMode = storyRoomUI(snapshot({ room: { ...room, turnMode: "host" }, pending, round: clock }), "a", false);
  assert.equal(hostMode.canSendNow, false, "host mode: only the host sends");
  assert.equal(storyRoomUI(snapshot({ room: { ...room, turnMode: "host" }, pending, round: clock }), "host", true).canSendNow, true);

  const held = storyRoomUI(snapshot({ pending: [{ ...action("9", "a", 0), hold: true }], typing: { b: T0, a: T0 } }), "a", false);
  assert.deepEqual(held.heldIds, ["a"]);
  assert.deepEqual(Object.keys(held.typingAt), ["b"], "my own typing is not shown to me");

  const writing = storyRoomUI(snapshot({ pending: [action("1", "a", 0, "t1")], round: clock }), "a", false);
  assert.equal(writing.round.status, "writing", "a claimed round is being written");
  assert.equal(writing.round.dueAt, null);
  assert.equal(writing.canSendNow, false);
});

test("only a card on in story mode offers a story room", () => {
  const story = { settings: { multiplayer: { enabled: true, mode: "story", minSeats: 2, maxSeats: 6 } } };
  assert.equal(storyRoomSetting({ schema: story })?.maxSeats, 6);
  assert.equal(storyRoomSetting({ schema: { settings: { multiplayer: { enabled: false, mode: "story" } } } }), null);
  assert.equal(storyRoomSetting({ schema: { settings: { multiplayer: { mode: "rules", rulesFile: "r.js" } } } }), null);
  assert.equal(storyRoomSetting({ schema: { settings: {} } }), null);
  assert.equal(storyRoomSetting(null), null);
  assert.equal(seatRange({ minSeats: 2, maxSeats: 6 }), "2–6");
  assert.equal(seatRange({ minSeats: 4, maxSeats: 4 }), "4");
});

test("a rules table invite is the card page with the table code", () => {
  assert.equal(tableInvitePath("w 1", "rules:ab23cd"), "/app/hub/w%201?table=AB23CD");
  assert.equal(tableInvitePath("w1", "story:AB23CD"), null);
  assert.equal(tableInvitePath("w1", "rules:x"), null);
  assert.equal(parseTableCode("ab23"), "AB23");
  assert.equal(parseTableCode("<script>"), null);
  assert.equal(parseTableCode(42), null);
});

test("a member's chat mirrors the host's turn", () => {
  const base: MirrorState = { messages: [], isStreaming: false, streamingContent: "", streamingReasoning: "", gameState: { hp: 1 } };
  const contributions = [{ userId: "a", name: "Ann", text: "I open the door.", roleName: "Knight" }];
  const start = mirrorRoomEvent(base, "turn-start", { turnId: "t1", content: "[Ann · Knight]: I open the door.", contributions }, "s1", new Date(T0));
  assert.equal(start!.patch.isStreaming, true);
  assert.deepEqual(start!.patch.messages!.map((m) => [m.id, m.role, m.contributions?.[0]?.roleName]), [["__room_t1", "user", "Knight"]]);
  const withTurn: MirrorState = { ...base, ...start!.patch } as MirrorState;

  const text = mirrorRoomEvent(withTurn, "stream", { event: "text", data: { content: "The door " } }, "s1");
  assert.equal(text!.patch.streamingContent, "The door ");
  assert.deepEqual(mirrorRoomEvent(withTurn, "stream", { event: "done", data: { state: { variables: { hp: 2 } } } }, "s1")!.patch, { gameState: { hp: 2 } });
  assert.equal(mirrorRoomEvent(withTurn, "stream", { event: "ping", data: {} }, "s1"), null);
  assert.equal(mirrorRoomEvent(withTurn, "turn-done", { messageId: "m1" }, "s1")!.refresh, true);
  const failed = mirrorRoomEvent(withTurn, "turn-done", { error: true }, "s1")!;
  assert.deepEqual(failed.patch.messages, [], "a failed turn takes its bubbles back");
  assert.equal(failed.patch.isStreaming, false);
});

test("the spending limit goes up one step at a time, then off", () => {
  assert.equal(nextSpendCap(1_000), 5_000);
  assert.equal(nextSpendCap(5_000), 20_000);
  assert.equal(nextSpendCap(3_000), 5_000);
  assert.equal(nextSpendCap(20_000), null);
  assert.equal(nextSpendCap(50_000), null);
  assert.equal(nextSpendCap(null), undefined);
});

test("at the spending limit: no retry; the host gets a one-step raise", () => {
  const pending = [action("1", "a", 0)];
  const capped = { status: "failed" as const, dueAt: null, windowMs: 60_000, failedCode: "spend-cap" };
  const host = storyRoomUI(snapshot({ room: { ...room, spendCap: 5_000 }, pending, round: capped }), "host", true);
  assert.equal(host.canSendNow, false);
  assert.deepEqual(host.raiseCap, { to: 20_000 });
  const member = storyRoomUI(snapshot({ room: { ...room, spendCap: 5_000 }, pending, round: capped }), "a", false);
  assert.equal(member.canSendNow, false);
  assert.equal(member.raiseCap, null);
  const otherFail = storyRoomUI(snapshot({ pending, round: { ...capped, failedCode: "NO_CREDITS" } }), "host", true);
  assert.equal(otherFail.raiseCap, null);
  assert.equal(otherFail.canSendNow, true, "other failures keep 再试");
});

test("an untimed round keeps window 0 instead of falling back to the room's", async () => {
  const { normaliseRound } = await import("./room-logic");
  assert.deepEqual(
    { ...normaliseRound({ status: "counting", dueAt: null, windowMs: 0 }, 60_000) },
    { status: "counting", dueAt: null, windowMs: 0, failedCode: null, need: null },
  );
  assert.equal(normaliseRound({ status: "counting", dueAt: 5 }, 60_000).windowMs, 60_000, "missing window falls back");
});
