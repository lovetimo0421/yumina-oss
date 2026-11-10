import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SandboxMessage } from "../../../sandbox/chat/types";

const PORTRAIT = "https://cdn.example/lilith-full.png";

test("clicking a character's face in the chat opens the whole portrait; Escape closes it", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost", pretendToBeVisual: true });
  // tsx compiles files outside tsconfig.app.json's `include` (the sandbox) with the classic JSX runtime.
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, KeyboardEvent: dom.window.KeyboardEvent, MouseEvent: dom.window.MouseEvent,
    React, IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { YuminaContext, useYumina } = await import("../../../sandbox/sandbox-context");
  const { MessageBubble } = await import("../../../sandbox/chat/message-bubble");

  let base: ReturnType<typeof useYumina> | null = null;
  function Grab() { base = useYumina(); return null; }
  renderToStaticMarkup(<Grab />);
  const api = {
    ...base!,
    entries: [{ id: "e1", name: "Lilith", role: "character", enabled: true, portrait: PORTRAIT }],
  } as unknown as ReturnType<typeof useYumina>;

  const message: SandboxMessage = { id: "m1", sessionId: "s1", role: "assistant", content: "Lilith smiles. \"Welcome back.\"", createdAt: "2026-10-17T00:00:00Z" };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<YuminaContext.Provider value={api}><MessageBubble message={message} /></YuminaContext.Provider>);
  });

  const face = host.querySelector<HTMLImageElement>(`img[role="button"][src="${PORTRAIT}"]`);
  assert.ok(face, "the speaker's face is a button");
  assert.equal(document.querySelector('[role="dialog"]'), null);

  await act(async () => { face.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  const dialog = document.querySelector('[role="dialog"]');
  assert.ok(dialog, "clicking the face opens the viewer");
  assert.equal(dialog.querySelector("img")?.getAttribute("src"), PORTRAIT);
  assert.equal(dialog.querySelector("figcaption")?.textContent, "Lilith");

  await act(async () => { document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape" })); });
  assert.equal(document.querySelector('[role="dialog"]'), null, "Escape closes it");

  await act(async () => { root.unmount(); });
});
