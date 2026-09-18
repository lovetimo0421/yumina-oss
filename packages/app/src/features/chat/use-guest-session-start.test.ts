import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { transform } from "sucrase";

test("guest sign-in failure stays on the preview, retries once, and ignores abandoned requests", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://yumina.test/app/preview/world-1" });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map([...Object.keys(globals), "fetch"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const requests: ((response: Response) => void)[] = [];
  globalThis.fetch = () => new Promise<Response>((resolve) => requests.push(resolve));
  const navigations: unknown[] = [];
  const router = { state: { location: { href: "/app/preview/world-1" } }, navigate: (options: unknown) => { navigations.push(options); return Promise.resolve(); } };
  const require = createRequire(import.meta.url);
  const module = { exports: {} as { useGuestSessionStart: (ready: boolean, id: string, context: object) => { startError: boolean; retryStart: () => void } } };
  const source = readFileSync(new URL("./use-guest-session-start.ts", import.meta.url), "utf8").replace("import.meta.env.VITE_API_URL", '""');
  new Function("require", "module", "exports", transform(source, { transforms: ["typescript", "imports"] }).code)(
    (id: string) => id === "@tanstack/react-router" ? { useRouter: () => router } : require(id), module, module.exports,
  );
  const context = { returnTo: "/app/users/creator", returnKey: "original-return-key" };
  const Host = () => {
    const { startError, retryStart } = module.exports.useGuestSessionStart(true, "world-1", context);
    return createElement("button", { onClick: retryStart }, startError ? "Retry" : "Starting");
  };
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(StrictMode, {}, createElement(Host))));
    assert.equal(requests.length, 1, "StrictMode must not create duplicate sessions");
    await act(async () => requests[0]!(new Response("{}", { status: 500 })));
    assert.equal(dom.window.document.querySelector("button")!.textContent, "Retry");
    assert.deepEqual(navigations, [], "a failure must not route to Discover");
    await act(async () => dom.window.document.querySelector("button")!.click());
    assert.equal(requests.length, 2);
    await act(async () => requests[1]!(new Response(JSON.stringify({ data: { id: "session-1" } }))));
    assert.deepEqual(navigations, [{ to: "/app/chat/$sessionId", params: { sessionId: "session-1" }, search: { moderationGroupKey: undefined, ...context } }]);
    await act(async () => dom.window.document.querySelector("button")!.click());
    await act(async () => root.render(null));
    await act(async () => requests[2]!(new Response(JSON.stringify({ data: { id: "abandoned-session" } }))));
    assert.equal(navigations.length, 1);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
