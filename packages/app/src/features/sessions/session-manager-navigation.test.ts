import assert from "node:assert/strict";
import test from "node:test";
import { navigateFromSessionManager } from "./session-manager-navigation.js";

test("keeps the session manager open until chat navigation finishes", async () => {
  let finishNavigation!: () => void;
  const events: string[] = [];
  const navigation = new Promise<void>((resolve) => {
    finishNavigation = resolve;
  });

  const result = navigateFromSessionManager({
    sessionId: "session-1",
    navigate: async (sessionId) => {
      events.push(`navigate:${sessionId}`);
      await navigation;
      events.push("navigation-finished");
    },
    close: () => events.push("close"),
  });

  await Promise.resolve();
  assert.deepEqual(events, ["navigate:session-1"]);

  finishNavigation();
  await result;
  assert.deepEqual(events, ["navigate:session-1", "navigation-finished", "close"]);
});

test("leaves the manager open when navigation fails", async () => {
  let closed = false;

  await assert.rejects(
    navigateFromSessionManager({
      sessionId: "session-2",
      navigate: async () => {
        throw new Error("route failed");
      },
      close: () => {
        closed = true;
      },
    }),
    /route failed/,
  );

  assert.equal(closed, false);
});
