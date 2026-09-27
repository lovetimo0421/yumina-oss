import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { transform } from "sucrase";

test("notification settings shortcut changes sections even when Settings is already mounted", () => {
  const source = readFileSync(new URL("./settings-page.tsx", import.meta.url), "utf8");
  const syncStart = source.indexOf("    const syncFromHash =");
  const effect = source.slice(source.lastIndexOf("  useEffect(() => {", syncStart), source.indexOf("\n\n  useEffect", syncStart));
  const dom = new JSDOM("", { url: "https://yumina.test/app/settings#account" });
  let activeSection = "";
  let mobileShowNav = true;
  let onResolved: (() => void) | undefined;
  let cleanup: (() => void) | undefined;
  new Function("window", "useEffect", "router", "parseSectionHash", "setActiveSection", "setMobileShowNav", effect)(
    dom.window,
    (fn: () => () => void) => { cleanup = fn(); },
    { subscribe: (event: string, fn: () => void) => {
      assert.equal(event, "onResolved");
      onResolved = fn;
      return () => { onResolved = undefined; };
    } },
    (hash: string) => hash.slice(1),
    (section: string) => { activeSection = section; },
    (visible: boolean) => { mobileShowNav = visible; },
  );
  try {
    assert.equal(activeSection, "account");
    dom.window.history.pushState({}, "", "/app/settings#notifications");
    assert.ok(onResolved);
    onResolved();
    assert.equal(activeSection, "notifications");
    assert.equal(mobileShowNav, false);
  } finally {
    cleanup?.();
    assert.equal(onResolved, undefined);
    dom.window.close();
  }
});

test("creator-post setting loads saved opt-out and toggles without changing other notification choices", async () => {
  const source = readFileSync(new URL("./settings-page.tsx", import.meta.url), "utf8");
  const section = source.slice(source.indexOf("function NotificationsSection("), source.indexOf("type FontSize ="));
  const loader = source.slice(source.indexOf("function loadNotificationPreferences("), source.indexOf("function loadSettings("));
  const defaults = source.slice(source.indexOf("const DEFAULT_NOTIFICATION_PREFS"), source.indexOf("interface PrivacySettings"));
  const toggle = source.slice(source.indexOf("function ToggleSwitch("), source.indexOf("function ToggleSwitch(") + source.slice(source.indexOf("function ToggleSwitch(")).indexOf("\n}\n") + 3);
  const module = { exports: {} as { NotificationsSection: React.ComponentType<any>; loadNotificationPreferences: (raw: unknown) => Record<string, boolean> } };
  const require = createRequire(import.meta.url);
  const passthrough = ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children);
  new Function("require", "module", "exports", "useTranslation", "Card", "CardIcon", "SectionHeader", "Bell", transform(
    `${defaults}\n${loader}\n${toggle}\n${section}\nmodule.exports = { NotificationsSection, loadNotificationPreferences };`,
    { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic" },
  ).code)(require, module, module.exports, () => ({ t: (key: string) => key }), passthrough, () => null, () => null, () => null);
  const { NotificationsSection: Section, loadNotificationPreferences: load } = module.exports;
  assert.equal(load(undefined).creatorPosts, true, "legacy recipients keep receiving opted-in broadcasts");
  let preferences = load({ engagement: false, social: true, library: false, community: true, creatorPosts: false });
  const dom = new JSDOM('<div id="root"></div>');
  const keys = ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const saved = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const root = createRoot(document.getElementById("root")!);
  const render = () => root.render(React.createElement(Section, { settings: { notificationPreferences: preferences }, updateSetting: (key: string, value: Record<string, boolean>) => {
    assert.equal(key, "notificationPreferences");
    preferences = value;
  } }));
  try {
    await act(async () => render());
    const input = document.querySelector('[aria-label="notifications.groups.creatorPosts"]') as HTMLInputElement;
    assert.ok(input);
    assert.equal(input.checked, false);
    await act(async () => input.click());
    assert.deepEqual(preferences, { engagement: false, social: true, library: false, community: true, creatorPosts: true });
    await act(async () => render());
    await act(async () => input.click());
    assert.equal(preferences.creatorPosts, false);
    assert.equal(load(preferences).creatorPosts, false, "a reload retains opt-out");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
