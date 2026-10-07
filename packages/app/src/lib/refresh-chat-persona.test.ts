import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionData } from "@/stores/chat";
import { refreshChatPersona } from "./refresh-chat-persona";
import { reconcileSessionStateConfirmation } from "./session-state-confirmation";

function fixture() {
  const gameState = { hp: 9 };
  const metadata: Record<string, unknown> = { activeAudio: "song", personaName: "Old" };
  const session: SessionData = { id: "chat", worldId: "world", createdAt: "2026-09-13", updatedAt: "2026-09-13",
    state: { variables: gameState, metadata },
    sessionPersona: { persona: { id: "old", name: "Old" } } };
  const state = { session, isStreaming: false, messages: [{ id: "loaded-old-page" }], hasEarlierMessages: true };
  const data = { ...session, messages: [], state: { variables: { hp: 1 }, metadata: { personaActive: true, personaName: "New", personaBackstory: "New story" } },
    sessionPersona: { persona: { id: "new", name: "New" } }, personaLocked: true };
  return { state, data, gameState, metadata };
}
test("refresh updates persona without dropping paginated history, gameplay or audio", async () => {
  const { state, data } = fixture();
  const messages = state.messages;
  await refreshChatPersona({ sessionId: "chat", signal: new AbortController().signal, apiBase: "",
    getState: () => state, apply: (session) => { state.session = session; },
    request: async () => Response.json({ data }),
  });
  assert.equal(state.session.sessionPersona?.persona?.name, "New");
  assert.equal(state.session.personaLocked, true);
  assert.deepEqual(state.session.state.variables, { hp: 9 });
  assert.equal((state.session.state.metadata as Record<string, unknown>).activeAudio, "song");
  assert.equal((state.session.state.metadata as Record<string, unknown>).personaBackstory, "New story");
  assert.equal(state.messages, messages);
  assert.equal(state.hasEarlierMessages, true);
});
for (const reason of ["navigation", "streaming", "aborted", "wrong response"] as const) {
  test(`late identity refresh is discarded after ${reason}`, async () => {
    const { state, data } = fixture();
    const controller = new AbortController();
    let applied = false;
    await refreshChatPersona({ sessionId: "chat", signal: controller.signal, apiBase: "",
      getState: () => state, apply: () => { applied = true; },
      request: async () => {
        if (reason === "navigation") state.session = { ...state.session, id: "other" };
        if (reason === "streaming") state.isStreaming = true;
        if (reason === "aborted") controller.abort();
        if (reason === "wrong response") data.id = "other";
        return Response.json({ data });
      },
    });
    assert.equal(applied, false);
  });
}
test("failed refresh preserves identity and lets the dialog show an error", async () => {
  const { state } = fixture();
  await assert.rejects(refreshChatPersona({ sessionId: "chat", signal: new AbortController().signal,
    apiBase: "", getState: () => state, apply: () => assert.fail("must not apply a failure"),
    request: async () => new Response(null, { status: 500 }),
  }), /Persona refresh failed/);
  assert.equal(state.session.sessionPersona?.persona?.name, "Old");
});

test("identity refresh replaces custom entries and clears them when the persona is disabled", async () => {
  const { state, data } = fixture();
  const oldEntries = [{ title: "Weapons", content: "Old sword" }];
  const newEntries = [{ title: "Abilities", content: "Fire" }];
  (state.session.state.metadata as Record<string, unknown>).personaEntries = oldEntries;
  for (const [personaActive, personaEntries] of [[true, newEntries], [false, []]] as const) {
    const received = { ...data, state: { ...data.state, metadata: { ...data.state.metadata, personaActive, personaEntries } } };
    await refreshChatPersona({ sessionId: "chat", signal: new AbortController().signal, apiBase: "",
      getState: () => state, apply: session => { state.session = session; }, request: async () => Response.json({ data: received }),
    });
    assert.deepEqual((state.session.state.metadata as Record<string, unknown>).personaEntries, personaEntries);
    assert.deepEqual(state.session.state.variables, { hp: 9 });
    assert.equal((state.session.state.metadata as Record<string, unknown>).activeAudio, "song");
  }
});

