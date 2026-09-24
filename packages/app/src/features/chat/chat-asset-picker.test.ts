import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import React, { act, createElement } from "react";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

test("picker navigates nested folders, scopes uploads, and returns the selected durable asset", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost", pretendToBeVisual: true });
  const globals = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement,
    Element: dom.window.Element, Node: dom.window.Node, NodeFilter: dom.window.NodeFilter,
    MutationObserver: dom.window.MutationObserver, CustomEvent: dom.window.CustomEvent,
    getComputedStyle: dom.window.getComputedStyle, localStorage: dom.window.localStorage,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    React, IS_REACT_ACT_ENVIRONMENT: true,
  };
  const originals = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const originalFetch = globalThis.fetch;
  const folders = [{ id: "scenes", name: "Scenes", parentFolderId: null }, { id: "night", name: "Night", parentFolderId: "scenes" }];
  const image = { id: "0bd18657-0b64-4331-af37-8df7e508954b", filename: "moon.png", mimeType: "image/png", type: "image", url: "https://yumina.io/cdn/photo", folderId: "night" };
  const queries: URLSearchParams[] = [];
  let uploaded = false;
  globalThis.fetch = (async input => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/folders")) return Response.json({ data: folders });
    queries.push(url.searchParams);
    return Response.json({ data: url.searchParams.get("folderId") === "night" && uploaded ? [image] : [], total: uploaded ? 1 : 0 });
  }) as typeof fetch;
  const vite = await createServer({ root: fileURLToPath(new URL("../../..", import.meta.url)), configFile: false, appType: "custom", logLevel: "silent", resolve: { alias: { "@": fileURLToPath(new URL("../..", import.meta.url)) } }, server: { middlewareMode: true } });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  const frame = dom.window.document.createElement("iframe");
  dom.window.document.body.append(frame);
  frame.focus();
  try {
    const { ChatAssetPicker } = await vite.ssrLoadModule("/src/features/chat/chat-asset-picker.tsx");
    const { useUserAssetStore } = await vite.ssrLoadModule("/src/stores/user-assets.ts");
    const uploads: unknown[][] = [];
    useUserAssetStore.setState({ uploadAsset: async (...args: unknown[]) => { uploads.push(args); uploaded = true; return image; } });
    let selected: unknown = null;
    let closed = false;
    let escapedToGame = false;
    dom.window.addEventListener("keydown", () => { escapedToGame = true; });
    await act(async () => { root.render(createElement(ChatAssetPicker, { onSelect: (value: unknown) => { selected = value; }, onClose: () => { closed = true; } })); });
    const click = async (text: string) => {
      const button = [...dom.window.document.querySelectorAll("button")].find(el => el.textContent?.trim() === text);
      assert.ok(button, `Missing button: ${text}`);
      await act(async () => { button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    };
    assert.equal(queries.at(-1)?.get("folderId"), "root");
    await click("Scenes");
    await click("Night");
    assert.equal(queries.at(-1)?.get("folderId"), "night");
    assert.equal(queries.at(-1)?.get("offset"), "0");
    assert.deepEqual([...dom.window.document.querySelectorAll("nav button")].map(el => el.textContent), ["My Assets", "Scenes", "Night"]);
    const fileInput = dom.window.document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(["picture"], "moon.png", { type: "image/png" });
    Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
    await act(async () => { fileInput.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    assert.equal(uploads[0]?.[2], "night");
    assert.deepEqual(uploads[0]?.[3], { addToList: false });
    assert.equal(dom.window.document.querySelector('[aria-pressed="true"]')?.textContent, "moon.png");
    await click("Add to message");
    assert.deepEqual(selected, { type: "image", assetId: image.id, name: image.filename, mimeType: image.mimeType, url: image.url });
    await click("My Assets");
    assert.equal(queries.at(-1)?.get("folderId"), "root");
    assert.equal(dom.window.document.querySelector('[aria-pressed="true"]'), null);
    await act(async () => { dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    assert.equal(closed, true);
    assert.equal(escapedToGame, false, "Escape dismisses only the picker, not the game");
    await act(async () => root.render(null));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(dom.window.document.activeElement, frame, "Return typing focus to the game iframe");
  } finally {
    await act(async () => root.unmount());
    await vite.close(); globalThis.fetch = originalFetch; dom.window.close();
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
