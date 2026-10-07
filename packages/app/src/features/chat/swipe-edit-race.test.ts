import assert from "node:assert/strict";
import test from "node:test";
import React, { act, createElement } from "react";
import { JSDOM } from "jsdom";
import { canStartEdit, editTargetFor, reconcileEditTarget } from "../../../sandbox/chat/edit-target";

// Launch QA 2026-09-25: regenerate (2/2) → previous swipe → edit within ~1s.
// The counter read 1/2 but the edit box held swipe 2's text, and saving wrote
// it over swipe 1. The swipe is server-mediated, so the bubble still showed
// swipe 2 when the edit opened, and the switch then landed under the editor.

const twoSwipes = (active: 0 | 1) => ({
  id: "a1",
  content: active === 0 ? "First version" : "Second version",
  activeSwipeIndex: active,
  swipes: [{ content: "First version" }, { content: "Second version" }],
});

test("an edit never opens while a swipe switch for that message is in flight", () => {
  assert.equal(canStartEdit("a1", new Set(["a1"])), false);
  assert.equal(canStartEdit("a1", new Set(["other"])), true);
});

test("an edit remembers the variant it was opened on", () => {
  assert.deepEqual(editTargetFor(twoSwipes(1)), { messageId: "a1", swipeIndex: 1, baseContent: "Second version" });
  assert.deepEqual(editTargetFor({ id: "u1", content: "Hi" }), { messageId: "u1", swipeIndex: null, baseContent: "Hi" });
});

test("a variant landing under an open edit re-seeds an untouched draft and closes a typed one", () => {
  const target = editTargetFor(twoSwipes(1));
  assert.deepEqual(reconcileEditTarget(target, twoSwipes(1), "Second version, typing"), { action: "keep" });
  // Nothing typed: follow the version now on screen.
  assert.deepEqual(reconcileEditTarget(target, twoSwipes(0), "Second version"), {
    action: "reseed", target: editTargetFor(twoSwipes(0)), draft: "First version",
  });
  // Typed: never retarget the player's text onto another version.
  assert.deepEqual(reconcileEditTarget(target, twoSwipes(0), "Second version, edited"), { action: "cancel" });
  // Their own save echoing back is adopted quietly.
  const saved = { ...twoSwipes(1), content: "Second version, edited" };
  assert.equal(reconcileEditTarget(target, saved, "Second version, edited").action, "reseed");
  assert.deepEqual(reconcileEditTarget(target, undefined, "x"), { action: "cancel" });
});

test("message list: edit waits for the swipe switch to land, then edits exactly the version on screen", async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const keys = ["window", "document", "navigator", "Element", "HTMLElement", "Node", "MutationObserver", "CustomEvent",
    "requestAnimationFrame", "cancelAnimationFrame", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const saved = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys) {
    const value = key === "React" ? React : key === "IS_REACT_ACT_ENVIRONMENT" ? true
      : (dom.window as unknown as Record<string, unknown>)[key];
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const savedCss = Object.getOwnPropertyDescriptor(globalThis, "CSS");
  Object.defineProperty(globalThis, "CSS", { configurable: true, writable: true, value: { escape: (s: string) => s } });
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  try {
    const [{ MessageList }, { YuminaContext, buildAPI }] = await Promise.all([
      import("../../../sandbox/chat/message-list"), import("../../../sandbox/sandbox-context"),
    ]);
    const user = { id: "u1", sessionId: "s1", role: "user" as const, content: "Hello", createdAt: "2026-09-25T00:00:00Z" };
    const reply = (active: 0 | 1) => ({
      ...twoSwipes(active), sessionId: "s1", role: "assistant" as const, model: "test/model",
      createdAt: "2026-09-25T00:00:01Z",
    });
    const base = buildAPI({
      variables: {}, globalVariables: {}, worldName: "Race", worldCover: null, worldId: "w", sessionId: "s1",
      currentUser: null, user: { name: "Player", avatar: null }, messages: [], isStreaming: false,
      streamingContent: "", mode: "session", language: "en",
    } as unknown as Parameters<typeof buildAPI>[0]);
    let finishSwipe: ((value: Record<string, unknown>) => void) | undefined;
    const edits: unknown[][] = [];
    const toasts: string[] = [];
    const api = {
      ...base,
      swipeMessage: () => new Promise<Record<string, unknown>>((resolve) => { finishSwipe = resolve; }),
      editMessage: async (...args: unknown[]) => { edits.push(args); return true; },
      showToast: (message: string) => { toasts.push(message); },
    };
    const render = async (messages: unknown[]) => {
      await act(async () => root.render(createElement(YuminaContext.Provider,
        { value: { ...api, messages } as unknown as typeof base }, createElement(MessageList, { rendererComponent: null }))));
    };
    const button = (title: string) => {
      const found = [...container.querySelectorAll<HTMLButtonElement>(`button[title="${title}"]`)].pop();
      assert.ok(found, `button ${title}`);
      return found!;
    };

    await render([user, reply(1)]);
    assert.match(container.textContent!, /2\/2/);
    await act(async () => button("Previous response").click());
    // The switch is in flight: the bubble still shows version 2, so editing
    // now would seed the box with the version that is about to leave.
    assert.equal(button("Edit").disabled, true);
    await act(async () => button("Edit").click());
    assert.equal(container.querySelector("textarea"), null);

    // The host answered before the updated message reached the frame.
    await act(async () => finishSwipe!({ activeSwipeIndex: 0 }));
    assert.equal(button("Edit").disabled, true, "answered is not on screen yet");

    await render([user, reply(0)]);
    assert.match(container.textContent!, /1\/2/);
    assert.equal(button("Edit").disabled, false);
    await act(async () => button("Edit").click());
    const box = container.querySelector("textarea")!;
    assert.equal(box.value, "First version");
    // Switching versions is locked while this message is being edited.
    assert.equal(button("Next response").disabled, true);

    const save = [...container.querySelectorAll("button")].find((b) => /Save/.test(b.textContent ?? ""))!;
    await act(async () => save.click());
    assert.deepEqual(edits, [["a1", "First version", { swipeIndex: 0 }]]);
    assert.deepEqual(toasts, []);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    if (savedCss) Object.defineProperty(globalThis, "CSS", savedCss);
    else Reflect.deleteProperty(globalThis, "CSS");
  }
});
