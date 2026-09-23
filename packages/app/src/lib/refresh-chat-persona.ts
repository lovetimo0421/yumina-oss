import type { SessionData } from "@/stores/chat";

const identityKeys = ["personaActive", "personaName", "personaImage", "personaAppearance", "personaPersonality", "personaBackstory", "personaEntries"] as const;

/** Refresh only identity, preserving loaded history, gameplay, and audio. */
export async function refreshChatPersona(options: {
  sessionId: string;
  signal: AbortSignal;
  apiBase: string;
  getState: () => { session: SessionData | null; isStreaming: boolean };
  apply: (session: SessionData) => void;
  request?: typeof fetch;
}) {
  const { sessionId, signal, apiBase, getState, apply, request = fetch } = options;
  const response = await request(`${apiBase}/api/sessions/${sessionId}`, {
    credentials: "include", cache: "no-store", signal,
  });
  if (!response.ok) throw new Error("Persona refresh failed");
  const { data } = await response.json() as { data: SessionData };
  const current = getState();
  if (signal.aborted || current.isStreaming || current.session?.id !== sessionId || data.id !== sessionId) return false;
  const metadata = { ...(current.session.state.metadata as Record<string, unknown> | undefined) };
  const received = data.state.metadata as Record<string, unknown> | undefined;
  for (const key of identityKeys) metadata[key] = received?.[key];
  apply({ ...current.session, sessionPersona: data.sessionPersona, personaLocked: data.personaLocked,
    state: { ...current.session.state, metadata } });
  return true;
}

/** Session-scoped requests survive closing the picker, but never navigation.
 * Streaming pauses only a requested refresh; finishing a normal turn does no work. */
export function createChatPersonaController(options: Omit<Parameters<typeof refreshChatPersona>[0], "signal"> & {
  onSaving: (saving: boolean) => void;
  onError: (error: Error | null) => void;
}) {
  let disposed = false;
  let dirty = false;
  let blocked = false;
  let saving = false;
  let refreshing: AbortController | null = null;
  let selection: AbortController | null = null;
  const request = options.request ?? fetch;

  function pauseRefresh() {
    if (refreshing) {
      dirty = true;
      refreshing.abort();
      refreshing = null;
    }
  }

  function flush() {
    const current = options.getState();
    if (disposed || !dirty || blocked || saving || refreshing || current.isStreaming || current.session?.id !== options.sessionId) return;
    dirty = false;
    const controller = new AbortController();
    refreshing = controller;
    void refreshChatPersona({ ...options, request, signal: controller.signal }).then((applied) => {
      if (!controller.signal.aborted && !disposed) {
        if (applied) options.onError(null);
        else dirty = true;
      }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && !disposed) options.onError(error instanceof Error ? error : new Error("Persona refresh failed"));
    }).finally(() => {
      if (refreshing === controller) refreshing = null;
    });
  }

  return {
    refresh() {
      dirty = true;
      pauseRefresh();
      flush();
    },
    setBlocked(value: boolean) {
      blocked = value;
      if (value) pauseRefresh();
      else flush();
    },
    async select(personaId: string | null) {
      if (disposed || saving || blocked || options.getState().isStreaming || options.getState().session?.id !== options.sessionId) return false;
      saving = true;
      pauseRefresh();
      options.onSaving(true);
      options.onError(null);
      const controller = new AbortController();
      selection = controller;
      try {
        const response = await request(`${options.apiBase}/api/sessions/${options.sessionId}/persona`, {
          method: "PUT", credentials: "include", signal: controller.signal,
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ personaId }),
        });
        if (!response.ok) throw new Error("Persona update failed");
        if (disposed || controller.signal.aborted) return false;
        // Read display metadata only after the write commits, never from an optimistic profile cache.
        dirty = true;
        return true;
      } catch (error) {
        dirty = false;
        if (!disposed && !controller.signal.aborted) options.onError(error instanceof Error ? error : new Error("Persona update failed"));
        return false;
      } finally {
        selection = null;
        saving = false;
        if (!disposed) {
          options.onSaving(false);
          flush();
        }
      }
    },
    async setLock(locked: boolean, personaId?: string | null) {
      if (disposed || saving || blocked || options.getState().isStreaming || options.getState().session?.id !== options.sessionId) return false;
      saving = true;
      pauseRefresh();
      options.onSaving(true);
      options.onError(null);
      const controller = new AbortController();
      selection = controller;
      try {
        const response = await request(`${options.apiBase}/api/sessions/${options.sessionId}/persona-lock`, {
          method: "PUT", credentials: "include", signal: controller.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(locked ? { locked: true, personaId: personaId ?? null } : { locked: false }),
        });
        if (!response.ok) throw new Error("Persona lock update failed");
        if (disposed || controller.signal.aborted) return false;
        dirty = true;
        return true;
      } catch (error) {
        dirty = false;
        if (!disposed && !controller.signal.aborted) options.onError(error instanceof Error ? error : new Error("Persona lock update failed"));
        return false;
      } finally {
        selection = null;
        saving = false;
        if (!disposed) {
          options.onSaving(false);
          flush();
        }
      }
    },
    dispose() {
      disposed = true;
      refreshing?.abort();
      selection?.abort();
    },
  };
}
