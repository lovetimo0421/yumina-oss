import { create } from "zustand";
import type { PersonaEntry } from "@yumina/shared";

const apiBase = import.meta.env?.VITE_API_URL || "";
let personaRevision = 0;
const bindingVersions = new Map<string, number>();

export interface Persona {
  id: string;
  userId: string;
  name: string;
  avatarUrl: string | null;
  appearance: string | null;
  personality: string | null;
  backstory: string | null;
  entries?: PersonaEntry[];
  /** Private, user-only label — never sent to the AI. */
  note: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface PersonaInput {
  name: string;
  avatarUrl?: string | null;
  appearance?: string | null;
  personality?: string | null;
  backstory?: string | null;
  entries?: PersonaEntry[];
  note?: string | null;
}

interface PersonasState {
  personas: Persona[];
  loading: boolean;
  savingSelection: boolean;
  lastFetchedAt: number | null;
  /** worldId → pinned personaId (null = follow global). Missing key = not fetched yet. */
  worldBindings: Record<string, string | null>;
  savingWorldBindings: Record<string, boolean>;
  worldBindingErrors: Record<string, boolean>;

  fetchPersonas: (invalidate?: boolean) => Promise<void>;
  createPersona: (input: PersonaInput) => Promise<Persona | null>;
  updatePersona: (id: string, input: Partial<PersonaInput>) => Promise<Persona | null>;
  deletePersona: (id: string) => Promise<boolean>;
  activatePersona: (id: string) => Promise<boolean>;
  deactivatePersonas: () => Promise<boolean>;
  fetchWorldBinding: (worldId: string) => Promise<void>;
  setWorldBinding: (worldId: string, personaId: string | null) => Promise<boolean>;
}

export const usePersonasStore = create<PersonasState>((set, get) => ({
  personas: [],
  loading: false,
  savingSelection: false,
  lastFetchedAt: null,
  worldBindings: {},
  savingWorldBindings: {},
  worldBindingErrors: {},

  fetchPersonas: async (invalidate = false) => {
    if (invalidate) personaRevision++;
    if (get().loading) return;
    const revision = personaRevision;
    set({ loading: true });
    try {
      const res = await fetch(`${apiBase}/api/personas`, {
        credentials: "include",
      });
      if (res.ok) {
        const { data } = await res.json();
        if (revision === personaRevision) set({ personas: data, lastFetchedAt: Date.now() });
      }
    } catch {
      // silent
    } finally {
      set({ loading: false });
      // A save completed while this GET was in flight. Fetch its committed state.
      if (revision !== personaRevision) void get().fetchPersonas();
    }
  },

  createPersona: async (input) => {
    try {
      const res = await fetch(`${apiBase}/api/personas`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(input),
      });
      if (res.ok) {
        const { data } = await res.json();
        personaRevision++;
        set((s) => ({ personas: [...s.personas, data] }));
        return data;
      }
      return null;
    } catch {
      return null;
    }
  },

  updatePersona: async (id, input) => {
    try {
      const res = await fetch(`${apiBase}/api/personas/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(input),
      });
      if (res.ok) {
        const { data } = await res.json();
        personaRevision++;
        set((s) => ({
          personas: s.personas.map((p) => (p.id === id ? data : p)),
        }));
        return data;
      }
      return null;
    } catch {
      return null;
    }
  },

  deletePersona: async (id) => {
    try {
      const res = await fetch(`${apiBase}/api/personas/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.ok) {
        personaRevision++;
        for (const [worldId, personaId] of Object.entries(get().worldBindings)) {
          if (personaId === id) bindingVersions.set(worldId, (bindingVersions.get(worldId) ?? 0) + 1);
        }
        set((s) => ({
          personas: s.personas.filter((p) => p.id !== id),
          worldBindings: Object.fromEntries(Object.entries(s.worldBindings).map(
            ([worldId, personaId]) => [worldId, personaId === id ? null : personaId],
          )),
        }));
        // Re-fetch to sync active state (server may auto-activate another)
        get().fetchPersonas();
        return true;
      }
      return false;
    } catch {
      return false;
    }
  },

  fetchWorldBinding: async (worldId) => {
    const version = bindingVersions.get(worldId) ?? 0;
    try {
      const res = await fetch(`${apiBase}/api/personas/binding/${worldId}`, {
        credentials: "include",
      });
      if (res.ok) {
        const { data } = await res.json();
        if (version === (bindingVersions.get(worldId) ?? 0) && !get().savingWorldBindings[worldId]) {
          set((s) => ({
            worldBindings: { ...s.worldBindings, [worldId]: data.personaId ?? null },
          }));
        }
      }
    } catch {
      // silent
    }
  },

  setWorldBinding: async (worldId, personaId) => {
    if (get().savingWorldBindings[worldId]) return false;
    bindingVersions.set(worldId, (bindingVersions.get(worldId) ?? 0) + 1);
    set((s) => ({
      savingWorldBindings: { ...s.savingWorldBindings, [worldId]: true },
      worldBindingErrors: { ...s.worldBindingErrors, [worldId]: false },
    }));
    try {
      const res = await fetch(`${apiBase}/api/personas/binding/${worldId}`, {
        method: personaId ? "PUT" : "DELETE",
        headers: personaId ? { "Content-Type": "application/json" } : undefined,
        credentials: "include",
        body: personaId ? JSON.stringify({ personaId }) : undefined,
      });
      if (!res.ok) throw new Error();
      set((s) => ({ worldBindings: { ...s.worldBindings, [worldId]: personaId } }));
      return true;
    } catch {
      set((s) => ({ worldBindingErrors: { ...s.worldBindingErrors, [worldId]: true } }));
      return false;
    } finally {
      set((s) => ({ savingWorldBindings: { ...s.savingWorldBindings, [worldId]: false } }));
    }
  },

  activatePersona: async (id) => {
    if (get().savingSelection) return false;
    set({ savingSelection: true });
    try {
      const res = await fetch(`${apiBase}/api/personas/${id}/activate`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        return false;
      }
      // Publish only committed choices; chat subscribers refresh from the server.
      personaRevision++;
      set((s) => ({ personas: s.personas.map((p) => ({ ...p, isActive: p.id === id })) }));
      return true;
    } catch {
      return false;
    } finally { set({ savingSelection: false }); }
  },

  deactivatePersonas: async () => {
    if (get().savingSelection) return false;
    set({ savingSelection: true });

    try {
      const res = await fetch(`${apiBase}/api/personas/deactivate`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        return false;
      }
      personaRevision++;
      set((s) => ({ personas: s.personas.map((p) => ({ ...p, isActive: false })) }));
      return true;
    } catch {
      return false;
    } finally { set({ savingSelection: false }); }
  },
}));
