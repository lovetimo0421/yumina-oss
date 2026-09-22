import assert from "node:assert/strict";
import test, { after } from "node:test";
import React, { act, createElement, StrictMode, useState, type ComponentProps } from "react";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<div id="root"></div>', { url: "https://example.test", pretendToBeVisual: true });
const globals = {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, React, IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import("react-dom/client");
const { ModelPickerModal } = await import("../../../sandbox/chat/model-picker-modal");
const { ModelControlsContext } = await import("../../../sandbox/chat/model-controls-context");
const { YuminaContext } = await import("../../../sandbox/sandbox-context");
type Api = React.ContextType<typeof YuminaContext>;
type Props = ComponentProps<typeof ModelPickerModal>;
const container = document.getElementById("root")!;
const inlineDialog = () => document.querySelector("[data-yumina-platform-overlay-host]")?.shadowRoot?.querySelector('[role="dialog"]');

after(() => {
  dom.window.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function makeApi(openModelPicker: () => void): Api {
  return {
    mode: "session", language: "en", preferredProvider: "official", userPlan: "plus",
    selectedModel: "google/gemini-3-flash-preview", balance: 100, modelPool: [], mixMode: false,
    messages: [], openModelPicker,
    getModels: async () => ({
      models: [{ id: "google/gemini-3-flash-preview", name: "Gemini 3 Flash", provider: "Google", contextLength: 1_048_576, supportsImages: true }],
      pinnedModels: [], recentlyUsed: [],
    }),
    setModel: () => assert.fail("Opening or choosing a secondary model must not change the story model"),
  } as unknown as Api;
}

test("legacy cards delegate the chat picker and can reopen after onClose unmounts it", async () => {
  let opens = 0;
  const api = makeApi(() => opens++);
  function Card() {
    const [open, setOpen] = useState(false);
    return createElement(React.Fragment, null,
      createElement("button", { onClick: () => setOpen(true) }, "Model"),
      open ? createElement(ModelPickerModal, { open, onClose: () => setOpen(false) }) : null,
    );
  }
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(StrictMode, null,
      createElement(YuminaContext.Provider, { value: api }, createElement(Card)))));
    assert.equal(opens, 0);
    await act(async () => container.querySelector("button")!.click());
    assert.equal(opens, 1);
    assert.equal(inlineDialog() ?? null, null);
    await act(async () => container.querySelector("button")!.click());
    assert.equal(opens, 2);
  } finally { await act(async () => root.unmount()); }
});

test("controlled cards open once per open cycle even when bridge and close callbacks change", async () => {
  let opens = 0;
  let closes = 0;
  const root = createRoot(container);
  const render = (open: boolean) => act(async () => root.render(createElement(StrictMode, null,
    createElement(YuminaContext.Provider, { value: makeApi(() => opens++) },
      createElement(ModelPickerModal, { open, onClose: () => closes++ })))));
  try {
    await render(false);
    assert.equal(opens, 0);
    await render(true);
    await render(true);
    assert.equal(opens, 1);
    assert.equal(closes, 1);
    await render(false);
    await render(true);
    assert.equal(opens, 2);
  } finally { await act(async () => root.unmount()); }
});

test("secondary model callbacks stay local and never open the story model picker", async () => {
  let selected = "";
  let closed = 0;
  const api = makeApi(() => assert.fail("Secondary selection must not open the host chat picker"));
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(YuminaContext.Provider, { value: api },
      createElement(ModelPickerModal, {
        open: true, onClose: () => closed++, selectedModel: api.selectedModel,
        onSelectModel: (id) => { selected = id; }, title: "Memory model",
      }))));
    const dialog = inlineDialog();
    assert.ok(dialog);
    const button = [...dialog.querySelectorAll("button")].find(item => item.textContent?.includes("Gemini 3 Flash"));
    assert.ok(button);
    await act(async () => button.click());
    assert.equal(selected, "google/gemini-3-flash-preview");
    assert.equal(closed, 1);
  } finally { await act(async () => root.unmount()); }
});

test("constrained selectors, guest previews and native game overrides retain an inline picker", async () => {
  const api = makeApi(() => assert.fail("This context must keep its own selector"));
  const cases: Array<{ api: Api; props?: Partial<Props>; native?: boolean }> = [
    { api, props: { providerOverride: "official" } },
    { api, props: { selectionProvider: "official" } },
    { api, props: { onSelectionProviderChange: () => {} } },
    { api, props: { title: "Custom model choice" } },
    { api: { ...api, mode: "guest-preview" } },
    { api, native: true },
  ];
  for (const item of cases) {
    const root = createRoot(container);
    try {
      let child: React.ReactElement = createElement(ModelPickerModal, { open: true, onClose: () => {}, ...item.props });
      if (item.native) {
        // A native adapter intentionally supplies neither the sandbox mode nor
        // its bridge; it must not inherit those from an enclosing world.
        const { mode: _mode, openModelPicker: _open, ...native } = api;
        child = createElement(ModelControlsContext.Provider, { value: native }, child);
      }
      await act(async () => root.render(createElement(YuminaContext.Provider, { value: item.api }, child)));
      assert.ok(inlineDialog());
    } finally { await act(async () => root.unmount()); }
  }
});
