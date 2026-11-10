import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { after, beforeEach } from "node:test";
import { createServer } from "vite";
import type { Message, SessionData } from "./chat";

const memory = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => void memory.set(key, String(value)),
  removeItem: (key) => void memory.delete(key), clear: () => memory.clear(), key: () => null, length: 0,
};
const vite = await createServer({ root: fileURLToPath(new URL("../..", import.meta.url)),
  appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
const { useChatStore } = await vite.ssrLoadModule("/src/stores/chat.ts") as typeof import("./chat");
const originalFetch = globalThis.fetch;
after(async () => { globalThis.fetch = originalFetch; await vite.close(); });
const snapshot = (turn: number) => ({ worldId: "world", variables: {}, turnCount: turn,
  activeGreetingId: `opening-${turn}`, metadata: { activeLoreSlots: [`slot-${turn}`] },
  ruleState: { toggledWorldbooks: { dungeon: turn > 0 }, toggledEntries: { secret: turn > 0 } } });
const session = (state = snapshot(0)): SessionData => ({ id: "play", worldId: "world", createdAt: "", updatedAt: "", state });
const reply = (data: unknown) => { globalThis.fetch = async () => Response.json({ data }); };
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
beforeEach(() => {
  useChatStore.setState({ session: session(), gameState: {}, messages: [], isStreaming: false, readOnly: false,
    runtimeRecords: [], runtimeRecordingSessionId: "play", error: null, lastSendFailure: null });
});

test("awaited actions follow earlier PATCHes and preserve newer optimistic writes", async () => {
  const calls: string[] = [];
  let release!: (value: Response) => void;
  let started!: () => void;
  const inFlight = new Promise<void>(resolve => { started = resolve; });
  let lastPatch: any;
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith("/state")) {
      calls.push("patch"); lastPatch = JSON.parse(String(options?.body)).state.variables;
      return Response.json({});
    }
    calls.push("action"); started();
    return new Promise<Response>(resolve => { release = resolve; });
  };
  useChatStore.getState().setVariableDirectly("setup", "confirmed");
  const pending = useChatStore.getState().executeActionAndWait("phase-entry");
  await inFlight;
  assert.deepEqual(calls, ["patch", "action"]);
  useChatStore.getState().setVariableDirectly("later", "keep");
  release(Response.json({ data: { state: { ...snapshot(1), variables: { setup: "confirmed", objective: "inspect" } },
    variables: { setup: "confirmed", objective: "inspect" }, firedIds: ["reaction"] } }));
  assert.deepEqual(await pending, { applied: true, variables: { setup: "confirmed", objective: "inspect" }, firedIds: ["reaction"] });
  assert.deepEqual(useChatStore.getState().gameState, { setup: "confirmed", objective: "inspect", later: "keep" });
  assert.deepEqual(useChatStore.getState().runtimeRecords.at(-1)?.firedIds, ["reaction"]);
  await settleLong();
  assert.deepEqual(lastPatch, { setup: "confirmed", objective: "inspect", later: "keep" });
});

async function actionCoalescingBoundary(delayedPrior: boolean) {
  const calls: string[] = [];
  const patches: Record<string, unknown>[] = [];
  let serverVariables: Record<string, unknown> = { earlier: 0, objective: "initial" };
  let releasePrior!: () => void;
  const gate = new Promise<void>(resolve => { releasePrior = resolve; });
  let startedPrior!: () => void;
  const inFlight = new Promise<void>(resolve => { startedPrior = resolve; });
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(String(options?.body));
    if (String(url).endsWith("/state")) {
      calls.push("patch"); patches.push(body.state.variables);
      serverVariables = { ...serverVariables, ...body.state.variables };
      return Response.json({});
    }
    if (body.actionId === "prior") {
      calls.push("prior"); startedPrior(); await gate;
      serverVariables = { ...serverVariables, earlier: 7 };
    } else {
      calls.push("action"); serverVariables = { ...serverVariables, objective: "from-action", earlier: 8 };
    }
    return Response.json({ data: { state: { ...snapshot(1), variables: serverVariables }, variables: serverVariables, firedIds: [body.actionId] } });
  };
  useChatStore.getState().setGameState({ earlier: 0, objective: "initial" });
  const prior = delayedPrior ? useChatStore.getState().executeActionAndWait("prior") : undefined;
  if (prior) await inFlight;
  useChatStore.getState().setVariableDirectly("setup", "ready");
  const action = useChatStore.getState().executeActionAndWait("phase");
  useChatStore.getState().setVariableDirectly("objective", "later-write");
  if (prior) { releasePrior(); await prior; }
  const result = await action;
  const { whenSessionStateSettled } = await vite.ssrLoadModule("/src/lib/session-state-queue.ts");
  await whenSessionStateSettled();
  assert.deepEqual(calls, delayedPrior ? ["prior", "patch", "action", "patch"] : ["patch", "action", "patch"]);
  assert.equal(result.variables.objective, "from-action");
  assert.equal(patches[0]!.earlier, delayedPrior ? 7 : 0, "PATCH reads confirmed earlier operation state at flush time");
  assert.deepEqual(serverVariables, { earlier: 8, objective: "later-write", setup: "ready" });
  assert.deepEqual(useChatStore.getState().gameState, serverVariables);
}

