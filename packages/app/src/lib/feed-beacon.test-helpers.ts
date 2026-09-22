import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { transform } from "sucrase";
import { JSDOM } from "jsdom";

/** Load the real client module with only its external boundaries substituted. */
export function loadClientModule<T>(url: URL, mocks: Record<string, unknown> = {}): T {
  const require = createRequire(url);
  const source = readFileSync(url, "utf8").replace(/import\.meta\.env\??\./g, "({}).");
  const module = { exports: {} };
  new Function("require", "module", "exports", transform(source, {
    transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic",
  }).code)((id: string) => mocks[id] ?? require(id), module, module.exports);
  return module.exports as T;
}

export function clientDom(globals: Record<string, unknown> = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://client.test/app/hub", pretendToBeVisual: true });
  const values = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true, ...globals };
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  return {
    dom,
    visibility(state: "hidden" | "visible") {
      Object.defineProperty(dom.window.document, "visibilityState", { configurable: true, value: state });
      dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
    },
    restore() {
      dom.window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

export async function settlePromises() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

/** A ~12 KB, 72-card receipt in the server's signed wire format; no server dependency. */
export function largeDiscoveryReceipt(now = Date.now()) {
  const receipt = {
    version: 1,
    actorId: "guest:client-test-guest", visitId: "client-test-visit", feedRequestId: "client-test-page",
    servedAt: new Date(now).toISOString(), expiresAt: now + 86_400_000,
    entries: Array.from({ length: 72 }, (_, index) => ({
      worldId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      languageGroupId: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
      position: 6000 + index,
    })),
  };
  const secret = "isolated-client-receipt-test-secret";
  const body = Buffer.from(JSON.stringify(receipt)).toString("base64url");
  const signature = createHmac("sha256", secret).update("discovery-receipt-v1\n").update(body).digest("base64url");
  return { receipt, secret, token: `${body}.${signature}` };
}
