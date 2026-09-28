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

test("a committed identity receipt applies immediately without a follow-up GET", async () => {
  const { state, calls, controller, saving } = fixture();
  const selected = controller.setLock(true, "B");
  calls[0]!.resolve(Response.json({ data: {
    id: "chat-A", personaLocked: true, sessionPersona: { persona: { id: "B", name: "A" } },
    state: { metadata: { personaActive: true, personaName: "A", personaImage: "", personaAppearance: "",
      personaPersonality: "", personaBackstory: "", personaEntries: [] } },
  } }));
  assert.equal(await selected, true);
  assert.equal(state.session.sessionPersona?.persona?.id, "B", "same-named personas use IDs");
  assert.equal(state.session.personaLocked, true);
  assert.equal(calls.length, 1, "the PUT is sufficient even if full session reads are unavailable");
  assert.deepEqual(state.session.state.variables, { hp: 9 });
  assert.equal((state.session.state.metadata as Record<string, unknown>).activeAudio, "song");
  assert.deepEqual(saving, [true, false]);
  controller.dispose();
});

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
  assert.deepEqual(JSON.parse(calls[0]!.init?.body as string), { personaId: "B", expectedVersion: "" });
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
  assert.deepEqual(JSON.parse(calls[0]!.init?.body as string), { locked: true, personaId: "B", expectedVersion: "" });
  calls[0]!.resolve(Response.json({ data: { personaLocked: true, sessionPersona: { persona: { id: "B", name: "B" } } } }));
  assert.equal(await locked, true);
  assert.equal(calls[1]!.url, "/api/sessions/chat-A");
  respond(1);
  await setImmediate();
  assert.deepEqual(saving, [true, false]);

  const unlocked = controller.setLock(false);
  assert.deepEqual(JSON.parse(calls[2]!.init?.body as string), { locked: false, expectedVersion: "" });
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
  assert.deepEqual(JSON.parse(calls[1]!.init?.body as string), { personaId: null, expectedVersion: "" });
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
  calls[0]!.resolve(new Response(null, { status: 400 }));
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

for (const locked of [true, false]) {
  test(`receipt ${locked ? "explicit none" : "unlock"} clears old identity while preserving state`, async () => {
    const { state, calls, controller } = fixture();
    const saving = controller.setLock(locked, null);
    calls[0]!.resolve(Response.json({ data: { id: "chat-A", personaLocked: locked, sessionPersona: { persona: null }, state: { metadata: {
      personaActive: false, personaName: "account", personaImage: "account.png", personaAppearance: "", personaPersonality: "", personaBackstory: "", personaEntries: [],
    } } } }));
    assert.equal(await saving, true);
    assert.equal(calls.length, 1);
    assert.equal(state.session.personaLocked, locked);
    assert.equal(state.session.sessionPersona?.persona, null);
    assert.deepEqual(state.session.state.metadata, { activeAudio: "song", personaActive: false, personaName: "account", personaImage: "account.png", personaAppearance: "", personaPersonality: "", personaBackstory: "", personaEntries: [] });
    controller.dispose();
  });
}

test("an in-flight commit waits for streaming to finish and cannot overwrite gameplay", async () => {
  const { state, calls, controller } = fixture();
  const first = controller.setLock(true, "B");
  assert.equal(await controller.setLock(true, "C"), false);
  state.isStreaming = true; controller.setBlocked(true);
  calls[0]!.resolve(Response.json({ data: { id: "chat-A", personaLocked: true, sessionPersona: { persona: { id: "B", name: "B" } }, state: { metadata: { personaActive: true, personaName: "B" } } } }));
  assert.equal(await first, true);
  assert.equal(state.session.sessionPersona?.persona?.id, "A");
  state.session.state.variables = { hp: 25 };
  state.isStreaming = false; controller.setBlocked(false);
  assert.equal(state.session.sessionPersona?.persona?.id, "B");
  assert.deepEqual(state.session.state.variables, { hp: 25 });
  assert.equal(calls.length, 1);
  controller.dispose();
});

