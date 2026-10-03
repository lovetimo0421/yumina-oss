import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { JSDOM } from "jsdom";

test("the share link stays visible after native sharing is canceled and can be copied", async () => {
  const dom = new JSDOM("<div id='root'></div>", {
    url: "https://yumina.io",
    pretendToBeVisual: true,
  });
  const globals = [
    "window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node",
    "DocumentFragment", "MutationObserver", "NodeFilter", "Event", "MouseEvent", "CustomEvent",
    "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame",
    "IS_REACT_ACT_ENVIRONMENT",
  ] as const;
  const originals = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of globals) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : dom.window[key as keyof Window],
    });
  }
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", { configurable: true, value: () => {} });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", { configurable: true, value: () => {} });
  const copied: string[] = [];
  const shared: ShareData[] = [];
  Object.defineProperty(dom.window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => { copied.push(text); } },
  });
  Object.defineProperty(dom.window.navigator, "share", {
    configurable: true,
    value: async (data: ShareData) => {
      shared.push(data);
      const error = new Error("canceled");
      error.name = "AbortError";
      throw error;
    },
  });
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    const i18n = createInstance();
    await i18n.init({
      lng: "en",
      resources: { en: { common: { action: { copy: "Copy", share: "Share", close: "Close" } } } },
      defaultNS: "common",
    });
    const { ShareLinkDialog } = await import("./share-link-dialog");
    await act(async () => root.render(createElement(I18nextProvider, { i18n },
      createElement(ShareLinkDialog, {
        title: "Played game",
        url: "https://yumina.io/app/hub/played-game",
        open: true,
        onOpenChange: () => {},
        copiedLabel: "Link copied",
        failedLabel: "Failed to share",
      }),
    )));

    const share = [...dom.window.document.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Share");
    assert.ok(share);
    await act(async () => share.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    assert.deepEqual(shared, [{ title: "Played game", url: "https://yumina.io/app/hub/played-game" }]);
    assert.equal(dom.window.document.querySelector("input")?.value, "https://yumina.io/app/hub/played-game");

    const copy = [...dom.window.document.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Copy");
    assert.ok(copy);
    await act(async () => copy.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    assert.deepEqual(copied, ["https://yumina.io/app/hub/played-game"]);
    assert.ok(dom.window.document.body.textContent?.includes("Link copied"));
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const key of globals) {
      const descriptor = originals.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
