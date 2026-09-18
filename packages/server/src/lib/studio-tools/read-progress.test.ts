import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ToolCall } from "../llm/types.js";
import {
  createReadProgressState,
  extractReadTouches,
  recordReadTouches,
  clearReadProgress,
  readSpiralStopMessage,
  type ReadProgressVerdict,
} from "./read-progress.js";

let seq = 0;
function read(ids: string[], offset_lines?: number, limit_lines?: number): ToolCall {
  return {
    id: `tc${seq++}`,
    type: "function",
    function: {
      name: "read_entities",
      arguments: JSON.stringify({ ids, ...(offset_lines !== undefined ? { offset_lines } : {}), ...(limit_lines !== undefined ? { limit_lines } : {}) }),
    },
  };
}
function grep(query: string, id?: string, scope?: string): ToolCall {
  return {
    id: `tc${seq++}`,
    type: "function",
    function: { name: "grep_world", arguments: JSON.stringify({ query, ...(id ? { id } : {}), ...(scope ? { scope } : {}) }) },
  };
}

/** Feed whole turns and collect the verdict for each, the way the agent loop does. */
function run(turns: ToolCall[][]): ReadProgressVerdict[] {
  const state = createReadProgressState();
  return turns.map((calls) => recordReadTouches(state, extractReadTouches(calls)));
}

describe("read-progress: paginating a large file is progress, not a spiral", () => {
  // Prod run c32db831 (2026-08-13). Three non-overlapping slices of one file —
  // the id-based guard terminated the run on the third. Nothing here repeats.
  it("never stops or nudges on strictly new slices", () => {
    const verdicts = run([
      [read(["chat-room.tsx"], 1, 200)],
      [read(["chat-room.tsx"], 200, 300)],
      [read(["chat-room.tsx"], 500, 277)],
    ]);
    assert.deepEqual(verdicts.map((v) => v.kind), ["progress", "progress", "progress"]);
  });

  // Prod run 730b87ec: the model followed the guard's OWN advice — grep to locate,
  // read the slice, grep again with a new query — and was killed on the third touch.
  it("never stops on the grep → read → grep workflow the system prompt prescribes", () => {
    const verdicts = run([
      [grep("[", "chat-room.tsx", "customUI")],
      [read(["chat-room.tsx"], 200, 300)],
      [grep("localMessages.map", "chat-room.tsx", "customUI")],
      [read(["chat-room.tsx"], 500, 200)],
    ]);
    assert.ok(verdicts.every((v) => v.kind === "progress"), JSON.stringify(verdicts));
  });

  // Prod runs 23f17e71 / 60d5ebe6: six distinct queries against one file, no read at all.
  it("treats distinct grep queries against one id as distinct questions", () => {
    const verdicts = run([
      [grep("composeText", "moments-feed.tsx", "customUI")],
      [grep("commentText", "moments-feed.tsx", "customUI")],
      [grep("Send", "moments-feed.tsx", "customUI")],
    ]);
    assert.deepEqual(verdicts.map((v) => v.kind), ["progress", "progress", "progress"]);
  });

  it("counts parallel calls in one turn as one turn, not as repeats", () => {
    const verdicts = run([
      [read(["chat-room.tsx"], 1, 100), read(["chat-room.tsx"], 100, 120), grep("parseMessages", "chat-room.tsx")],
      [read(["chat-room.tsx"], 220, 120)],
    ]);
    assert.deepEqual(verdicts.map((v) => v.kind), ["progress", "progress"]);
  });

  it("does not confuse a batched read with a re-read of its siblings", () => {
    const verdicts = run([
      [read(["a.tsx", "b.tsx"], 1, 200)],
      [read(["a.tsx"], 200, 200)],
      [read(["b.tsx"], 200, 200)],
    ]);
    assert.deepEqual(verdicts.map((v) => v.kind), ["progress", "progress", "progress"]);
  });
});

