import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { clientDom, loadClientModule } from "../../lib/feed-beacon.test-helpers";
import { SandboxBootTiming } from "../../lib/sandbox-boot-timing";

test("passive boot diagnostics survive analytics errors and ignore a disposed bridge", async () => {
  const fixture = clientDom();
  const instances: FakeBridge[] = [];
  class FakeBridge {
    resolveReady!: () => void;
    ready = new Promise<void>((resolve) => { this.resolveReady = resolve; });
    installs = 0;
    destroyed = false;
    constructor(readonly options: { onRendered: () => void }) { instances.push(this); }
    attach() {}
    waitReady() { return this.ready; }
    destroy() { this.destroyed = true; }
    installRoot() { this.installs++; }
  }
  const { useSandbox } = loadClientModule<typeof import("./use-sandbox")>(new URL("./use-sandbox.ts", import.meta.url), {
    "./bridge-parent": { SandboxBridge: FakeBridge },
    "@/lib/sandbox-doc-url": { SANDBOX_DOC_URL: "/sandbox/index.html" },
    "@/lib/sandbox-boot-timing": { SandboxBootTiming },
  });
  const events: { name: string; data: Record<string, string | number | boolean> }[] = [];
  let latest!: ReturnType<typeof useSandbox>;
  function Host({ active }: { active: boolean }) {
    latest = useSandbox({ active, onApiCall: () => undefined, onDiag: (name, data) => {
      events.push({ name, data }); throw new Error("analytics unavailable");
    } });
    useEffect(() => latest.installRoot("main.tsx", { "main.tsx": "" }, "compiled"), []);
    return createElement("iframe", { ref: latest.iframeRefCallback });
  }
  const root = createRoot(fixture.dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(Host, { active: true })));
    fixture.dom.window.document.querySelector("iframe")!.dispatchEvent(new fixture.dom.window.Event("load"));
    await act(async () => instances[0]!.resolveReady());
    assert.equal(latest.ready, true);
    await act(async () => instances[0]!.options.onRendered());
    await act(async () => instances[0]!.options.onRendered());
    assert.equal(latest.rendered, true);
    assert.equal(instances[0]!.installs, 1);
    assert.deepEqual(events.map((event) => event.name), ["boot_ready", "boot_rendered"]);
    assert.equal(typeof events[1]!.data.loaded_ms, "number");
    assert.equal(typeof events[1]!.data.install_requested_ms, "number");
    await act(async () => root.render(createElement(Host, { active: false })));
    assert.equal(latest.getBootTiming().renderer_active, false);
    await act(async () => root.render(null));
    assert.equal(instances[0]!.destroyed, true);
    await act(async () => root.render(createElement(Host, { active: true })));
    await act(async () => root.render(null));
    await act(async () => instances[1]!.resolveReady());
    assert.equal(events.length, 2, "disposed bridges must not report readiness for the next session");
  } finally {
    await act(async () => root.unmount());
    fixture.restore();
  }
});
