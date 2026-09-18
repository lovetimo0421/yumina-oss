import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { act, createElement } from "react";
import { JSDOM } from "jsdom";
import { transform } from "sucrase";

test("the play composer honors keyboard settings on touch-capable desktops", async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://synthetic.test" });
  const win = dom.window;
  const globals = { window: win, document: win.document, navigator: win.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  // React must see the DOM before it initializes its input/composition events.
  const { createRoot } = await import("react-dom/client");
  const noop = () => {};
  const empty = () => null;
  const sent: string[] = [];
  const api = {
    isStreaming: false, pendingChoices: [], readOnly: false, language: "en",
    composerSendKey: "enter", sendMessage: (content: string) => sent.push(content),
    stopGeneration: noop, continueLastMessage: noop, restartChat: noop,
    clearPendingChoices: noop, showToast: noop, openPersonaManager: noop,
    openSessionManager: noop, messages: [], getBranchContext: noop,
    branchFromMessage: noop, navigate: noop,
  };
  const require = createRequire(import.meta.url);
  const mocks: Record<string, unknown> = {
    "../sandbox-context": { useYumina: () => api, COMPOSER_DRAFT_EVENT: "synthetic-composer-draft" },
    "./model-picker-modal": { ModelPickerModal: empty, ModelTrigger: empty },
    "./i18n": { makeChatT: () => (key: string) => key },
    "../extensions/registry": { SlotOutlet: empty, useToolMenuCount: () => 0 },
    "./composer-tool-menu": { ComposerToolMenu: empty, useIsNarrow: () => false },
    "../protocol": { postToParentWindow: noop, wrapMessage: (value: unknown) => value },
    "../../src/lib/composer-message-limit": {
      clampComposerMessage: (value: string) => value,
      getComposerMessageLimitState: () => "hidden", MAX_USER_MESSAGE_CHARS: 50_000,
    },
  };
  // Execute the complete production component, including the actual keydown,
  // composition, controlled textarea, and send handlers. No copied handler.
  const source = readFileSync(new URL("../../sandbox/chat/message-input.tsx", import.meta.url), "utf8");
  const module = { exports: {} as { MessageInput: () => React.ReactNode } };
  new Function("require", "module", "exports", transform(source, {
    transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic",
  }).code)((id: string) => mocks[id] ?? require(id), module, module.exports);

  type Device = { coarse?: boolean; touchPoints?: number; touchEvent?: boolean; noMatchMedia?: boolean };
  async function withComposer(device: Device, check: (input: HTMLTextAreaElement) => Promise<void>, mode = "enter", streaming = false) {
    sent.length = 0;
    api.composerSendKey = mode;
    api.isStreaming = streaming;
    Reflect.deleteProperty(win, "ontouchstart");
    if (device.touchEvent) Object.defineProperty(win, "ontouchstart", { configurable: true, value: null });
    assert.equal("ontouchstart" in win, !!device.touchEvent);
    Object.defineProperty(win.navigator, "maxTouchPoints", { configurable: true, value: device.touchPoints ?? 0 });
    Object.defineProperty(win, "matchMedia", {
      configurable: true,
      value: device.noMatchMedia ? undefined : (query: string) => {
        assert.equal(query, "(pointer: coarse)");
        return { matches: !!device.coarse };
      },
    });
    const root = createRoot(win.document.getElementById("root")!);
    try {
      await act(async () => root.render(createElement(module.exports.MessageInput)));
      const input = win.document.querySelector("textarea");
      assert.ok(input, "Render the production play composer");
      await act(async () => {
        Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Hello 世界");
        input.dispatchEvent(new win.Event("input", { bubbles: true }));
      });
      assert.equal(input.value, "Hello 世界");
      await check(input);
    } finally {
      await act(async () => root.unmount());
    }
  }
  async function press(input: HTMLTextAreaElement, options: KeyboardEventInit = {}) {
    const event = new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...options });
    await act(async () => { input.dispatchEvent(event); });
    return event;
  }
  const assertSent = (input: HTMLTextAreaElement) => {
    assert.deepEqual(sent, ["Hello 世界"]);
    assert.equal(input.value, "", "Successful sends clear the draft");
  };
  const assertDraft = (input: HTMLTextAreaElement) => {
    assert.deepEqual(sent, []);
    assert.equal(input.value, "Hello 世界", "Non-send keys preserve the draft");
  };

  try {
    for (const [name, device] of [
      ["ordinary desktop", {}],
      ["fine pointer with touchscreen hardware", { touchPoints: 10 }],
      ["fine pointer with a browser exposing touch events", { touchEvent: true }],
      ["browser without matchMedia", { noMatchMedia: true }],
    ] as const) {
      await t.test(`Enter sends on ${name}`, async () => withComposer(device, async input => {
        assert.equal((await press(input)).defaultPrevented, true);
        assertSent(input);
      }));
    }
    const desktop = { touchPoints: 10, touchEvent: true };
    await t.test("Shift+Enter preserves the draft in Enter mode", async () => withComposer(desktop, async input => {
      assert.equal((await press(input, { shiftKey: true })).defaultPrevented, false);
      assertDraft(input);
    }));
    for (const modifier of ["ctrlKey", "metaKey"] as const) {
      await t.test(`${modifier}+Enter sends only after the modifier in mod-enter mode`, async () => withComposer(desktop, async input => {
        for (const options of [{}, { shiftKey: true }]) {
          assert.equal((await press(input, options)).defaultPrevented, false);
          assertDraft(input);
        }
        assert.equal((await press(input, { [modifier]: true })).defaultPrevented, true);
        assertSent(input);
      }, "mod-enter"));
    }
    for (const mode of ["enter", "mod-enter"]) {
      await t.test(`touch-primary devices use the send button in ${mode} mode`, async () => withComposer({ coarse: true, touchPoints: 5, touchEvent: true }, async input => {
        for (const options of [{}, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
          assert.equal((await press(input, options)).defaultPrevented, false);
          assertDraft(input);
        }
        const button = win.document.querySelector<HTMLButtonElement>(".play-composer-send");
        assert.ok(button && !button.disabled);
        await act(async () => button.click());
        assertSent(input);
      }, mode));
    }
    await t.test("composition events block Enter until the candidate is committed", async () => withComposer(desktop, async input => {
      await act(async () => { input.dispatchEvent(new win.CompositionEvent("compositionstart", { bubbles: true })); });
      assert.equal((await press(input)).defaultPrevented, false);
      assertDraft(input);
      await act(async () => { input.dispatchEvent(new win.CompositionEvent("compositionend", { bubbles: true })); });
      await press(input);
      assertSent(input);
    }));
    for (const options of [{ isComposing: true }, { keyCode: 229 }]) {
      await t.test(`IME keydown ${JSON.stringify(options)} preserves the candidate`, async () => withComposer(desktop, async input => {
        assert.equal((await press(input, options)).defaultPrevented, false);
        assertDraft(input);
        await press(input);
        assertSent(input);
      }));
    }
    await t.test("Enter never starts another send while a reply is streaming", async () => withComposer(desktop, async input => {
      await press(input);
      assertDraft(input);
    }, "enter", true));
  } finally {
    win.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
