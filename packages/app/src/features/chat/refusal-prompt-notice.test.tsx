import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { act, createElement, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { transform } from "sucrase";
import * as translations from "../../../sandbox/chat/i18n";
import type { SandboxedYuminaAPI } from "../../../sandbox/sandbox-context";

test("refusal recovery opens Prompt Plaza, respects eligibility, and preserves existing actions", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const navigations: string[] = [];
  let retries = 0;
  const prompts = { eligible: true, family: "other", familyLabel: "Other", boundPromptName: null, prompts: [] };
  const api: Pick<SandboxedYuminaAPI, "mode" | "readOnly" | "isStreaming" | "language" | "selectedModel" | "playerPrompts" | "navigate"> = {
    mode: "session", readOnly: false, isStreaming: false, language: "en", selectedModel: "test/model",
    playerPrompts: prompts, navigate: (path) => { navigations.push(path); },
  };
  const require = createRequire(import.meta.url);
  const modules: Record<string, unknown> = {
    "../sandbox-context": { useYumina: () => api },
    "../platform-overlay-portal": { SandboxPlatformOverlay: () => null },
    "./model-picker-modal": { ModelPickerModal: () => null },
    "./i18n": translations,
  };
  const module = { exports: {} as { RefusalBar: ComponentType<{ kind: "refused" | "blocked"; dismissKey?: string; onRetry: () => void }> } };
  const source = readFileSync(new URL("../../../sandbox/chat/player-prompts.tsx", import.meta.url), "utf8");
  new Function("require", "module", "exports", transform(source, { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic" }).code)(
    (id: string) => modules[id] ?? require(id), module, module.exports);
  const root = createRoot(dom.window.document.getElementById("root")!);
  const render = (kind: "refused" | "blocked" = "refused", dismissKey = "reply") => act(async () => {
    root.render(createElement(module.exports.RefusalBar, { kind, dismissKey, onRetry: () => { retries++; } }));
  });
  const button = (label: string) => Array.from(dom.window.document.querySelectorAll("button")).find((el) => el.textContent === label);
  try {
    await render();
    assert.match(dom.window.document.body.textContent ?? "", /Looks like a refusal/);
    assert.match(dom.window.document.querySelector('[role="status"]')?.textContent ?? "", /An Unrestricted prompt/);
    await act(async () => button("Open Prompt Plaza")!.click());
    assert.deepEqual(navigations, ["/app/prompts"]);
    assert.equal(retries, 0, "browsing prompts must not regenerate or install a prompt");
    await act(async () => button("Retry")!.click());
    assert.equal(retries, 1);
    assert.ok(button("Try another model"));

    for (const [language, cta, phrase] of [
      ["en", "Open Prompt Plaza", "An Unrestricted prompt"],
      ["zh", "打开提示词广场", "可能有助于模型继续回复"],
      ["zh-Hant", "開啟提示詞廣場", "可能有助於模型繼續回覆"],
      ["ja", "プロンプト広場を開く", "モデルが返信を続けられる場合があります"],
      ["es", "Abrir Plaza de prompts", "puede ayudar al modelo a continuar"],
    ]) {
      api.language = language!;
      await render();
      assert.ok(button(cta!), language);
      assert.ok(dom.window.document.querySelector('[role="status"]')?.textContent?.includes(phrase!), language);
    }
    api.language = "en";
    api.isStreaming = true;
    await render();
    assert.equal(button("Open Prompt Plaza")!.disabled, true);
    api.isStreaming = false;

    for (const state of [
      { playerPrompts: { ...prompts, eligible: false } },
      { playerPrompts: null },
      { readOnly: true },
      { mode: "preview" as const },
    ]) {
      Object.assign(api, { mode: "session", readOnly: false, playerPrompts: prompts }, state);
      await render();
      assert.equal(button("Open Prompt Plaza"), undefined);
      assert.equal(dom.window.document.querySelector('[role="status"]'), null);
    }
    Object.assign(api, { mode: "session", readOnly: false, playerPrompts: prompts });
    await render("blocked");
    assert.match(dom.window.document.body.textContent ?? "", /provider blocked this reply/);
    assert.equal(button("Open Prompt Plaza"), undefined, "provider filter failures need separate recovery guidance");
    await render("blocked", "blocked:reply");
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());
    assert.equal(dom.window.document.querySelector(".play-refusal-bar"), null, "a blocked bar can be closed so it stops covering the input");
    await render();
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>('button[aria-label="Not a refusal — hide"]')!.click());
    assert.equal(dom.window.document.querySelector(".play-refusal-bar"), null);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
