import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { SessionData } from "@/stores/chat";
import { createChatPersonaController } from "./refresh-chat-persona";

function fixture() {
  const session: SessionData = { id: "chat-A", worldId: "world", createdAt: "", updatedAt: "",
    state: { variables: { hp: 9 }, metadata: { activeAudio: "song", personaName: "A" } },
    sessionPersona: { persona: { id: "A", name: "A" } } };
  const state = { session, isStreaming: false };
  const calls: { url: string; init?: RequestInit; resolve: (value: Response) => void }[] = [];
  const saving: boolean[] = [];
  const errors: (Error | null)[] = [];
  const controller = createChatPersonaController({ sessionId: session.id, apiBase: "", getState: () => state,
    apply: (next) => { state.session = next; }, onSaving: (value) => saving.push(value), onError: (error) => errors.push(error),
    request: (url, init) => new Promise<Response>((resolve) => { calls.push({ url: String(url), init, resolve }); }),
  });
  const respond = (index: number, name = "B") => calls[index]!.resolve(Response.json({ data: {
    ...session, sessionPersona: { persona: { id: name, name } },
    state: { variables: { hp: 1 }, metadata: { personaName: name, personaActive: true } },
  } }));
  return { state, calls, saving, errors, controller, respond };
}

test("ordinary stream completions never fetch; a requested refresh waits and runs once", async () => {
  const { state, calls, controller, respond } = fixture();
  for (let i = 0; i < 3; i++) { controller.setBlocked(true); controller.setBlocked(false); }
  assert.equal(calls.length, 0);
  state.isStreaming = true;
  controller.setBlocked(true);
  controller.refresh();
  assert.equal(calls.length, 0);
  state.isStreaming = false;
  controller.setBlocked(false);
  assert.equal(calls.length, 1);
  respond(0);
  await setImmediate();
  controller.setBlocked(true); controller.setBlocked(false);
  assert.equal(calls.length, 1);
  controller.dispose();
});

test("selection only writes the requested session, waits for commit, and preserves gameplay", async () => {
  const { state, calls, controller, respond, saving } = fixture();
  const selected = controller.select("B");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "/api/sessions/chat-A/persona");
  assert.equal(calls[0]!.init?.method, "PUT");
  assert.deepEqual(JSON.parse(calls[0]!.init?.body as string), { personaId: "B" });
  assert.equal(state.session.sessionPersona?.persona?.name, "A");
  // Closing a picker has no controller lifecycle action; the save must still finish.
  calls[0]!.resolve(Response.json({ data: { persona: { id: "B", name: "B" } } }));
  assert.equal(await selected, true);
  assert.equal(calls[1]!.url, "/api/sessions/chat-A");
  respond(1);
  await setImmediate();
  assert.deepEqual(saving, [true, false]);
  assert.equal(state.session.sessionPersona?.persona?.name, "B");
  assert.deepEqual(state.session.state.variables, { hp: 9 });
  assert.equal((state.session.state.metadata as Record<string, unknown>).activeAudio, "song");
  controller.dispose();
});

test("session lock writes only lock state and refreshes the effective persona", async () => {
  const { state, calls, controller, respond, saving } = fixture();
  const locked = controller.setLock(true, "B");
  assert.equal(calls[0]!.url, "/api/sessions/chat-A/persona-lock");
  assert.equal(calls[0]!.init?.method, "PUT");
  assert.deepEqual(JSON.parse(calls[0]!.init?.body as string), { locked: true, personaId: "B" });
  calls[0]!.resolve(Response.json({ data: { personaLocked: true, sessionPersona: { persona: { id: "B", name: "B" } } } }));
  assert.equal(await locked, true);
  assert.equal(calls[1]!.url, "/api/sessions/chat-A");
  respond(1);
  await setImmediate();
  assert.deepEqual(saving, [true, false]);

  const unlocked = controller.setLock(false);
  assert.deepEqual(JSON.parse(calls[2]!.init?.body as string), { locked: false });
  calls[2]!.resolve(Response.json({ data: { personaLocked: false, sessionPersona: { persona: { id: "A", name: "A" } } } }));
  assert.equal(await unlocked, true);
  controller.dispose();
  assert.equal(state.session.id, "chat-A");
});

test("saving invalidates an older refresh and explicit no-persona is sent unchanged", async () => {
  const { state, calls, controller, respond } = fixture();
  controller.refresh();
  const selected = controller.select(null);
  assert.equal(calls[0]!.init?.signal?.aborted, true);
  assert.deepEqual(JSON.parse(calls[1]!.init?.body as string), { personaId: null });
  respond(0, "STALE");
  await setImmediate();
  assert.equal(state.session.sessionPersona?.persona?.name, "A");
  calls[1]!.resolve(Response.json({ data: { persona: null } }));
  await selected;
  calls[2]!.resolve(Response.json({ data: { ...state.session, sessionPersona: { persona: null }, state: { metadata: { personaActive: false } } } }));
  await setImmediate();
  assert.equal(state.session.sessionPersona?.persona, null);
  controller.dispose();
});

test("a refresh interrupted by streaming retries once afterward and rejects the old reply", async () => {
  const { state, calls, controller, respond } = fixture();
  controller.refresh();
  state.isStreaming = true;
  controller.setBlocked(true);
  respond(0, "STALE");
  await setImmediate();
  assert.equal(state.session.sessionPersona?.persona?.name, "A");
  state.isStreaming = false;
  controller.setBlocked(false);
  respond(1, "B");
  await setImmediate();
  assert.equal(state.session.sessionPersona?.persona?.name, "B");
  assert.equal(calls.length, 2);
  controller.dispose();
});

test("failed saves retain the session choice and can be retried", async () => {
  const { state, calls, controller, errors, respond } = fixture();
  const failed = controller.select("B");
  calls[0]!.resolve(new Response(null, { status: 500 }));
  assert.equal(await failed, false);
  assert.equal(calls.length, 1);
  assert.equal(state.session.sessionPersona?.persona?.name, "A");
  assert.ok(errors.at(-1) instanceof Error);
  const retry = controller.select("B");
  respond(1);
  assert.equal(await retry, true);
  respond(2);
  await setImmediate();
  assert.equal(errors.at(-1), null);
  controller.dispose();
});

test("navigation cancels pending selection and never refreshes the next session", async () => {
  const { state, calls, controller } = fixture();
  const selected = controller.select("B");
  controller.dispose();
  state.session = { ...state.session, id: "chat-C" };
  calls[0]!.resolve(Response.json({ data: { persona: { id: "B", name: "B" } } }));
  assert.equal(await selected, false);
  assert.equal(calls[0]!.init?.signal?.aborted, true);
  assert.equal(calls.length, 1);
  assert.equal(state.session.id, "chat-C");
});
