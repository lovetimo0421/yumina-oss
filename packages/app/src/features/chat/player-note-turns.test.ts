// 给 AI 的话: every way a turn leaves the sandbox carries the note the player
// has open in the composer, once (sandbox/chat/player-note-draft.ts).
import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { buildAPI, resolveApiCall } from "../../../sandbox/sandbox-context";
import type { SandboxState } from "../../../sandbox/protocol";
import {
  __resetNoteDraft,
  editReplyAction,
  getNoteDraft,
  restoreTurnNote,
  setNoteDraft,
  settleTurnNote,
  takeTurnNote,
} from "../../../sandbox/chat/player-note-draft";

type Sent = { callId: string; method: string; args: unknown[] };
const sent: Sent[] = [];
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { location: { search: "" }, parent: { postMessage: (message: { payload: Sent }) => { sent.push(structuredClone(message).payload); } } },
});

const messages = [
  { id: "g0", role: "assistant", content: "Hello." },
  { id: "u1", role: "user", content: "Hi." },
  { id: "a1", role: "assistant", content: "She smiles." },
];
const api = (over: Partial<SandboxState> = {}) => buildAPI({
  mode: "session", sessionId: "s1", selectedModel: "m", variables: {}, globalVariables: {},
  messages, isStreaming: false, readOnly: false, ...over,
} as unknown as SandboxState);
const last = () => sent.at(-1)!;

beforeEach(() => { sent.length = 0; __resetNoteDraft(); });

test("a choice chip, a reply's choice button, voice and card code all send through api.sendMessage, which takes the open note", () => {
  // Every one of those paths calls api.sendMessage(text) with no note of its own.
  for (const line of ["Open the door", "[choice from a reply]", "spoken words", "card ui action"]) {
    setNoteDraft("  let her speak first ");
    api().sendMessage(line);
    assert.equal(last().method, "sendMessage");
    assert.deepEqual(last().args, [line, undefined, { note: "let her speak first" }]);
    assert.equal(getNoteDraft(), null, "the field closes once the note is sent");
  }
});

test("no open note: the payload is unchanged", () => {
  api().sendMessage("Hi");
  assert.deepEqual(last().args, ["Hi", undefined, undefined]);
  setNoteDraft("   ");
  api().sendMessage("Hi");
  assert.deepEqual(last().args, ["Hi", undefined, undefined]);
  assert.equal(getNoteDraft(), "   ", "a field the player only just opened is left alone (the composer's own send closes it)");
});

test("a card's own note and the player's open note both go", () => {
  setNoteDraft("slow down");
  api().sendMessage("Go", undefined, { note: "card: stay in the tavern" });
  assert.deepEqual(last().args[2], { note: "slow down\n\ncard: stay in the tavern" });
  api().sendMessage("Go", undefined, { note: "card only" });
  assert.deepEqual(last().args[2], { note: "card only" });
});

test("a send the host will not start leaves the note open for the one that does", () => {
  for (const over of [{ isStreaming: true }, { readOnly: true }, { storyRoom: { isHost: true } }, { modelFallback: { id: "f" } }, { sessionId: undefined }] as Partial<SandboxState>[]) {
    setNoteDraft("slow down");
    api(over).sendMessage("Hi");
    assert.equal((last().args[2] as { note?: string } | undefined)?.note, undefined);
    assert.equal(getNoteDraft(), "slow down");
  }
  // An empty send (the sign-in prompt) is not a turn either.
  api().sendMessage("");
  assert.equal(getNoteDraft(), "slow down");
});

test("continue and the note-only send carry the open note", () => {
  setNoteDraft("skip to morning");
  api().continueLastMessage();
  assert.equal(last().method, "continueLastMessage");
  assert.deepEqual(last().args, [{ note: "skip to morning" }]);
  api().continueLastMessage();
  assert.deepEqual(last().args, [], "one turn only");
});

test("regenerate / a new swipe: the open note replaces the turn's; none open sends none (the server re-reads the stored one)", () => {
  api().regenerateMessage("a1");
  assert.deepEqual(last().args, ["a1"]);
  setNoteDraft("make it shorter");
  api().regenerateMessage("a1");
  assert.deepEqual(last().args, ["a1", { note: "make it shorter" }]);
  assert.equal(getNoteDraft(), null);
});

test("saving an edit to the player's line takes the note; editing a reply does not", async () => {
  setNoteDraft("she is angry");
  const saved = api().editMessage("u1", "Hi there.", { swipeIndex: null });
  assert.equal(last().method, "editMessage");
  assert.deepEqual(last().args, ["u1", "Hi there.", { note: "she is angry" }]);
  resolveApiCall(last().callId, true);
  assert.equal(await saved, true);
  assert.equal(getNoteDraft(), null);

  setNoteDraft("she is angry");
  const reply = api().editMessage("a1", "She frowns.", { swipeIndex: 0 });
  assert.deepEqual(last().args, ["a1", "She frowns.", { swipeIndex: 0 }]);
  resolveApiCall(last().callId, true);
  await reply;
  assert.equal(getNoteDraft(), "she is angry");
});

test("an edit that fails to save puts the note back", async () => {
  setNoteDraft("she is angry");
  const saved = api().editMessage("u1", "Hi there.");
  resolveApiCall(last().callId, false);
  assert.equal(await saved, false);
  assert.equal(getNoteDraft(), "she is angry");
});

test("a failed turn reopens the field with its note, never over a note typed since; a clean one forgets it", () => {
  setNoteDraft("slow down");
  takeTurnNote();
  restoreTurnNote();
  assert.equal(getNoteDraft(), "slow down");

  takeTurnNote();
  setNoteDraft("a newer note");
  restoreTurnNote();
  assert.equal(getNoteDraft(), "a newer note");

  takeTurnNote();
  settleTurnNote();
  restoreTurnNote();
  assert.equal(getNoteDraft(), null);
});

test("which edits are answered again (the host and the sandbox read the same rule)", () => {
  assert.deepEqual(editReplyAction(messages, "u1"), { kind: "regenerate", replyId: "a1" });
  assert.equal(editReplyAction(messages, "a1"), null);
  assert.equal(editReplyAction(messages, "g0"), null);
  assert.deepEqual(editReplyAction([...messages, { id: "u2", role: "user" }], "u2"), { kind: "continue" });
  assert.equal(editReplyAction([], "u1"), null);
});

test("the composer and the host leave the note to the shared path", () => {
  const composer = readFileSync(new URL("../../../sandbox/chat/message-input.tsx", import.meta.url), "utf8");
  // No caller attaches the note itself any more: the send button, chips and
  // voice all call the plain API, and the field is the shared draft.
  assert.doesNotMatch(composer, /\{ note: noteText \}/);
  assert.match(composer, /const \[note, setNote\] = useNoteDraft\(\);/);
  assert.match(composer, /restoreTurnNote\(\);/);
  const host = readFileSync(new URL("./world-renderer.tsx", import.meta.url), "utf8");
  assert.match(host, /regenerateMessage\(args\[0\] as string, undefined, undefined, regenNote\)/);
  assert.match(host, /store\.regenerateMessage\(reply\.replyId, undefined, undefined, editNote\)/);
  assert.match(host, /store\.continueLastMessage\(undefined, undefined, editNote\)/);
});
