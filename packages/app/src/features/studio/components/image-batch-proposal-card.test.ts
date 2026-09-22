import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { transform } from "sucrase";
import { proposal, snapshot } from "../lib/image-batch-test-fixtures";
import * as helpers from "../lib/image-batch-state";
import type { StudioImageBatchEdits } from "../lib/types";

type Props = Parameters<typeof import("./image-batch-proposal-card").ImageBatchProposalView>[0];
const translations = JSON.parse(readFileSync(new URL("../../../locales/zh/editor.json", import.meta.url), "utf8"));
function translate(key: string, values: Record<string, unknown> = {}) {
  let value = translations;
  for (const part of key.split(".")) value = value[part];
  assert.equal(typeof value, "string", `Missing translation ${key}`);
  return value.replace(/\{\{(\w+)\}\}/g, (_match: string, name: string) => String(values[name] ?? ""));
}
const require = createRequire(import.meta.url);
const module = { exports: {} as { ImageBatchProposalView: (props: Props) => React.ReactNode } };
new Function("require", "module", "exports", transform(readFileSync(new URL("./image-batch-proposal-card.tsx", import.meta.url), "utf8"), {
  transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic",
}).code)((id: string) => {
  if (id === "react-i18next") return { useTranslation: () => ({ t: translate, i18n: { language: "zh" } }) };
  if (id === "@/lib/utils") return { cn: (...classes: unknown[]) => classes.filter(value => typeof value === "string").join(" ") };
  if (id === "@/lib/asset-url") return { resolveImageUrl: (assetId: string) => `/cdn/${assetId}` };
  if (id === "../lib/image-batch-state") return helpers;
  if (id === "../lib/use-image-batch") return {};
  return require(id);
}, module, module.exports);

test("the approved batch card selects only missing images, prices selections and offers targeted recovery", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://synthetic.test/" });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const calls: StudioImageBatchEdits[] = [];
  let retried = 0, resumed = 0;
  let props: Props = { proposal, interactive: true, busy: false, error: "", estimates: { [proposal.model]: 35 },
    onConfirm: edits => calls.push(edits), onDecline: () => {}, onRetry: () => { retried++; }, onResume: () => { resumed++; }, onRefresh: () => {} };
  const root = createRoot(document.getElementById("root")!);
  const render = async (patch: Partial<Props> = {}) => { props = { ...props, ...patch }; await act(async () => root.render(createElement(module.exports.ImageBatchProposalView, props))); };
  const button = (text: string) => [...document.querySelectorAll("button")].find(node => node.textContent?.includes(text))!;
  try {
    await render();
    const existing = document.querySelector<HTMLInputElement>('[aria-label="Existing portrait"]')!;
    assert.equal(existing.checked, false); assert.equal(existing.disabled, true);
    assert.match(document.body.textContent!, /70/);
    assert.equal(document.querySelectorAll("textarea").length, 2);
    await act(async () => { document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
    assert.equal(button("生成 0 张").disabled, true, "empty selection cannot spend credits");
    await act(async () => { document.querySelector<HTMLInputElement>('[aria-label="Blue hair"]')!.click(); });
    assert.match(document.body.textContent!, /35/);
    await act(async () => button("生成 1 张").click());
    assert.deepEqual(calls[0]?.items, [{ id: "blue", prompt: "A girl with blue hair" }]);
    const model = document.querySelector("select")!;
    await act(async () => { model.value = "openai/gpt-image-2"; model.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    assert.equal(button("生成 1 张").disabled, true, "unknown server estimate does not imply free generation");
    const batch = snapshot();
    await render({ proposal: { ...proposal, status: "submitted", batch } });
    assert.equal(document.querySelectorAll("img").length, 2, "delivered and existing images remain inspectable");
    await act(async () => button("重试 1 个").click());
    assert.equal(retried, 1);
    batch.items[1]!.status = "binding_failed"; batch.items[1]!.assetId = "asset-blue";
    await render({ proposal: { ...proposal, status: "submitted", batch: { ...batch } } });
    assert.match(document.body.textContent!, /不会重新生图或再次收费/);
    assert.ok(button("重试图片绑定"));
    await render({ proposal: { ...proposal, status: "submitted", batch: { ...batch, status: "paused" } } });
    await act(async () => button("继续生成剩余图片").click());
    assert.equal(resumed, 1);
    for (const pauseReason of ["GENERATION_BUDGET", "GENERATION_BUSY", "BILLING_UNAVAILABLE", "DELIVERY_PENDING", "UNKNOWN_REASON"]) {
      await render({ proposal: { ...proposal, status: "submitted", batch: { ...batch, status: "paused", pauseReason } } });
      assert.match(document.body.textContent!, /任务暂时暂停/);
      assert.doesNotMatch(document.body.textContent!, /Mushies 不足/, `${pauseReason} must not ask the creator to top up`);
    }
    await render({ proposal: { ...proposal, status: "submitted", batch: { ...batch, status: "paused", pauseReason: "GENERATION_BUDGET",
      items: batch.items.map(item => item.id === "blue" ? { ...item, status: "awaiting_credits" } : item) } } });
    assert.match(document.querySelector('[data-batch-item="blue"]')!.textContent!, /已暂停/);
    assert.doesNotMatch(document.body.textContent!, /等待 Mushies|Mushies 不足/);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
