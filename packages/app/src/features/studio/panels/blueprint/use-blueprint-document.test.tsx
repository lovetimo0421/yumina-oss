import assert from "node:assert/strict";
import test, { after } from "node:test";
import { act, createElement, useState } from "react";
import { JSDOM } from "jsdom";
import { useBlueprintDocumentKey } from "./use-blueprint-document";

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://localhost" });
const globals = { window: dom.window, document: dom.window.document, location: dom.window.location, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import("react-dom/client");
after(() => {
  dom.window.close();
  for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
});

type DocumentIdentity = Parameters<typeof useBlueprintDocumentKey>[0];
async function withDocument(initial: DocumentIdentity, run: (context: {
  key: () => string;
  session: () => string;
  render: (identity: DocumentIdentity) => Promise<void>;
}) => Promise<void>) {
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  let identity = initial;
  let nextSession = 0;
  // The canvas keys its UI session by document identity. A keyed child makes
  // these tests catch unintended resets as well as accidental state sharing.
  function CanvasSession({ documentKey }: { documentKey: string }) {
    const [session] = useState(() => ++nextSession);
    return createElement("output", { "data-document": documentKey, "data-session": session });
  }
  function Harness() {
    const documentKey = useBlueprintDocumentKey(identity);
    return createElement(CanvasSession, { key: documentKey, documentKey });
  }
  const render = async (next: DocumentIdentity) => { identity = next; await act(async () => root.render(createElement(Harness))); };
  try {
    await render(initial);
    await run({
      key: () => container.querySelector("output")!.getAttribute("data-document")!,
      session: () => container.querySelector("output")!.getAttribute("data-session")!,
      render,
    });
  } finally { await act(async () => root.unmount()); }
}

test("the first save retains the draft canvas session and subsequent renders keep that identity", async () => {
  await withDocument({ worldId: "new-card", serverWorldId: null }, async ({ key, session, render }) => {
    const draftKey = key(), draftSession = session();
    assert.equal(draftKey, "draft:new-card");
    await render({ worldId: "new-card", serverWorldId: "saved-card" });
    assert.equal(key(), draftKey);
    assert.equal(session(), draftSession, "saving must preserve canvas position and active editors");
    await render({ worldId: "new-card", serverWorldId: "saved-card" });
    assert.equal(key(), draftKey);
    assert.equal(session(), draftSession);
  });
});

test("separate server imports of the same embedded world ID never reuse a canvas session", async () => {
  await withDocument({ worldId: "import-source", serverWorldId: "copy-a" }, async ({ key, session, render }) => {
    const first = session();
    assert.equal(key(), "world:copy-a");
    await render({ worldId: "import-source", serverWorldId: "copy-b" });
    assert.equal(key(), "world:copy-b");
    assert.notEqual(session(), first);
    const second = session();
    await render({ worldId: "import-source", serverWorldId: "copy-a" });
    assert.equal(key(), "world:copy-a");
    assert.notEqual(session(), second);
  });
});

test("switching to a different draft or saved card resets identity instead of treating it as a first save", async () => {
  await withDocument({ worldId: "draft-a", serverWorldId: null }, async ({ key, session, render }) => {
    let prior = session();
    await render({ worldId: "draft-b", serverWorldId: null });
    assert.equal(key(), "draft:draft-b"); assert.notEqual(session(), prior);
    prior = session();
    await render({ worldId: "already-existing", serverWorldId: "existing-server-card" });
    assert.equal(key(), "world:existing-server-card"); assert.notEqual(session(), prior);
    prior = session();
    await render({ worldId: "draft-b", serverWorldId: null });
    assert.equal(key(), "draft:draft-b"); assert.notEqual(session(), prior);
  });
});

test("legacy content and relationship preferences have no effect and document identity never accesses storage", async () => {
  const storage = dom.window.localStorage;
  storage.setItem("yumina-blueprint-view:draft:legacy", "content");
  storage.setItem("yumina-blueprint-view:world:legacy-server", "relationships");
  const globalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const windowStorage = Object.getOwnPropertyDescriptor(dom.window, "localStorage");
  let accesses = 0;
  const inaccessibleStorage = { configurable: true, get() { accesses++; throw new Error("Canvas document identity does not require storage"); } };
  Object.defineProperty(globalThis, "localStorage", inaccessibleStorage);
  Object.defineProperty(dom.window, "localStorage", inaccessibleStorage);
  try {
    await withDocument({ worldId: "legacy", serverWorldId: null }, async ({ key, session, render }) => {
      assert.equal(key(), "draft:legacy");
      const before = session();
      await render({ worldId: "legacy", serverWorldId: "legacy-server" });
      assert.equal(key(), "draft:legacy");
      assert.equal(session(), before);
      await render({ worldId: "other-card", serverWorldId: "other-server" });
      assert.equal(key(), "world:other-server");
    });
    assert.equal(accesses, 0, "no reads or writes are attempted, even if storage access would fail");
    assert.equal(storage.getItem("yumina-blueprint-view:draft:legacy"), "content");
    assert.equal(storage.getItem("yumina-blueprint-view:world:legacy-server"), "relationships");
  } finally {
    if (globalStorage) Object.defineProperty(globalThis, "localStorage", globalStorage); else Reflect.deleteProperty(globalThis, "localStorage");
    if (windowStorage) Object.defineProperty(dom.window, "localStorage", windowStorage); else Reflect.deleteProperty(dom.window, "localStorage");
    storage.clear();
  }
});
