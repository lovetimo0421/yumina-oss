import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { act, createElement, type ComponentType, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { transform } from "sucrase";
import { create } from "zustand";
import type { SessionData } from "@/stores/chat";
import type { Persona } from "@/stores/personas";
import { createChatPersonaController } from "@/lib/refresh-chat-persona";
import { readPersonaProfile } from "@/lib/persona-profile";

// Exercise the actual manager's hooks and wiring while replacing only visual shells
// and external stores. This keeps the test offline and does not open a browser.
test("manager follows global changes until a session selection locks it, queues public edits, and finishes saves after closing", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const originalFetch = globalThis.fetch;
  const a = { id: "A", name: "Session A", backstory: "Before", isActive: true } as Persona;
  const b = { id: "B", name: "Profile B", backstory: "B", isActive: false } as Persona;
  const session: SessionData = { id: "chat", worldId: "world", createdAt: "", updatedAt: "",
    state: { variables: { hp: 9 }, metadata: { activeAudio: "song", personaName: a.name } },
    sessionPersona: { persona: { id: a.id, name: a.name } } };
  const chat = create(() => ({ session, isStreaming: false }));
  let fetches = 0;
  const personas = create(() => ({ personas: [a, b], fetchPersonas: async (invalidate?: boolean) => {
    assert.equal(invalidate, true, "tab return invalidates any older profile list request");
    fetches++;
    personas.setState({ personas: [a, b].map((p) => ({ ...p, isActive: p.id === selected.id })) });
  } }));
  const calls: { url: string; init?: RequestInit }[] = [];
  let selected = a;
  let lockedPersona: Persona | null = null;
  let finishSave!: () => void;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (init?.method === "PUT") {
      assert.equal(String(url), "/api/sessions/chat/persona-lock");
      assert.deepEqual(JSON.parse(String(init.body)), { locked: true, personaId: "A" });
      return new Promise<Response>((resolve) => {
        finishSave = () => {
          lockedPersona = a;
          resolve(Response.json({ data: { personaLocked: true, sessionPersona: { persona: a } } }));
        };
      });
    }
    const resolved = lockedPersona ?? selected;
    return Response.json({ data: { ...session, personaLocked: lockedPersona !== null, sessionPersona: { persona: resolved },
      state: { variables: { hp: 1 }, metadata: { personaName: resolved.name, personaBackstory: resolved.backstory, personaEntries: resolved.entries ?? [] } } } });
  };
  const t = (key: string, values?: { name: string }) => values?.name ?? key;
  const shell = ({ children }: { children: ReactNode }) => createElement("div", null, children);
  const modules: Record<string, unknown> = {
    "react-i18next": { useTranslation: () => ({ t }) },
    "@/components/ui/dialog": { Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => open ? createElement("div", null, children) : null,
      DialogContent: shell, DialogTitle: shell },
    "@/features/personas/persona-carousel": { PersonaCarousel: ({ sessionSelection }: { sessionSelection: { personaId: string | null; onSelect: (id: string) => Promise<void> } }) =>
      createElement("button", { "data-persona": sessionSelection.personaId, onClick: () => void sessionSelection.onSelect("A") }, "Select A") },
    "@/features/personas/persona-edit-modal": { PersonaEditModal: () => null },
    "@/components/ui/field-error": { FieldError: () => null },
    "@/stores/chat": { useChatStore: chat },
    "@/stores/personas": { usePersonasStore: personas },
    "@/lib/refresh-chat-persona": { createChatPersonaController },
  };
  const require = createRequire(import.meta.url);
  const module = { exports: {} as { PersonaManagerDialog: ComponentType<{ open: boolean; onClose: () => void; sessionId: string }> } };
  const source = readFileSync(new URL("./persona-manager-dialog.tsx", import.meta.url), "utf8")
    .replaceAll("import.meta.env.VITE_API_URL", '""');
  new Function("require", "module", "exports", transform(source, { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic" }).code)(
    (id: string) => modules[id] ?? require(id), module, module.exports,
  );
  const root = createRoot(dom.window.document.getElementById("root")!);
  const render = (open: boolean) => root.render(createElement(module.exports.PersonaManagerDialog, { open, onClose() {}, sessionId: "chat" }));
  try {
    await act(async () => render(true));
    assert.equal(dom.window.document.querySelector("[data-persona]")?.getAttribute("data-persona"), "A");
    assert.equal(calls.length, 1, "opening refreshes identity once");
    await act(async () => { chat.setState({ isStreaming: true }); });
    await act(async () => { chat.setState({ isStreaming: false }); });
    assert.equal(calls.length, 1, "an ordinary completed turn does not refresh");
    await act(async () => render(false));
    await act(async () => {
      selected = { ...b, isActive: true };
      personas.setState({ personas: [{ ...a, isActive: false }, selected] });
    });
    assert.equal(chat.getState().session.sessionPersona?.persona?.id, "B", "a global selection refreshes an existing chat with its dialog closed");
    assert.equal(calls.length, 2);
    await act(async () => {
      personas.setState({ personas: [{ ...a, isActive: false }, { ...selected, note: "Private edit" }] });
    });
    assert.equal(calls.length, 2, "private notes are not prompt identity changes");
    await act(async () => { chat.setState({ isStreaming: true }); });
    await act(async () => {
      selected = { ...b, backstory: "Edited", isActive: true };
      personas.setState({ personas: [{ ...a, isActive: false }, selected] });
    });
    assert.equal(calls.length, 2, "editing during generation queues the refresh");
    await act(async () => { chat.setState({ isStreaming: false }); });
    assert.equal(calls.length, 3);
    assert.equal((chat.getState().session.state.metadata as Record<string, unknown>).personaBackstory, "Edited");
    const entries = [{ title: "Weapons", content: "Steel sword" }];
    await act(async () => {
      selected = { ...selected, entries };
      personas.setState({ personas: [{ ...a, isActive: false }, selected] });
    });
    assert.equal(calls.length, 4, "entry-only edits refresh the saved identity even with the manager closed");
    assert.deepEqual(readPersonaProfile("chat", chat.getState().session)?.entries, entries, "explicit sandbox re-import sees committed entry edits");
    assert.deepEqual((chat.getState().session.state.metadata as Record<string, unknown>).personaEntries, entries);
    await act(async () => render(true));
    await act(async () => { dom.window.document.querySelector("[data-persona]")!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    assert.equal(calls.at(-1)?.url, "/api/sessions/chat/persona-lock");
    await act(async () => render(false));
    await act(async () => finishSave());
    assert.equal(chat.getState().session.sessionPersona?.persona?.id, "A");
    assert.equal(chat.getState().session.personaLocked, true, "selecting in chat locks this session");
    assert.deepEqual((chat.getState().session.state.metadata as Record<string, unknown>).personaEntries, [], "switching to a persona with no entries clears previous entries");
    assert.equal(fetches, 0, "a session selection does not change or refetch the profile default");
    assert.equal(selected.id, "B", "saving the session leaves the server account default unchanged");
    assert.equal(personas.getState().personas.find((p) => p.isActive)?.id, "B");
    assert.deepEqual(chat.getState().session.state.variables, { hp: 9 });
    assert.equal((chat.getState().session.state.metadata as Record<string, unknown>).activeAudio, "song");
    assert.equal(calls.filter((call) => call.init?.method === "PUT").length, 1);
    assert.ok(calls.every((call) => call.url.startsWith("/api/sessions/chat")));
    Object.defineProperty(dom.window.document, "visibilityState", { configurable: true, value: "hidden" });
    const beforeHidden = calls.length;
    await act(async () => { dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")); });
    assert.equal(calls.length, beforeHidden, "hiding a tab does not refresh");
    assert.equal(fetches, 0);
    Object.defineProperty(dom.window.document, "visibilityState", { configurable: true, value: "visible" });
    selected = b;
    await act(async () => { dom.window.dispatchEvent(new dom.window.Event("focus")); });
    assert.equal(fetches, 1, "returning from another tab fetches the global choice");
    assert.equal(chat.getState().session.sessionPersona?.persona?.id, "A", "a locked session keeps its own choice on tab return");
    await act(async () => { chat.setState({ isStreaming: true }); });
    const beforeStreamFocus = calls.length;
    lockedPersona = { ...a, backstory: "Locked public edit" };
    await act(async () => { dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")); });
    assert.equal(fetches, 2);
    assert.equal(calls.length, beforeStreamFocus, "tab-return identity refresh is queued during generation");
    await act(async () => { chat.setState({ isStreaming: false }); });
    assert.equal(chat.getState().session.sessionPersona?.persona?.id, "A");
    assert.equal((chat.getState().session.state.metadata as Record<string, unknown>).personaBackstory, "Locked public edit");
    assert.equal(personas.getState().personas.find((p) => p.isActive)?.id, "B");
    const beforeEntryEdit = calls.length;
    await act(async () => {
      lockedPersona = { ...lockedPersona!, entries };
      personas.setState({ personas: [{ ...lockedPersona, isActive: false }, { ...b, isActive: true }] });
    });
    assert.equal(calls.length, beforeEntryEdit + 1, "locked personas also refresh entry-only edits");
    assert.deepEqual(readPersonaProfile("chat", chat.getState().session)?.entries, entries);
    const beforeUnmount = calls.length;
    await act(async () => root.unmount());
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.Event("focus"));
      dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
    });
    assert.equal(fetches, 2, "unmount removes both global listeners");
    assert.equal(calls.length, beforeUnmount);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
