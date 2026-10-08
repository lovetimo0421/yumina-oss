import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement, type ComponentType } from "react";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { clientDom, loadClientModule } from "../../lib/feed-beacon.test-helpers.js";

test("shared search ignores silent autofill, accepts typing, and confirms outside IME composition", async () => {
  const fixture = clientDom();
  const { createRoot } = await import("react-dom/client");
  const { TopBarSearch } = loadClientModule<{ TopBarSearch: ComponentType<{
    value: string; onValueChange: (value: string) => void; placeholder: string; onConfirm: () => void;
  }> }>(new URL("./top-bar-search.tsx", import.meta.url), { "./top-bar-search.css": {} });
  const { document } = fixture.dom.window;
  const root = createRoot(document.getElementById("root")!);
  const changes: string[] = [];
  let confirmed = 0;
  const render = async (key: string, value: string) => {
    await act(async () => root.render(createElement(TopBarSearch, {
      key, value, placeholder: key, onValueChange: (value) => changes.push(value),
      onConfirm: () => { confirmed++; },
    })));
    return document.querySelector<HTMLInputElement>("input")!;
  };
  const change = async (input: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(fixture.dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    await act(async () => input.dispatchEvent(new fixture.dom.window.Event("input", { bubbles: true })));
  };
  const keydown = async (input: HTMLInputElement, options: KeyboardEventInit) => {
    await act(async () => input.dispatchEvent(new fixture.dom.window.KeyboardEvent("keydown", { bubbles: true, ...options })));
  };
  try {
    let input = await render("Discover", "");
    assert.equal(input.type, "search");
    assert.equal(input.autocomplete, "off");
    assert.equal(input.getAttribute("aria-label"), "Discover");
    await change(input, "autofill@example.test");
    assert.deepEqual(changes, []);
    await act(async () => input.focus());
    await change(input, "故事");
    assert.deepEqual(changes, ["故事"]);
    await keydown(input, { key: "Enter", isComposing: true });
    await keydown(input, { key: "Enter", keyCode: 229 });
    await keydown(input, { key: "Escape" });
    assert.equal(confirmed, 0);
    assert.equal(document.activeElement, input);
    await keydown(input, { key: "Enter" });
    assert.equal(confirmed, 1);
    assert.notEqual(document.activeElement, input);
    await act(async () => input.focus());
    await act(async () => document.querySelector<HTMLButtonElement>("button")!.click());
    assert.equal(confirmed, 2);
    assert.notEqual(document.activeElement, input);

    input = await render("Library", "saved query");
    assert.equal(input.value, "saved query");
    await change(input, "second-autofill@example.test");
    assert.deepEqual(changes, ["故事"], "route changes reset the touched guard");
    await act(async () => input.focus());
    await change(input, "");
    assert.deepEqual(changes, ["故事", ""], "native search clearing updates the owning store");
    await keydown(input, { key: "Enter" });
    assert.equal(confirmed, 3, "Library has the same keyboard confirmation");
  } finally {
    await act(async () => root.unmount());
    fixture.restore();
  }
});

test("mobile search leaves backdrop sampling on its wrapper regardless of stylesheet order", () => {
  const css = readFileSync(new URL("./top-bar-search.css", import.meta.url), "utf8");
  const globals = readFileSync(new URL("../../styles/globals.css", import.meta.url), "utf8");
  const mobileReset = globals.match(/html:is\([^\n]+\) \.topbar-search-input--glass \{[^}]+\}/)![0];
  for (const styles of [mobileReset + css, css + mobileReset]) {
    for (const canvas of ['data-mobile-page-scroll="library-main"', 'data-mobile-app-canvas="wallpaper"']) {
      const dom = new JSDOM(`<html ${canvas}><head><style>${styles}</style></head><body>
        <div class="topbar-shell--search"><div class="topbar-search-glass">
          <input class="topbar-search-input--glass">
        </div></div></body></html>`, { pretendToBeVisual: true });
      try {
        const input = dom.window.document.querySelector("input")!;
        const style = dom.window.getComputedStyle(input);
        assert.equal(style.getPropertyValue("backdrop-filter"), "none");
        assert.equal(style.backgroundColor, "rgba(0, 0, 0, 0)");
      } finally {
        dom.window.close();
      }
    }
  }
});