test("same-tick writes after action enqueue persist after its earlier scheduled PATCH", async () => {
  await actionCoalescingBoundary(false);
});

test("an earlier delayed action advances unrelated state before the pre-action PATCH reads it", async () => {
  await actionCoalescingBoundary(true);
});

test("awaited actions reject failures, unavailable views and stale results without logs", async () => {
  const run = () => useChatStore.getState().executeActionAndWait("entry");
  for (const id of ["", null, undefined, 123]) await assert.rejects(useChatStore.getState().executeActionAndWait(id as string), /action/i);
  useChatStore.setState({ readOnly: true }); await assert.rejects(run(), /unavailable|read.only/i);
  useChatStore.setState({ readOnly: false, session: null }); await assert.rejects(run(), /unavailable/i);
  useChatStore.setState({ session: session() });
  globalThis.fetch = async () => new Response("failed", { status: 500 }); await assert.rejects(run(), /failed/i);
  globalThis.fetch = async () => { throw new Error("offline"); }; await assert.rejects(run(), /offline/i);
  let release!: (value: Response) => void;
  globalThis.fetch = () => new Promise<Response>(resolve => { release = resolve; });
  const pending = run(); await settle();
  useChatStore.setState({ session: { ...session(), id: "other" } });
  release(Response.json({ data: { state: snapshot(9), variables: {}, firedIds: ["entry"] } }));
  await assert.rejects(pending, /session|stale/i);
  assert.equal(useChatStore.getState().runtimeRecords.length, 0);
  assert.equal(useChatStore.getState().session?.state.turnCount, 0);
});

test("expired action rejects promptly and late success cannot apply state or evidence", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release!: (value: Response) => void;
  let started!: () => void;
  const inFlight = new Promise<void>(resolve => { started = resolve; });
  globalThis.fetch = () => { started(); return new Promise<Response>(resolve => { release = resolve; }); };
  const pending = useChatStore.getState().executeActionAndWait("entry");
  const rejected = assert.rejects(pending, /timed out/i);
  await inFlight; t.mock.timers.tick(30_000); await rejected;
  release(Response.json({ data: { state: snapshot(9), variables: { lost: true }, firedIds: ["entry"] } }));
  const { whenSessionStateSettled } = await vite.ssrLoadModule("/src/lib/session-state-queue.ts");
  await whenSessionStateSettled();
  assert.deepEqual(useChatStore.getState().gameState, {});
  assert.equal(useChatStore.getState().runtimeRecords.length, 0);
});

test("switching away and back cannot revive an old action confirmation", async () => {
  let release!: (value: Response) => void;
  globalThis.fetch = () => new Promise<Response>(resolve => { release = resolve; });
  const pending = useChatStore.getState().executeActionAndWait("entry"); await settle();
  useChatStore.getState().setSession({ ...session(), id: "other" });
  useChatStore.getState().setSession(session());
  release(Response.json({ data: { state: snapshot(9), variables: {}, firedIds: ["entry"] } }));
  await assert.rejects(pending, /session/i);
  assert.equal(useChatStore.getState().runtimeRecords.length, 0);
});

test("initial session loading retains a complete state even with no variables", async () => {
  reply({ ...session(snapshot(1)), messages: [] });
  await useChatStore.getState().loadSession("play");
  assert.deepEqual(useChatStore.getState().session?.state, snapshot(1));
  assert.deepEqual(useChatStore.getState().gameState, {});
});

