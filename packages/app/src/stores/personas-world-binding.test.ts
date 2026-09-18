import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { usePersonasStore, type Persona } from "./personas";

const originalFetch = globalThis.fetch;
const a = { id: "A", name: "A", isActive: true } as Persona;
const b = { id: "B", name: "B", isActive: false } as Persona;
beforeEach(() => usePersonasStore.setState({ personas: [a, b], loading: false, lastFetchedAt: null,
  worldBindings: { world: "A" }, savingWorldBindings: {}, worldBindingErrors: {} }));
afterEach(() => { globalThis.fetch = originalFetch; });

test("disabling the profile default preserves all saved world defaults", async () => {
  globalThis.fetch = async () => Response.json({ data: { activeId: null } });
  assert.equal(await usePersonasStore.getState().deactivatePersonas(), true);
  assert.deepEqual(usePersonasStore.getState().worldBindings, { world: "A" });
  assert.ok(usePersonasStore.getState().personas.every((p) => !p.isActive));
});

test("binding waits for confirmation and ignores an earlier read", async () => {
  const requests: { resolve: (response: Response) => void; init?: RequestInit }[] = [];
  globalThis.fetch = (_url, init) => new Promise<Response>((resolve) => requests.push({ resolve, init }));
  const oldRead = usePersonasStore.getState().fetchWorldBinding("world");
  const save = usePersonasStore.getState().setWorldBinding("world", "B");
  assert.equal(usePersonasStore.getState().worldBindings.world, "A");
  assert.equal(usePersonasStore.getState().savingWorldBindings.world, true);
  assert.equal(await usePersonasStore.getState().setWorldBinding("world", "A"), false);
  requests[1]!.resolve(Response.json({ data: { personaId: "B" } }));
  assert.equal(await save, true);
  requests[0]!.resolve(Response.json({ data: { personaId: "A" } }));
  await oldRead;
  assert.equal(usePersonasStore.getState().worldBindings.world, "B");
  assert.equal(usePersonasStore.getState().savingWorldBindings.world, false);
});

test("failed binding preserves the default, releases pending state, and supports retry", async () => {
  globalThis.fetch = async () => new Response(null, { status: 500 });
  assert.equal(await usePersonasStore.getState().setWorldBinding("world", "B"), false);
  assert.equal(usePersonasStore.getState().worldBindings.world, "A");
  assert.equal(usePersonasStore.getState().savingWorldBindings.world, false);
  assert.equal(usePersonasStore.getState().worldBindingErrors.world, true);
  globalThis.fetch = async () => Response.json({ data: { personaId: "B" } });
  assert.equal(await usePersonasStore.getState().setWorldBinding("world", "B"), true);
  assert.equal(usePersonasStore.getState().worldBindingErrors.world, false);
});

test("deleting a persona clears only its defaults and invalidates an in-flight binding read", async () => {
  usePersonasStore.setState({ worldBindings: { world: "A", otherWorld: "B" } });
  let finishRead!: (response: Response) => void;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/binding/")) return new Promise<Response>((resolve) => { finishRead = resolve; });
    if (init?.method === "DELETE") return Response.json({ data: { id: "A" } });
    return Response.json({ data: [{ ...b, isActive: true }] });
  };
  const oldRead = usePersonasStore.getState().fetchWorldBinding("world");
  assert.equal(await usePersonasStore.getState().deletePersona("A"), true);
  finishRead(Response.json({ data: { personaId: "A" } }));
  await oldRead;
  assert.deepEqual(usePersonasStore.getState().worldBindings, { world: null, otherWorld: "B" });
});