describe("read-progress: the genuine loop still ends the run", () => {
  it("nudges on the 2nd identical request and stops on the 3rd", () => {
    const verdicts = run([
      [read(["hud.tsx"], 1, 200)],
      [read(["hud.tsx"], 1, 200)],
      [read(["hud.tsx"], 1, 200)],
    ]);
    assert.deepEqual(verdicts.map((v) => v.kind), ["progress", "repeat", "stop"]);
    assert.equal((verdicts[2] as { id: string }).id, "hud.tsx");
  });

  it("catches the same whole-file read repeated with no slice args", () => {
    const verdicts = run([[read(["index.tsx"])], [read(["index.tsx"])], [read(["index.tsx"])]]);
    assert.deepEqual(verdicts.map((v) => v.kind), ["progress", "repeat", "stop"]);
  });

  it("catches a repeated grep query even when other reads make progress in between", () => {
    const verdicts = run([
      [grep("renderBubble", "app.tsx")],
      [read(["app.tsx"], 1, 100)],
      [grep("renderBubble", "app.tsx")],
      [grep("renderBubble", "app.tsx")],
    ]);
    assert.deepEqual(verdicts.map((v) => v.kind), ["progress", "progress", "repeat", "stop"]);
  });

  it("keys repeats to the entity, so one file's loop is not another file's problem", () => {
    const verdicts = run([
      [read(["a.tsx"], 1, 50)],
      [read(["a.tsx"], 1, 50), read(["b.tsx"], 1, 50)],
      [read(["b.tsx"], 60, 50)],
    ]);
    assert.deepEqual(verdicts.map((v) => v.kind), ["progress", "repeat", "progress"]);
    assert.equal((verdicts[1] as { id: string }).id, "a.tsx");
  });

  it("names the looping entity in the stop message and keeps the notice prefix", () => {
    // studio-conversations recognizes server notices on pre-`lane` rows by /^Stopped: /.
    const msg = readSpiralStopMessage("hud.tsx");
    assert.ok(msg.startsWith("Stopped: "), msg);
    assert.ok(msg.includes("hud.tsx"));
  });
});

describe("read-progress: state boundaries", () => {
  it("forgets everything after a write, since the file itself changed", () => {
    const state = createReadProgressState();
    const call = [read(["hud.tsx"], 1, 200)];
    assert.equal(recordReadTouches(state, extractReadTouches(call)).kind, "progress");
    assert.equal(recordReadTouches(state, extractReadTouches(call)).kind, "repeat");
    clearReadProgress(state);
    assert.equal(recordReadTouches(state, extractReadTouches(call)).kind, "progress");
    assert.equal(recordReadTouches(state, extractReadTouches(call)).kind, "repeat");
  });

  it("nudges once — and never stops — when one file is paged through many times", () => {
    const verdicts = run(Array.from({ length: 10 }, (_, i) => [read(["index.tsx"], i * 100 + 1, 100)]));
    assert.equal(verdicts.filter((v) => v.kind === "wandering").length, 1, "exactly one wander nudge");
    assert.equal(verdicts[7]?.kind, "wandering", "fires on the crossing turn");
    assert.ok(!verdicts.some((v) => v.kind === "stop"), "distinct slices must never terminate the run");
  });

  it("ignores write tools, control tools, and malformed arguments", () => {
    const edit: ToolCall = { id: "w1", type: "function", function: { name: "edit_custom_ui", arguments: JSON.stringify({ id: "hud.tsx" }) } };
    const broken: ToolCall = { id: "r1", type: "function", function: { name: "read_entities", arguments: "{ids: [" } };
    assert.deepEqual(extractReadTouches([edit, broken]), []);
    const verdicts = run([[edit, broken], [edit, broken]]);
    assert.deepEqual(verdicts.map((v) => v.kind), ["progress", "progress"]);
  });

  it("still tracks a read_entities that misspells ids as id, so it can't loop forever", () => {
    const bad: ToolCall = { id: "r1", type: "function", function: { name: "read_entities", arguments: JSON.stringify({ id: "hud.tsx" }) } };
    assert.deepEqual(extractReadTouches([bad]).map((t) => t.id), ["hud.tsx"]);
    assert.deepEqual(run([[bad], [bad], [bad]]).map((v) => v.kind), ["progress", "repeat", "stop"]);
  });

  it("ignores a grep with no id — it targets the whole world, not one entity", () => {
    const verdicts = run([[grep("reverse")], [grep("reverse")], [grep("reverse")]]);
    assert.deepEqual(verdicts.map((v) => v.kind), ["progress", "progress", "progress"]);
  });
});