test("toast-only SSE failures retain structured recovery evidence and reset on new sends and sessions", async () => {
  const { useConfigStore } = await vite.ssrLoadModule("/src/stores/config.ts");
  useConfigStore.setState({ mixMode: false, modelPool: [], selectedModel: "test-model" });
  const nonce = useChatStore.getState().sendFailureNonce;
  globalThis.fetch = async (_url, options) => options?.method === "POST"
    ? new Response(`event: error\ndata: ${JSON.stringify({ code: "NO_CREDITS", error: "Not enough credits", balance: 3 })}\n\n`, { headers: { "Content-Type": "text/event-stream" } })
    : Response.json({ data: [] });
  useChatStore.getState().sendMessage("hello", "test-model");
  await settle();
  assert.equal(useChatStore.getState().error, null);
  assert.deepEqual(useChatStore.getState().lastSendFailure, { sessionId: "play", code: "NO_CREDITS", balance: 3 });
  assert.equal(useChatStore.getState().sendFailureNonce, nonce + 1, "composer still receives its restore signal");
  assert.ok(useChatStore.getState().messages.every(m => !m.id.startsWith("__pending_")));
  globalThis.fetch = async () => new Response(`event: done\ndata: ${JSON.stringify({ content: "reply", messageId: "answer", state: snapshot(1) })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  useChatStore.getState().sendMessage("hello again", "test-model");
  assert.equal(useChatStore.getState().lastSendFailure, null);
  await settle();
  useChatStore.setState({ error: "old", lastSendFailure: { sessionId: "play", code: "NO_CREDITS" } });
  useChatStore.getState().setSession({ ...session(), id: "other" });
  assert.equal(useChatStore.getState().lastSendFailure, null);
  assert.equal(useChatStore.getState().error, null);
});

test("a dismissed playtest cannot publish a late session load into another active chat", async () => {
  let resolveResponse!: (value: Response) => void;
  let valid = true;
  globalThis.fetch = () => new Promise<Response>((resolve) => { resolveResponse = resolve; });
  const pending = useChatStore.getState().loadSession("dismissed-playtest", () => valid);
  valid = false;
  useChatStore.getState().setSession({ ...session(), id: "normal-chat" });
  resolveResponse(Response.json({ data: { ...session(snapshot(9)), id: "dismissed-playtest" } }));
  await pending;
  assert.equal(useChatStore.getState().session?.id, "normal-chat");
  assert.equal(useChatStore.getState().session?.state.turnCount, 0);
});

test("actual SSE completions for send, regeneration and continuation retain state and evidence", async () => {
  for (const [index, kind] of (["turn", "regenerate", "continue"] as const).entries()) {
    const payload = { state: snapshot(index + 1), content: "Returned text", messageId: "assistant", userMessageId: "user",
      firedIds: ["door"], stateChanges: [{ variableId: "hp", oldValue: 3, newValue: 2 }] };
    globalThis.fetch = async () => new Response(`event: done\ndata: ${JSON.stringify(payload)}\n\n`,
      { headers: { "Content-Type": "text/event-stream" } });
    const store = useChatStore.getState();
    if (kind === "turn") store.sendMessage("Open door", "test-model");
    else if (kind === "regenerate") store.regenerateMessage("assistant", "test-model");
    else store.continueLastMessage("test-model");
    await settle();
    assert.deepEqual(useChatStore.getState().session?.state, snapshot(index + 1));
    assert.deepEqual(useChatStore.getState().runtimeRecords.at(-1)?.firedIds, ["door"]);
    assert.deepEqual(useChatStore.getState().runtimeRecords.at(-1)?.changes, [{ variableId: "hp", oldValue: 3, newValue: 2 }]);
  }
  assert.deepEqual(useChatStore.getState().runtimeRecords.map((row) => row.kind), ["turn", "regenerate", "continue"]);
  useChatStore.getState().applyRuntimeResult("previous-play", { state: snapshot(99), firedIds: [] }, "turn");
  assert.equal(useChatStore.getState().session?.state.turnCount, 3);
  assert.equal(useChatStore.getState().runtimeRecords.length, 3);
});

test("both revert paths, restart and checkpoint restore replace the whole state", async () => {
  const store = useChatStore.getState();
  const restore = { worldId: "world", variables: {}, turnCount: 0, metadata: {} };
  for (const run of [() => store.revertLastExchange(), () => store.revertToMessage("m"),
    () => store.restartChat(), () => store.restoreCheckpoint("checkpoint")]) {
    useChatStore.setState({ session: session(snapshot(7)) });
    reply({ state: restore, messages: [] });
    await run();
    assert.deepEqual(useChatStore.getState().session?.state, restore);
    assert.equal(useChatStore.getState().runtimeRecords.at(-1)?.kind, "restore");
  }
});

test("both rewind actions replace paging metadata with the surviving bounded window", async () => {
  for (const action of ["revertLastExchange", "revertToMessage"] as const) {
    useChatStore.setState({ session: session(snapshot(7)), messages: [],
      messageTotal: 999, hasEarlierMessages: false, isLoadingEarlier: true });
    reply({ state: snapshot(3), messages: [{ id: "remaining", createdAt: "2026-01-01" }], messageTotal: 21 });
    if (action === "revertToMessage") await useChatStore.getState()[action]("remaining");
    else await useChatStore.getState()[action]();
    assert.equal(useChatStore.getState().messageTotal, 21);
    assert.equal(useChatStore.getState().hasEarlierMessages, true);
    assert.equal(useChatStore.getState().isLoadingEarlier, false);
    reply({ state: snapshot(0), messages: [], messageTotal: 0 });
    if (action === "revertToMessage") await useChatStore.getState()[action]("remaining");
    else await useChatStore.getState()[action]();
    assert.equal(useChatStore.getState().messageTotal, 0);
    assert.equal(useChatStore.getState().hasEarlierMessages, false);
  }
});

test("action results update non-variable gates and log fired IDs without synthesizing changes", async () => {
  reply({ state: snapshot(2), variables: {}, firedIds: ["开门 .phase entry"], changes: [], notifications: [] });
  useChatStore.getState().executeActionRule("开门 .phase entry");
  await settle();
  assert.deepEqual(useChatStore.getState().session?.state, snapshot(2));
  const row = useChatStore.getState().runtimeRecords.at(-1);
  assert.deepEqual(row?.firedIds, ["开门 .phase entry"]);
  assert.deepEqual(row?.changes, []);
  assert.equal(row?.actionId, "开门 .phase entry");
});

test("opening switches honor stateRestored and carry the top-level greeting plus gates", async () => {
  const greeting = { id: "greeting", sessionId: "play", role: "assistant", content: "a", createdAt: "",
    activeSwipeIndex: 0, swipes: [{ content: "a" }, { content: "b" }] } as Message;
  useChatStore.setState({ messages: [greeting] });
  reply({ content: "b", activeSwipeIndex: 1, state: snapshot(4), stateRestored: false });
  useChatStore.getState().switchGreeting(1);
  await settle();
  assert.equal(useChatStore.getState().session?.state.activeGreetingId, "opening-0");
  useChatStore.setState({ messages: [greeting] });
  reply({ content: "b", activeSwipeIndex: 1, state: snapshot(4), stateRestored: true });
  useChatStore.getState().switchGreeting(1);
  await settle();
  assert.deepEqual(useChatStore.getState().session?.state, snapshot(4));
});

// A pick-your-cast screen (SEVENTEEN 模拟器 and friends) writes a setup-scoped
// variable and switches the opening in the same tick. The fake server below
// handles each request the moment it is dispatched, like a real server seeing
// requests in arrival order: PATCH merges variables; the opening switch adopts
// the opening's snapshot but keeps setup-scoped variables from the stored state.
function castScreenServer() {
  const cast = ["S.Coups", "Jeonghan"];
  const server = { variables: { "selected-members": [] as unknown, affection: 0 } as Record<string, unknown> };
  const opening = { "selected-members": [], affection: 50 };
  globalThis.fetch = async (url, options) => {
    const body = options?.body ? JSON.parse(String(options.body)) : {};
    if (String(url).endsWith("/state")) {
      server.variables = { ...server.variables, ...body.state.variables };
      return Response.json({ data: {} });
    }
    server.variables = { ...opening, "selected-members": server.variables["selected-members"] };
    return Response.json({ data: { content: "b", activeSwipeIndex: 1, stateRestored: true,
      state: { ...snapshot(0), variables: { ...server.variables } } } });
  };
  const greeting = { id: "greeting", sessionId: "play", role: "assistant", content: "a", createdAt: "",
    activeSwipeIndex: 0, swipes: [{ content: "a" }, { content: "b" }] } as Message;
  useChatStore.setState({ messages: [greeting], gameState: { "selected-members": [], affection: 0 },
    session: session({ ...snapshot(0), variables: { "selected-members": [], affection: 0 } }) });
  return { cast, server };
}
const settleLong = async () => { for (let i = 0; i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

test("a setup variable written right before switchGreeting reaches the server before the switch", async () => {
  const { cast, server } = castScreenServer();
  useChatStore.getState().setVariableDirectly("selected-members", cast);
  useChatStore.getState().switchGreeting(1);
  await settleLong();
  assert.deepEqual(useChatStore.getState().gameState, { "selected-members": cast, affection: 50 });
  assert.deepEqual(useChatStore.getState().session?.state.variables, { "selected-members": cast, affection: 50 });
  assert.deepEqual(server.variables, { "selected-members": cast, affection: 50 });
});

test("a write issued while the opening switch is in flight survives the switch's restore", async () => {
  const { cast, server } = castScreenServer();
  useChatStore.getState().switchGreeting(1);
  useChatStore.getState().setVariableDirectly("selected-members", cast);
  await settleLong();
  assert.deepEqual(useChatStore.getState().gameState, { "selected-members": cast, affection: 50 });
  assert.deepEqual(server.variables, { "selected-members": cast, affection: 50 });
});

test("switchGreeting resolves only once the opening has been applied, so a card can await it", async () => {
  const { cast } = castScreenServer();
  const done = useChatStore.getState().switchGreeting(1);
  assert.ok(done instanceof Promise);
  await done;
  // The restore has landed by the time the promise settles, so a write made
  // after awaiting it is not thrown away by the opening's snapshot.
  assert.equal(useChatStore.getState().gameState.affection, 50);
  useChatStore.getState().setVariableDirectly("selected-members", cast);
  await settleLong();
  assert.deepEqual(useChatStore.getState().gameState, { "selected-members": cast, affection: 50 });
  // Nothing to switch still answers, immediately.
  await useChatStore.getState().switchGreeting(1);
});

test("late action responses cannot mutate another session or record its result", async () => {
  let resolveResponse!: (value: Response) => void;
  globalThis.fetch = () => new Promise<Response>((resolve) => { resolveResponse = resolve; });
  useChatStore.getState().executeActionRule("old-action");
  await settle();
  useChatStore.setState({ session: { ...session(), id: "new-play" } });
  resolveResponse(Response.json({ data: { state: snapshot(9), variables: {}, firedIds: ["old-action"] } }));
  await settle();
  assert.equal(useChatStore.getState().session?.state.turnCount, 0);
  assert.equal(useChatStore.getState().runtimeRecords.length, 0);
});

// Launch QA: an offline send sat in "generating" forever, and Chinese players
// saw the server's raw English ("No API key configured for this provider…").
test("offline sends stop at once with the text handed back; known server errors are localized", async () => {
  const { default: i18n } = await vite.ssrLoadModule("/src/lib/i18n.ts") as { default: typeof import("i18next").default };
  await i18n.changeLanguage("zh");
  await i18n.loadNamespaces("chat");
  const { useConfigStore } = await vite.ssrLoadModule("/src/stores/config.ts");
  useConfigStore.setState({ mixMode: false, modelPool: [], selectedModel: "test-model" });
  const realNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let online = false;
  Object.defineProperty(globalThis, "navigator", { configurable: true, get: () => ({ onLine: online, userAgent: "node" }) });
  let posts = 0;
  try {
    globalThis.fetch = async () => { posts++; return Response.json({ data: [] }); };
    const nonce = useChatStore.getState().sendFailureNonce;
    useChatStore.getState().sendMessage("你还在吗？", "test-model");
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await settle();
    const offline = useChatStore.getState();
    assert.equal(offline.isStreaming, false, "not stuck generating");
    assert.equal(posts, 0, "nothing was sent");
    assert.equal(offline.sendFailureNonce, nonce + 1, "the composer gets the text back");
    assert.deepEqual(offline.lastSendFailure, { sessionId: "play", code: "OFFLINE" });
    assert.match(offline.error ?? "", /网络断开/);
    assert.ok(offline.messages.every((m) => !m.id.startsWith("__pending_")));

    online = true;
    globalThis.fetch = async (_url, options) => options?.method === "POST"
      ? new Response(JSON.stringify({ error: "No API key configured for this provider. Add one in Settings.", code: "NO_API_KEY" }), { status: 400 })
      : Response.json({ data: [] });
    useChatStore.getState().sendMessage("再试一次", "test-model");
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await settle();
    const keyError = useChatStore.getState().error ?? "";
    assert.doesNotMatch(keyError, /No API key/);
    assert.match(keyError, /API 密钥/);
  } finally {
    if (realNavigator) Object.defineProperty(globalThis, "navigator", realNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
    await i18n.changeLanguage("en");
  }
});
