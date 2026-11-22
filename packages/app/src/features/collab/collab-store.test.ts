import assert from "node:assert/strict";
import test from "node:test";
import { peerColor, useCollabStore } from "./collab-store";
import { canvasIdForTarget } from "./live-cursors";

const peer = (clientId: string, userId = "u1") => ({ userId, clientId, name: "Mina", image: null, focus: null, gone: false });

test("a person keeps one colour", () => {
  assert.equal(peerColor("user-a"), peerColor("user-a"));
  assert.match(peerColor("user-b"), /^#[0-9a-f]{6}$/);
});

test("cursors follow presence: ours are ignored, a pointer leaving keeps its spot, a closed tab takes its cursor along", () => {
  const s = useCollabStore.getState();
  s.reset("w");
  s.applyPresence(peer("c1"), "me");
  s.applyCursor({ userId: "u1", clientId: "me", name: "Me", x: 1, y: 1 }, "me");
  assert.equal(useCollabStore.getState().cursors.me, undefined);
  s.applyCursor({ userId: "u1", clientId: "c1", name: "Mina", x: 10, y: 20, sel: "entry:e1" }, "me");
  s.applyCursor({ userId: "u1", clientId: "c1", name: "Mina", out: true }, "me");
  const c = useCollabStore.getState().cursors.c1!;
  assert.deepEqual([c.x, c.y, c.out, c.sel], [10, 20, true, "entry:e1"]);
  s.setFollowing("u1");
  s.applyPresence({ ...peer("c1"), gone: true }, "me");
  assert.equal(useCollabStore.getState().cursors.c1, undefined);
  s.reset(null);
  assert.equal(useCollabStore.getState().following, null);
});

test("an edit target maps to its place on the board", () => {
  assert.equal(canvasIdForTarget("entries:e1"), "entry:e1");
  assert.equal(canvasIdForTarget("variables:hp"), "var:hp");
  assert.equal(canvasIdForTarget("worldbooks:w1"), "worldbooks:w1");
});
