import test from "node:test";
import assert from "node:assert/strict";
import { canApplySessionStateConfirmation, reconcileSessionStateConfirmation } from "./session-state-confirmation";

const snapshot = () => ({
  session: { id: "a", state: { metadata: { status: "playing" } } },
  gameState: { health: 100, name: "", inventory: [] as string[] },
});

test("a late partial PATCH acknowledgement cannot replace an SSE death snapshot", async () => {
  const before = snapshot();
  let current = before;
  let acknowledge!: () => void;
  const response = new Promise<void>((resolve) => { acknowledge = resolve; });
  const pending = response.then(() => {
    if (canApplySessionStateConfirmation("a", before, current)) current = before;
  });
  // The stream completes after the server built the PATCH response, but before
  // that response reaches the browser. SSE updates gameState independently.
  current = { ...before, gameState: { ...before.gameState, health: 0 } };
  acknowledge();
  await pending;
  assert.equal(current.gameState.health, 0);
});

test("an uncontended acknowledgement accepts all server-derived setup fields", () => {
  const before = snapshot();
  const confirmed = {
    variables: { health: 100, name: "Player", inventory: ["ration"] },
    metadata: { status: "initialized", bag: 3 },
  };
  let current: { session: { id: string; state: unknown }; gameState: Record<string, unknown> } = before;
  // Unrelated store updates such as streamed text do not invalidate state.
  current = { ...current, session: { ...current.session } };
  if (canApplySessionStateConfirmation("a", before, current)) {
    current = { session: { ...current.session, state: confirmed }, gameState: confirmed.variables };
  }
  assert.equal(current.gameState, confirmed.variables);
  assert.equal(current.session.state, confirmed);
});

test("a note edit survives an older SSE snapshot without reverting the death state", () => {
  const before = snapshot();
  const current = { ...before, gameState: { ...before.gameState, health: 0 } };
  const confirmed = { ...before.session.state, variables: { ...before.gameState, notes: "saved" } };
  const result = reconcileSessionStateConfirmation("a", before, current, { notes: "saved" }, confirmed);
  assert.deepEqual(result?.variables, { ...current.gameState, notes: "saved" });
  const newer = { ...current, gameState: { ...current.gameState, notes: "newer edit" } };
  assert.equal(reconcileSessionStateConfirmation("a", before, newer, { notes: "saved" }, confirmed), null);
});

test("a raced atomic setup acknowledgement never merges only part of its derived state", () => {
  const before = snapshot();
  const current = { ...before, gameState: { ...before.gameState, health: 0 } };
  const confirmed = {
    variables: { ...before.gameState, name: "Player", inventory: ["ration"] },
    metadata: { status: "initialized" },
  };
  assert.equal(reconcileSessionStateConfirmation("a", before, current, { name: "Player" }, confirmed), null);
  assert.equal(reconcileSessionStateConfirmation("a", before, before, { name: "Player" }, confirmed), confirmed);
});

test("metadata-only changes and concurrent local writes invalidate older confirmations", () => {
  const before = snapshot();
  assert.equal(canApplySessionStateConfirmation("a", before, {
    ...before, session: { ...before.session, state: { metadata: { status: "won" } } },
  }), false);
  assert.equal(canApplySessionStateConfirmation("a", before, {
    ...before, gameState: { ...before.gameState, name: "Newer name" },
  }), false);
});

test("a session switch or reload cannot accept the prior session acknowledgement", () => {
  const before = snapshot();
  assert.equal(canApplySessionStateConfirmation("a", before, {
    ...before, session: { ...before.session, id: "b" },
  }), false);
  assert.equal(canApplySessionStateConfirmation("a", before, { ...before, session: null }), false);
  assert.equal(canApplySessionStateConfirmation("a", before, snapshot()), false);
});

test("late marker ACK survives a newly appended turn without replacing its state", () => {
  const before = { ...snapshot(), messages: [{ id: "greeting" }] };
  const current = {
    ...before, messages: [...before.messages, { id: "user" }, { id: "assistant" }],
    gameState: { ...before.gameState, health: 0 },
  };
  const markers = [{ x: 20, y: 30, label: "Camp" }];
  const confirmed = { ...before.session.state, variables: { ...before.gameState, "map-markers": markers } };
  const result = reconcileSessionStateConfirmation("a", before, current, { "map-markers": markers }, confirmed);
  assert.equal(result?.variables.health, 0);
  assert.deepEqual(result?.variables["map-markers"], markers);
});

test("rewind or checkpoint restore cannot regain markers from an older ACK", () => {
  const before = { ...snapshot(), messages: [{ id: "greeting" }, { id: "turn" }] };
  const markers = [{ x: 20, y: 30, label: "Discarded future camp" }];
  const confirmed = { ...before.session.state, variables: { ...before.gameState, "map-markers": markers } };
  for (const messages of [before.messages.slice(0, 1), before.messages.map(message => ({ ...message }))]) {
    // The chat store updates gameState + messages on rewind, but leaves
    // session.state unchanged. Marker values may equal their request-start value.
    const current = { ...before, messages, gameState: { ...before.gameState, health: 90 } };
    assert.equal(reconcileSessionStateConfirmation("a", before, current, { "map-markers": markers }, confirmed), null);
  }
});
