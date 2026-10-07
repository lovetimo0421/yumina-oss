import type { SessionData } from "@/stores/chat";
import { sameJson } from "./json-equality";

const identityKeys = ["personaActive", "personaName", "personaImage", "personaAppearance", "personaPersonality", "personaBackstory", "personaEntries"] as const;
type Identity = Pick<SessionData, "id" | "sessionPersona" | "personaLocked"> & { state: { metadata?: Record<string, unknown> } };
type Options = {
  sessionId: string; apiBase: string;
  getState: () => { session: SessionData | null; isStreaming: boolean };
  apply: (session: SessionData) => void;
  request?: typeof fetch;
};
function applyIdentity(options: Options, data: Identity, signal?: AbortSignal) {
  const current = options.getState();
  if (signal?.aborted || current.isStreaming || current.session?.id !== options.sessionId || data.id !== options.sessionId) return false;
  const metadata = { ...(current.session.state.metadata as Record<string, unknown> | undefined) };
  let state = current.session.state;
  // Foreground identity refreshes must retain equal state snapshots so they do
  // not invalidate pending checkpoint ACKs. Missing fields still clear old values.
  if (!identityKeys.every(key => sameJson(metadata[key], data.state.metadata?.[key]))) {
    for (const key of identityKeys) metadata[key] = data.state.metadata?.[key];
    state = { ...state, metadata };
  }
  options.apply({ ...current.session, sessionPersona: data.sessionPersona, personaLocked: data.personaLocked,
    state });
  return true;
}

/** Refresh only identity, preserving loaded history, gameplay, and audio. */
export async function refreshChatPersona(options: Options & { signal: AbortSignal }) {
  const response = await (options.request ?? fetch)(`${options.apiBase}/api/sessions/${options.sessionId}`, {
    credentials: "include", cache: "no-store", signal: options.signal,
  });
  if (!response.ok) throw new Error("Persona refresh failed");
  const { data } = await response.json() as { data: Identity };
  return applyIdentity(options, data, options.signal);
}

export type PersonaSelectionEvent = {
  session_id: string; persona_id: string | null; locked: boolean;
  phase: "intent" | "committed" | "applied" | "failed" | "unconfirmed";
  duration_ms: number;
};
export class PersonaSaveUnconfirmedError extends Error {}

/** Session-scoped requests survive closing the picker, but never navigation. */
export function createChatPersonaController(options: Options & {
  onSaving: (saving: boolean) => void;
  onError: (error: Error | null) => void;
  onEvent?: (event: PersonaSelectionEvent) => void;
  timeoutMs?: number;
}) {
  let disposed = false, dirty = false, blocked = false, saving = false, unconfirmed = false;
  let refreshing: AbortController | null = null;
  let selection: AbortController | null = null;
  let pending: { data: Identity; applied: () => void } | null = null;
  const request = options.request ?? fetch;
  function pauseRefresh() {
    if (refreshing) { dirty = true; refreshing.abort(); refreshing = null; }
  }
  function flush() {
    const current = options.getState();
    if (disposed || blocked || saving || current.isStreaming || current.session?.id !== options.sessionId) return;
    if (pending) {
      const receipt = pending;
      pending = null;
      if (applyIdentity(options, receipt.data)) receipt.applied();
    }
    if (!dirty || refreshing) return;
    dirty = false;
    const controller = new AbortController();
    refreshing = controller;
    const timer = setTimeout(() => {
      controller.abort();
      if (!disposed) { dirty = true; options.onError(unconfirmed ? new PersonaSaveUnconfirmedError("Persona save could not be confirmed") : new Error("Persona refresh timed out")); }
    }, options.timeoutMs ?? 15000);
    controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    void refreshChatPersona({ ...options, request, signal: controller.signal }).then((applied) => {
      if (!controller.signal.aborted && !disposed) {
        if (applied && !unconfirmed) options.onError(null);
        else if (!applied) dirty = true;
      }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && !disposed && !unconfirmed) options.onError(error instanceof Error ? error : new Error("Persona refresh failed"));
    }).finally(() => { clearTimeout(timer); if (refreshing === controller) refreshing = null; });
  }
  async function save(path: string, body: object, locked: boolean, personaId: string | null) {
    if (disposed || saving || blocked || options.getState().isStreaming || options.getState().session?.id !== options.sessionId) return false;
    saving = true;
    pending = null;
    pauseRefresh();
    dirty = false;
    unconfirmed = false;
    options.onSaving(true);
    options.onError(null);
    const started = Date.now();
    const emit = (phase: PersonaSelectionEvent["phase"]) => {
      try { options.onEvent?.({ session_id: options.sessionId, persona_id: personaId, locked, phase, duration_ms: Date.now() - started }); } catch { /* Telemetry never blocks a save. */ }
    };
    emit("intent");
    const controller = new AbortController();
    selection = controller;
    let rejected = false, conflict = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const data = await Promise.race([
        (async () => {
          const response = await request(`${options.apiBase}/api/sessions/${options.sessionId}/${path}`, {
            method: "PUT", credentials: "include", signal: controller.signal,
            headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, expectedVersion: options.getState().session?.sessionPersona?.selectionVersion ?? "" }),
          });
          if (!response.ok) { conflict = response.status === 409; rejected = response.status >= 400 && response.status < 500; throw new Error("Persona update failed"); }
          return (await response.json()).data as Identity;
        })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => {
          controller.abort(); reject(new PersonaSaveUnconfirmedError("Persona save could not be confirmed"));
        }, options.timeoutMs ?? 15000); }),
      ]);
      if (disposed || controller.signal.aborted || options.getState().session?.id !== options.sessionId) return false;
      emit("committed");
      if (data?.id === options.sessionId && data.state?.metadata && typeof data.personaLocked === "boolean" && data.sessionPersona) {
        if (applyIdentity(options, data)) emit("applied");
        else pending = { data, applied: () => emit("applied") };
      } else {
        // Compatibility during a rolling deploy with an older server.
        dirty = true;
      }
      return true;
    } catch (error) {
      if (!disposed && options.getState().session?.id === options.sessionId) {
        unconfirmed = !rejected || conflict;
        dirty = unconfirmed || conflict;
        emit(unconfirmed ? "unconfirmed" : "failed");
        options.onError(unconfirmed ? new PersonaSaveUnconfirmedError("Persona save could not be confirmed") : error instanceof Error ? error : new Error("Persona update failed"));
      }
      return false;
    } finally {
      clearTimeout(timer);
      selection = null;
      saving = false;
      if (!disposed) { options.onSaving(false); flush(); }
    }
  }
  return {
    refresh() { dirty = true; pauseRefresh(); flush(); },
    setBlocked(value: boolean) { blocked = value; if (value) pauseRefresh(); else flush(); },
    select(personaId: string | null) { return save("persona", { personaId }, true, personaId); },
    setLock(locked: boolean, personaId?: string | null) {
      return save("persona-lock", locked ? { locked: true, personaId: personaId ?? null } : { locked: false }, locked, personaId ?? null);
    },
    dispose() { disposed = true; pending = null; refreshing?.abort(); selection?.abort(); },
  };
}
