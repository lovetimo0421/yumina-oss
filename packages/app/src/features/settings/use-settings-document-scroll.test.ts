import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { useSettingsDocumentScroll } from "./use-settings-document-scroll.js";

test("mobile Settings enters sections at the top and restores the menu without moving desktop or initial history", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const keys = ["window", "document", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const root = createRoot(dom.window.document.getElementById("root")!);
  let top = 280;
  let rememberMenu = () => {};
  Object.defineProperty(dom.window, "scrollY", { get: () => top });
  dom.window.scrollTo = ((options: ScrollToOptions) => { top = options.top ?? 0; }) as typeof dom.window.scrollTo;
  const html = dom.window.document.documentElement;
  html.setAttribute("data-mobile-page-scroll", "settings-main");
  function Harness({ nav, section }: { nav: boolean; section: string }) {
    rememberMenu = useSettingsDocumentScroll(nav, section);
    return null;
  }
  const render = async (nav: boolean, section: string) => {
    await act(async () => root.render(createElement(Harness, { nav, section })));
  };
  try {
    await render(true, "account");
    assert.equal(top, 280, "mount must not overwrite history restoration");
    rememberMenu();
    await render(false, "ai-config");
    assert.equal(top, 0);
    top = 920;
    await render(true, "ai-config");
    assert.equal(top, 280, "Back restores the menu, not the section's offset");
    rememberMenu();
    await render(false, "privacy");
    top = 610;
    await render(false, "account");
    assert.equal(top, 0, "direct section changes start at their header too");
    html.removeAttribute("data-mobile-page-scroll");
    top = 410;
    await render(true, "account");
    assert.equal(top, 410, "desktop keeps independent pane positions");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    keys.forEach((key, i) => {
      if (previous[i]) Object.defineProperty(globalThis, key, previous[i]!);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
});
