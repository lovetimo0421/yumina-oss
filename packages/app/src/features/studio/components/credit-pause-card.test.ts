import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { transform } from "sucrase";
import type { StudioCreditPause } from "../lib/types";

type CardProps = Parameters<typeof import("./credit-pause-card").CreditPauseCard>[0];
const translations = JSON.parse(readFileSync(new URL("../../../locales/zh/editor.json", import.meta.url), "utf8"));
function translate(key: string, values: Record<string, string> = {}) {
  let value: unknown = translations;
  for (const part of key.split(".")) value = (value as Record<string, unknown>)[part];
  assert.equal(typeof value, "string", `Missing actual Chinese translation: ${key}`);
  return (value as string).replace(/\{\{(\w+)\}\}/g, (_match, name: string) => values[name] ?? "");
}
const require = createRequire(import.meta.url);
const source = readFileSync(new URL("./credit-pause-card.tsx", import.meta.url), "utf8");
const module = { exports: {} as { CreditPauseCard: (props: CardProps) => React.ReactNode } };
new Function("require", "module", "exports", transform(source, {
  transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic",
}).code)((id: string) => {
  if (id === "react-i18next") return { useTranslation: () => ({ t: translate, i18n: { language: "zh" } }) };
  if (id === "@/lib/utils") return { cn: (...classes: unknown[]) => classes.filter(value => typeof value === "string").join(" ") };
  return require(id);
}, module, module.exports);
const pause = (overrides: Partial<StudioCreditPause> = {}): StudioCreditPause => ({
  runId: "synthetic-run", worldId: "synthetic-world", conversationId: "synthetic-chat",
  phase: "generated", requiredCredits: 9.5, iteration: 2, hasSavedResult: true,
  billingUnavailable: false, cost: 9.5, settled: false,
  balance: 6.2, availableCredits: 6.2, reservedCredits: 0, reason: "INSUFFICIENT_CREDITS",
  ...overrides,
});

async function withCard(initial: Partial<CardProps>, check: (view: {
  document: Document;
  calls: { topUp: number; resume: number; refresh: number };
  render: (patch: Partial<CardProps>) => Promise<void>;
  button: (key: string) => HTMLButtonElement | undefined;
  click: (key: string) => Promise<void>;
}) => Promise<void>) {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://synthetic.test/", pretendToBeVisual: true });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const calls = { topUp: 0, resume: 0, refresh: 0 };
  let props: CardProps = { pause: pause(), resuming: false, refreshing: false, error: null,
    onTopUp: () => { calls.topUp++; }, onResume: () => { calls.resume++; }, onRefresh: () => { calls.refresh++; }, ...initial };
  const root = createRoot(dom.window.document.getElementById("root")!);
  const render = async (patch: Partial<CardProps>) => {
    props = { ...props, ...patch };
    await act(async () => root.render(createElement(module.exports.CreditPauseCard, props)));
  };
  const button = (key: string) => Array.from(dom.window.document.querySelectorAll("button"))
    .find(node => node.textContent === translate(`studio.aiChat.creditPause.${key}`));
  try {
    await render({});
    await check({ document: dom.window.document, calls, render, button,
      click: async key => { const node = button(key); assert.ok(node, `Missing ${key} action`); await act(async () => node.click()); },
    });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test("an insufficient preflight budget offers funding while Continue stays disabled", async () => {
  await withCard({ pause: pause({ phase: "preflight", hasSavedResult: false, cost: undefined }) }, async view => {
    assert.equal(view.button("resume")?.disabled, true);
    assert.equal(view.button("topUp")?.disabled, false);
    assert.ok(view.document.body.textContent?.includes(translate("studio.aiChat.creditPause.budget")));
    assert.equal(view.document.body.textContent?.includes(translate("studio.aiChat.creditPause.actual")), false);
    await view.click("resume");
    await view.click("topUp");
    assert.deepEqual(view.calls, { topUp: 1, resume: 0, refresh: 0 });
  });
});

test("funding a saved generation changes the action to explicit settlement without auto-running", async () => {
  await withCard({}, async view => {
    assert.ok(view.button("topUp"));
    await view.render({ pause: pause({ balance: 46.2, availableCredits: 46.2 }) });
    assert.deepEqual(view.calls, { topUp: 0, resume: 0, refresh: 0 });
    assert.equal(view.button("topUp"), undefined);
    assert.equal(view.button("resume"), undefined, "Settlement and continuation use one action");
    assert.equal(view.button("settleResume")?.disabled, false);
    await view.click("settleResume");
    assert.deepEqual(view.calls, { topUp: 0, resume: 1, refresh: 0 });
  });
});

test("already-settled work can continue with zero remaining balance", async () => {
  await withCard({ pause: pause({ settled: true, requiredCredits: 0, balance: 0, availableCredits: 0 }) }, async view => {
    assert.equal(view.button("resume")?.disabled, false);
    assert.equal(view.button("topUp"), undefined);
    assert.equal(view.button("settleResume"), undefined);
    assert.ok(view.document.body.textContent?.includes(translate("studio.aiChat.creditPause.settled")));
    await view.click("resume");
    assert.deepEqual(view.calls, { topUp: 0, resume: 1, refresh: 0 });
  });
});

test("unknown billing hides the zero-cost sentinel and never suggests funding or settlement", async () => {
  await withCard({ pause: pause({ billingUnavailable: true, cost: 0, requiredCredits: 0 }) }, async view => {
    assert.equal(view.document.querySelectorAll("dd").length, 1, "Only the known wallet balance is shown");
    assert.equal(view.document.body.textContent?.includes(translate("studio.aiChat.creditPause.actual")), false);
    assert.equal(view.button("topUp"), undefined);
    assert.equal(view.button("resume"), undefined);
    assert.equal(view.button("settleResume"), undefined);
    await view.click("refresh");
    assert.deepEqual(view.calls, { topUp: 0, resume: 0, refresh: 1 });
  });
});

test("a stale saved world only permits refreshing its status", async () => {
  await withCard({ pause: pause({ reason: "STALE_WORLD", balance: 100, availableCredits: 100 }) }, async view => {
    assert.equal(view.button("resume"), undefined);
    assert.equal(view.button("settleResume"), undefined);
    assert.equal(view.button("topUp"), undefined);
    assert.ok(view.document.body.textContent?.includes(translate("studio.aiChat.creditPause.errorStale")));
    await view.click("refresh");
    assert.deepEqual(view.calls, { topUp: 0, resume: 0, refresh: 1 });
  });
});

test("a live claim marked not resumable permits only a status refresh", async () => {
  await withCard({ pause: pause({ resumable: false, balance: 100, availableCredits: 100 }) }, async view => {
    assert.equal(view.button("resume"), undefined);
    assert.equal(view.button("settleResume"), undefined);
    assert.equal(view.button("topUp"), undefined);
    await view.click("refresh");
    assert.deepEqual(view.calls, { topUp: 0, resume: 0, refresh: 1 });
  });
});

for (const busy of ["resuming", "refreshing"] as const) {
  test(`${busy} disables every action and ignores repeated clicks`, async () => {
    await withCard({ pause: pause({ balance: 100, availableCredits: 100 }), [busy]: true }, async view => {
      const buttons = Array.from(view.document.querySelectorAll("button"));
      assert.ok(buttons.length > 0);
      for (const button of buttons) {
        assert.equal(button.disabled, true);
        await act(async () => { button.click(); button.click(); });
      }
      assert.deepEqual(view.calls, { topUp: 0, resume: 0, refresh: 0 });
    });
  });
}
