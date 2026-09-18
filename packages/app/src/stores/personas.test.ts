import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { transform } from "sucrase";
import type { usePersonasStore as Store } from "./personas";
import type { Persona } from "./personas";

function loadStore(): typeof Store {
  const source = readFileSync(new URL("./personas.ts", import.meta.url), "utf8")
    .replaceAll("import.meta.env?.VITE_API_URL", '""');
  const module = { exports: {} as { usePersonasStore: typeof Store } };
  new Function("require", "module", "exports", transform(source, { transforms: ["typescript", "imports"] }).code)(
    createRequire(import.meta.url), module, module.exports,
  );
  const store = module.exports.usePersonasStore;
  store.setState({ personas: [{ id: "A", isActive: true }, { id: "B", isActive: false }] as Persona[] });
  return store;
}

for (const operation of ["activate", "forced refresh"] as const) {
  test(`${operation} invalidates an old persona list and refetches committed state`, async () => {
    const store = loadStore();
    const originalFetch = globalThis.fetch;
    const initial = store.getState().personas;
    const committed = initial.map((p) => ({ ...p, isActive: p.id === "B" }));
    const reads: ((response: Response) => void)[] = [];
    globalThis.fetch = async (_url, init) => {
      if (init?.method === "POST") return Response.json({ data: {} });
      return new Promise<Response>((resolve) => reads.push(resolve));
    };
    try {
      const pending = store.getState().fetchPersonas();
      assert.equal(reads.length, 1);
      if (operation === "activate") assert.equal(await store.getState().activatePersona("B"), true);
      else await store.getState().fetchPersonas(true);
      assert.equal(reads.length, 1, "only one list request is in flight");
      reads[0]!(Response.json({ data: initial }));
      await pending;
      assert.equal(reads.length, 2, "stale response schedules a fresh read");
      if (operation === "activate") assert.equal(store.getState().personas.find((p) => p.isActive)?.id, "B", "stale GET cannot undo committed activation");
      assert.equal(store.getState().lastFetchedAt, null, "stale data is never published");
      reads[1]!(Response.json({ data: committed }));
      await setImmediate();
      assert.equal(store.getState().personas.find((p) => p.isActive)?.id, "B");
      assert.equal(store.getState().loading, false);
      assert.notEqual(store.getState().lastFetchedAt, null);
    } finally { globalThis.fetch = originalFetch; }
  });
}

for (const action of ["activate", "deactivate"] as const) {
  test(`${action} publishes only a committed selection and rejects concurrent selection`, async () => {
    const store = loadStore();
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    let resolve!: (response: Response) => void;
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return new Promise<Response>((done) => { resolve = done; });
    };
    try {
      const pending = action === "activate" ? store.getState().activatePersona("B") : store.getState().deactivatePersonas();
      assert.equal(store.getState().savingSelection, true);
      assert.equal(store.getState().personas.find((p) => p.isActive)?.id, "A");
      assert.equal(await store.getState().activatePersona("A"), false);
      assert.equal(await store.getState().deactivatePersonas(), false);
      assert.equal(calls.length, 1);
      assert.equal(calls[0], action === "activate" ? "/api/personas/B/activate" : "/api/personas/deactivate");
      resolve(Response.json({ data: {} }));
      assert.equal(await pending, true);
      assert.equal(store.getState().savingSelection, false);
      assert.equal(store.getState().personas.find((p) => p.isActive)?.id, action === "activate" ? "B" : undefined);
    } finally { globalThis.fetch = originalFetch; }
  });

  for (const failure of ["http", "network"] as const) {
    test(`${action} preserves the previous persona after ${failure} failure and allows retry`, async () => {
      const store = loadStore();
      const originalFetch = globalThis.fetch;
      const select = () => action === "activate" ? store.getState().activatePersona("B") : store.getState().deactivatePersonas();
      globalThis.fetch = async () => {
        if (failure === "network") throw new Error("offline");
        return new Response(null, { status: 500 });
      };
      try {
        assert.equal(await select(), false);
        assert.equal(store.getState().personas.find((p) => p.isActive)?.id, "A");
        assert.equal(store.getState().savingSelection, false);
        globalThis.fetch = async () => Response.json({ data: {} });
        assert.equal(await select(), true);
        assert.equal(store.getState().personas.find((p) => p.isActive)?.id, action === "activate" ? "B" : undefined);
      } finally { globalThis.fetch = originalFetch; }
    });
  }
}
