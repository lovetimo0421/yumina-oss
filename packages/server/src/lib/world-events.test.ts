import assert from "node:assert/strict";
import { test } from "node:test";
import { publishWorldEvent, subscribeWorldEvents, type WorldEvent } from "./world-events.js";

test("a stream that unsubscribes twice never cuts off the streams opened after it", () => {
  const worldId = crypto.randomUUID();
  const heard: string[] = [];
  const event = (userId: string): WorldEvent => ({ kind: "access-changed", userId, at: new Date().toISOString() });
  const closeOld = subscribeWorldEvents(worldId, () => heard.push("old"));
  closeOld(); // the tab closed: aborted
  const closeNew = subscribeWorldEvents(worldId, () => heard.push("new"));
  closeOld(); // …and its loop ends up to 25s later
  publishWorldEvent(worldId, event("x"));
  assert.deepEqual(heard, ["new"]);
  closeNew();
});
