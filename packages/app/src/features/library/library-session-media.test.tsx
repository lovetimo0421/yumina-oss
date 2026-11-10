import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement, type ComponentType, type PropsWithChildren, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { clientDom, loadClientModule, settlePromises } from "../../lib/feed-beacon.test-helpers";

test("library resource tabs load save images, recover from a failed request, and return to highlighted assets", async () => {
  const env = clientDom();
  const requests: string[] = [];
  let failRequest = true;
  const t = (key: string, fallback?: unknown) => typeof fallback === "string" ? fallback : key;
  const panel = ({ children }: PropsWithChildren) => createElement("div", null, children);
  const { LibraryResourcesTab } = loadClientModule<{
    LibraryResourcesTab: ComponentType<{ highlightedAssetId?: string }>;
  }>(new URL("./library-session-media.tsx", import.meta.url), {
    "react-i18next": { useTranslation: () => ({ t }) },
    "@/lib/auth-client": { useSession: () => ({ data: { user: { id: "account" } } }) },
    "@/components/ui/dialog": {
      Dialog: ({ children, open }: PropsWithChildren<{ open: boolean }>) => open ? panel({ children }) : null,
      DialogContent: panel, DialogDescription: panel, DialogFooter: panel, DialogHeader: panel, DialogTitle: panel,
    },
    "@/lib/session-media": {
      SessionMediaError: class extends Error {},
      mediaRequest: async (path: string) => {
        requests.push(path);
        if (failRequest) throw new Error("offline");
        return { items: [], sessions: [], configured: true, hasMore: false,
          storage: { used: 0, limit: 1024, mediaBytes: 0, reserved: 0 } };
      },
    },
    "./library-assets-tab": {
      LibraryAssetsTab: ({ resourceNav, highlightedAssetId }: { resourceNav: ReactNode; highlightedAssetId?: string }) =>
        createElement("div", { "data-assets": highlightedAssetId ?? "all" }, resourceNav),
    },
  });
  const root = createRoot(env.dom.window.document.getElementById("root")!);
  const button = (label: string) => [...env.dom.window.document.querySelectorAll("button")]
    .find(node => node.textContent === label)!;
  try {
    await act(async () => root.render(createElement(LibraryResourcesTab)));
    assert.equal(requests.length, 0, "creative assets do not fetch the private gallery");
    assert.equal(button("Creative assets").getAttribute("aria-pressed"), "true");

    await act(async () => { button("Save images").click(); await settlePromises(); });
    assert.equal(button("Save images").getAttribute("aria-pressed"), "true");
    assert.ok(requests[0]?.startsWith("session-media?"));
    assert.ok(env.dom.window.document.querySelector('[role="alert"]'));

    failRequest = false;
    await act(async () => { button("Retry").click(); await settlePromises(); });
    assert.equal(requests.length, 2);
    assert.equal(env.dom.window.document.querySelector('[role="alert"]'), null);
    assert.ok(env.dom.window.document.body.textContent?.includes("No images match this view."));

    await act(async () => root.render(createElement(LibraryResourcesTab, { highlightedAssetId: "asset" })));
    assert.equal(env.dom.window.document.querySelector('[data-assets="asset"]')?.getAttribute("data-assets"), "asset");
    assert.equal(button("Creative assets").getAttribute("aria-pressed"), "true");
  } finally {
    await act(async () => root.unmount());
    env.restore();
  }
});