test("unchanged JSON persona refresh accepts a pending checkpoint ACK while updating identity receipts", async () => {
  const { state, gameState } = fixture();
  const metadata = { activeAudio: "song", personaName: "Old", personaAppearance: "",
    personaBackstory: undefined, personaEntries: [{ title: "Weapons", content: "Sword", details: { weight: 1, equipped: true } }] };
  state.session = { ...state.session, state: { ...state.session.state, metadata } };
  const before = { session: state.session, gameState, messages: state.messages };
  const requested = { checkpoint: { rev: 2 } };
  const confirmed = { ...before.session.state, variables: { ...before.gameState, ...requested } };
  let acknowledge!: () => void;
  const pending = new Promise<void>(resolve => { acknowledge = resolve; }).then(() =>
    reconcileSessionStateConfirmation("chat", before, { ...before, session: state.session }, requested, confirmed));
  const data = { ...state.session, personaLocked: true,
    sessionPersona: { selectionVersion: "new-version", persona: { id: "old", name: "Old" } },
    state: { variables: { hp: 1 }, metadata: { personaEntries: [{ details: { equipped: true, weight: 1 }, content: "Sword", title: "Weapons" }],
      personaAppearance: "", personaName: "Old", activeAudio: "server song" } } };
  assert.equal(await refreshChatPersona({ sessionId: "chat", signal: new AbortController().signal, apiBase: "",
    getState: () => state, apply: session => { state.session = session; }, request: async () => Response.json({ data }),
  }), true);
  acknowledge();
  assert.equal(await pending, confirmed);
  assert.equal(state.session.state, before.session.state);
  assert.equal(state.session.state.metadata, metadata);
  assert.equal(state.session.sessionPersona?.selectionVersion, "new-version");
  assert.equal(state.session.personaLocked, true);
  assert.equal(state.messages, before.messages);
});

test("every changed persona metadata field remains authoritative and invalidates an old checkpoint ACK", async () => {
  const changes: Record<string, unknown> = { personaActive: true, personaName: "New", personaImage: "new.png",
    personaAppearance: "New look", personaPersonality: "New trait", personaBackstory: "New story",
    personaEntries: [{ title: "Weapons", content: "Bow" }] };
  for (const [key, value] of Object.entries(changes)) {
    const { state, gameState, metadata } = fixture();
    const before = { session: state.session, gameState, messages: state.messages };
    const requested = { checkpoint: { rev: 2 } };
    const confirmed = { ...before.session.state, variables: { ...before.gameState, ...requested } };
    const data = { ...state.session, state: { metadata: { ...metadata, [key]: value } } };
    await refreshChatPersona({ sessionId: "chat", signal: new AbortController().signal, apiBase: "",
      getState: () => state, apply: session => { state.session = session; }, request: async () => Response.json({ data }),
    });
    assert.notEqual(state.session.state, before.session.state, key);
    assert.deepEqual(state.session.state.metadata, { ...metadata, personaActive: undefined, personaName: "Old", personaImage: undefined,
      personaAppearance: undefined, personaPersonality: undefined, personaBackstory: undefined, personaEntries: undefined, [key]: value });
    assert.equal(state.session.state.variables, before.gameState);
    assert.equal(reconcileSessionStateConfirmation("chat", before, { ...before, session: state.session }, requested, confirmed), null, key);
  }
});

test("missing or undefined persona metadata still clears stale fields", async () => {
  for (const metadata of [undefined, {}, { personaName: undefined, personaEntries: undefined }]) {
    const { state, metadata: previousMetadata } = fixture();
    previousMetadata.personaEntries = [{ title: "Weapons", content: "Sword" }];
    const previous = state.session.state;
    const data = { ...state.session, state: { metadata } };
    await refreshChatPersona({ sessionId: "chat", signal: new AbortController().signal, apiBase: "",
      getState: () => state, apply: session => { state.session = session; }, request: async () => Response.json({ data }),
    });
    assert.notEqual(state.session.state, previous);
    assert.deepEqual(state.session.state.metadata, { activeAudio: "song", personaActive: undefined, personaName: undefined, personaImage: undefined,
      personaAppearance: undefined, personaPersonality: undefined, personaBackstory: undefined, personaEntries: undefined });
  }
});

test("identity-only refresh with absent persona metadata preserves an empty state's reference", async () => {
  const { state } = fixture();
  state.session = { ...state.session, state: { variables: { hp: 9 }, metadata: {} } };
  const previous = state.session.state;
  const data = { ...state.session, personaLocked: true, state: {} };
  await refreshChatPersona({ sessionId: "chat", signal: new AbortController().signal, apiBase: "",
    getState: () => state, apply: session => { state.session = session; }, request: async () => Response.json({ data }),
  });
  assert.equal(state.session.state, previous);
  assert.deepEqual(state.session.state.metadata, {});
  assert.equal(state.session.personaLocked, true);
});
