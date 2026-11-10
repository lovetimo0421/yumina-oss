import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement, useEffect, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { clientDom, loadClientModule } from "../../lib/feed-beacon.test-helpers";
import * as urls from "../../lib/asset-url";

test("avatars retry the original when resizing is unavailable, reset for a new creator, and stop after original failure", async () => {
  const env = clientDom();
  const attempts: string[] = [];
  const statuses: string[] = [];
  function PreloadedImage({ src, onLoadingStatusChange }: { src: string; onLoadingStatusChange: (status: string) => void }) {
    useEffect(() => {
      attempts.push(src);
      onLoadingStatusChange(src.includes("/cdn-cgi/") || src.includes("missing") ? "error" : "loaded");
    }, [src]);
    return createElement("img", { src });
  }
  const { AvatarImage } = loadClientModule<{ AvatarImage: ComponentType<Record<string, unknown>> }>(new URL("./avatar.tsx", import.meta.url), {
    "@radix-ui/react-avatar": { Root: "span", Image: PreloadedImage, Fallback: "span" },
    "@/lib/utils": { cn: (...parts: string[]) => parts.filter(Boolean).join(" ") },
    "@/lib/asset-url": urls,
  });
  const root = createRoot(env.dom.window.document.getElementById("root")!);
  const render = async (src: string) => { await act(async () => root.render(createElement(AvatarImage, { src, onLoadingStatusChange: (s: string) => statuses.push(s) }))); };
  try {
    await render("/cdn/first");
    assert.deepEqual(attempts, [urls.cardImageUrl("/cdn/first", 128), "https://client.test/cdn/first"]);
    assert.deepEqual(statuses, ["loaded"], "an unavailable transform does not report a final avatar failure");
    await render("/cdn/second");
    assert.deepEqual(attempts.slice(2), [urls.cardImageUrl("/cdn/second", 128), "https://client.test/cdn/second"]);
    await render("/cdn/missing");
    assert.equal(attempts.length, 6, "one retry only, even when the original also fails");
    assert.equal(statuses.at(-1), "error");
    await render("https://example.test/missing-avatar.jpg");
    assert.equal(attempts.length, 7, "foreign originals are never retried as if they were transforms");
  } finally { await act(async () => root.unmount()); env.restore(); }
});
