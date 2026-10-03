import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement, Fragment } from "react";
import { clientDom, loadClientModule } from "@/lib/feed-beacon.test-helpers";
import * as accessState from "@/lib/discover-access-state";

async function mount() {
  const requests: { signal: AbortSignal; resolve: (response: Response) => void }[] = [];
  let user: string | null = "admin";
  const env = clientDom({ fetch: (_url: string, init: RequestInit) => new Promise<Response>(resolve => {
    assert.equal(init.credentials, "include");
    assert.equal(init.cache, "no-store");
    requests.push({ signal: init.signal as AbortSignal, resolve });
  }) });
  const { useDiscoverAccess } = loadClientModule<{ useDiscoverAccess: () => accessState.DiscoverAccess & { loading: boolean } }>(new URL("./use-discover-access.ts", import.meta.url), {
    "@/lib/auth-client": { useSession: () => ({ data: user ? { user: { id: user } } : null, isPending: false }) },
    "@/edition/edition": { IS_LOCAL_BUILD: false },
    "@/lib/discover-access-state": accessState,
  });
  const observations: { enabled: boolean; loading: boolean; owner: string | null }[] = [];
  function View() {
    const access = useDiscoverAccess();
    observations.push({ ...access, owner: user });
    return createElement("output", null, JSON.stringify(access));
  }
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(env.dom.window.document.getElementById("root")!);
  const render = async () => { await act(async () => root.render(createElement(Fragment, null, createElement(View), createElement(View)))); };
  await render();
  return {
    requests, observations,
    latest: () => observations.at(-1)!,
    switchUser: async (next: string | null) => { user = next; await render(); },
    resolve: async (index: number, enabled: boolean, status = 200) => { await act(async () => requests[index]!.resolve(Response.json({ data: { enabled, publicEnabled: false } }, { status }))); },
    focus: async () => { await act(async () => env.dom.window.dispatchEvent(new env.dom.window.Event("focus"))); },
    cleanup: async () => { await act(async () => root.unmount()); env.restore(); },
  };
}

test("duplicate consumers share a request; account switching closes preview before a delayed admin reply", async () => {
  const app = await mount();
  try {
    assert.equal(app.requests.length, 1);
    await app.switchUser("member");
    assert.equal(app.requests.length, 2);
    assert.equal(app.requests[0]!.signal.aborted, true);
    assert.equal(app.latest().enabled, false);
    await app.resolve(0, true);
    assert.equal(app.latest().enabled, false, "a stale admin reply cannot open the member preview");
    await app.resolve(1, false);
    assert.equal(app.latest().loading, false);
    assert.ok(app.observations.filter(item => item.owner === "member").every(item => !item.enabled));
  } finally { await app.cleanup(); }
});

test("logout closes an already loaded preview and a failed access refresh fails closed", async () => {
  const app = await mount();
  try {
    await app.resolve(0, true);
    assert.equal(app.latest().enabled, true);
    await app.focus();
    assert.equal(app.requests.length, 2);
    await app.resolve(1, true, 503);
    assert.equal(app.latest().enabled, false);
    await app.focus();
    await app.resolve(2, true);
    assert.equal(app.latest().enabled, true);
    await app.switchUser(null);
    assert.equal(app.latest().enabled, false);
    await app.resolve(3, false);
    assert.ok(app.observations.filter(item => item.owner === null).every(item => !item.enabled));
  } finally { await app.cleanup(); }
});
