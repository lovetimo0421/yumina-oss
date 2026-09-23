import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionData } from "@/stores/chat";
import { refreshChatPersona } from "./refresh-chat-persona";

function fixture() {
  const session: SessionData = { id: "chat", worldId: "world", createdAt: "2026-09-13", updatedAt: "2026-09-13",
    state: { variables: { hp: 9 }, metadata: { activeAudio: "song", personaName: "Old" } },
    sessionPersona: { persona: { id: "old", name: "Old" } } };
  const state = { session, isStreaming: false, messages: [{ id: "loaded-old-page" }], hasEarlierMessages: true };
  const data = { ...session, messages: [], state: { variables: { hp: 1 }, metadata: { personaActive: true, personaName: "New", personaBackstory: "New story" } },
    sessionPersona: { persona: { id: "new", name: "New" } }, personaLocked: true };
  return { state, data };
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