test("timed-out writes reconcile without trusting late responses; telemetry excludes content", async () => {
  const state = { session: { id: "chat", worldId: "world", createdAt: "", updatedAt: "", state: { variables: {}, metadata: {} }, sessionPersona: { selectionVersion: "v1", persona: { id: "A", name: "private name" } } } as SessionData, isStreaming: false };
  const events: unknown[] = [], errors: (Error | null)[] = [], calls: string[] = [];
  let late!: (value: Response) => void;
  const controller = createChatPersonaController({ sessionId: "chat", apiBase: "", getState: () => state,
    apply: (session) => { state.session = session; }, onSaving() {}, onError: (error) => errors.push(error), timeoutMs: 5,
    onEvent: (event) => { events.push(event); throw new Error("analytics unavailable"); },
    request: async (url, init) => {
      calls.push(String(url));
      if (init?.method === "PUT") { assert.equal(JSON.parse(String(init.body)).expectedVersion, "v1"); return new Promise<Response>((resolve) => { late = resolve; }); }
      return Response.json({ data: { ...state.session, personaLocked: false } });
    },
  });
  assert.equal(await controller.setLock(true, "B"), false);
  await setImmediate();
  assert.equal(calls.length, 2);
  assert.equal(errors.at(-1)?.constructor.name, "PersonaSaveUnconfirmedError");
  late(Response.json({ data: { id: "chat", personaLocked: true, sessionPersona: { persona: { id: "B", name: "B" } }, state: { metadata: {} } } }));
  await setImmediate();
  assert.equal(state.session.sessionPersona?.persona?.id, "A");
  assert.deepEqual(events.map((e) => (e as { phase: string }).phase), ["intent", "unconfirmed"]);
  assert.ok(!JSON.stringify(events).includes("private name"));
  assert.deepEqual(Object.keys(events[0] as object).sort(), ["duration_ms", "locked", "persona_id", "phase", "session_id"]);
  controller.dispose();
});

test("refresh timeouts surface an error and remain explicitly retryable", async () => {
  const state = { session: { id: "chat", worldId: "world", createdAt: "", updatedAt: "", state: { variables: {}, metadata: {} } } as SessionData, isStreaming: false };
  const errors: (Error | null)[] = [];
  let count = 0;
  const controller = createChatPersonaController({ sessionId: "chat", apiBase: "", getState: () => state,
    apply: (session) => { state.session = session; }, onSaving() {}, onError: (error) => errors.push(error), timeoutMs: 5,
    request: async (_url, init) => {
      if (++count === 1) return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      return Response.json({ data: { ...state.session, sessionPersona: { persona: { id: "B", name: "B" } } } });
    },
  });
  controller.refresh();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(errors.at(-1)?.message ?? "", /timed out/);
  controller.refresh();
  await setImmediate();
  assert.equal(state.session.sessionPersona?.persona?.id, "B");
  controller.dispose();
});

test("a version conflict refreshes its token but keeps a visible retry message", async () => {
  const { state, calls, controller, errors, respond } = fixture();
  state.session.sessionPersona!.selectionVersion = "old";
  const pending = controller.setLock(true, "B");
  assert.equal(JSON.parse(String(calls[0]!.init?.body)).expectedVersion, "old");
  calls[0]!.resolve(new Response(null, { status: 409 }));
  assert.equal(await pending, false);
  calls[1]!.resolve(Response.json({ data: { ...state.session, sessionPersona: { selectionVersion: "new", persona: { id: "C", name: "C" } } } }));
  await setImmediate();
  assert.equal(state.session.sessionPersona?.selectionVersion, "new");
  assert.equal(errors.at(-1)?.constructor.name, "PersonaSaveUnconfirmedError");
  const retry = controller.setLock(true, "B");
  assert.equal(JSON.parse(String(calls[2]!.init?.body)).expectedVersion, "new");
  respond(2);
  assert.equal(await retry, true);
  controller.dispose();
});
