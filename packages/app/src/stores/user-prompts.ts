import { create } from "zustand";
import { feedback } from "@/lib/feedback";
import i18n from "@/lib/i18n";

/**
 * R7 throughout this store: a prompt write fails behind a list that has already
 * re-rendered, so there is no field to anchor to. Copy comes from `profile`,
 * the namespace the only consumer (features/configs/global-prompts.tsx) loads.
 */
const tr = i18n.t as (key: string, options?: Record<string, unknown>) => string;

export interface UserPromptItem {
  id: string;
  userId: string;
  folderId: string | null;
  name: string;
  content: string;
  section: "system-presets" | "chat-history" | "post-history";
  enabled: boolean;
  depth?: number | null;
  position?: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface PromptFolder {
  id: string;
  userId: string;
  name: string;
  enabled: boolean;
  createdAt: string;
}

interface UserPromptsState {
  prompts: UserPromptItem[];
  folders: PromptFolder[];
  loading: boolean;
  fetched: boolean;

  fetchPrompts: () => Promise<void>;
  createPrompt: (data: { name: string; content?: string; section?: string; depth?: number; position?: number | null; folderId?: string | null }) => Promise<void>;
  updatePrompt: (id: string, data: Record<string, unknown>) => Promise<void>;
  deletePrompt: (id: string) => Promise<void>;
  createFolder: (name: string) => Promise<void>;
  updateFolder: (id: string, data: { name?: string; enabled?: boolean }) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;
  importPrompts: (json: unknown) => Promise<void>;
}

const apiBase = import.meta.env.VITE_API_URL || "";

export const useUserPromptsStore = create<UserPromptsState>((set, get) => ({
  prompts: [],
  folders: [],
  loading: false,
  fetched: false,

  fetchPrompts: async () => {
    // Always revalidate against the server — prompts are edited from multiple
    // devices, and the old fetch-once cache kept a long-lived tab (mobile
    // browsers restore SPAs for days) showing another device's stale copy
    // forever. `fetched` only tells the UI it has SOMETHING to render;
    // revalidation replaces it silently.
    if (get().loading) return;
    set({ loading: true });
    try {
      const res = await fetch(`${apiBase}/api/user-prompts`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!res.ok) throw new Error("Failed to fetch prompts");
      const { data } = await res.json();
      set({ prompts: data.prompts, folders: data.folders, fetched: true });
    } catch {
      // silent — user may not be logged in yet
    } finally {
      set({ loading: false });
    }
  },

  createPrompt: async (data) => {
    try {
      const res = await fetch(`${apiBase}/api/user-prompts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to create prompt");
      const { data: prompt } = await res.json();
      set((s) => ({ prompts: [...s.prompts, prompt] }));
    } catch (err) {
      console.error("[user-prompts] create failed", err);
      feedback.error(tr("profile:customPrompts.createFailed"));
    }
  },

  updatePrompt: async (id, data) => {
    try {
      // Content edits carry the updatedAt this device loaded, so the server
      // can refuse to clobber a newer edit made on ANOTHER device (the
      // cross-device "old version overwrote my new one" report). Deliberately
      // NOT sent for the quick enabled-toggle: two fast toggles on one device
      // would race each other into a false conflict.
      const isContentEdit = "name" in data || "content" in data;
      const expectedUpdatedAt = isContentEdit
        ? get().prompts.find((p) => p.id === id)?.updatedAt
        : undefined;
      const res = await fetch(`${apiBase}/api/user-prompts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(expectedUpdatedAt ? { ...data, expectedUpdatedAt } : data),
      });
      if (res.status === 409) {
        const { data: latest } = await res.json();
        set((s) => ({
          prompts: s.prompts.map((p) => (p.id === id ? latest : p)),
        }));
        // The editor's text just changed under the user's hands, so this one
        // genuinely has to speak — shortened to fit one line.
        feedback.error(tr("profile:customPrompts.editConflict"));
        return;
      }
      if (!res.ok) throw new Error("Failed to update prompt");
      const { data: updated } = await res.json();
      set((s) => ({
        prompts: s.prompts.map((p) => (p.id === id ? updated : p)),
      }));
    } catch (err) {
      console.error("[user-prompts] update failed", err);
      feedback.error(tr("profile:customPrompts.updateFailed"), {
        label: tr("common:action.retry"),
        onClick: () => void get().updatePrompt(id, data),
      });
    }
  },

  deletePrompt: async (id) => {
    try {
      const res = await fetch(`${apiBase}/api/user-prompts/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to delete prompt");
      set((s) => ({ prompts: s.prompts.filter((p) => p.id !== id) }));
    } catch (err) {
      console.error("[user-prompts] delete failed", err);
      feedback.error(tr("profile:customPrompts.deleteFailed"), {
        label: tr("common:action.retry"),
        onClick: () => void get().deletePrompt(id),
      });
    }
  },

  createFolder: async (name) => {
    try {
      const res = await fetch(`${apiBase}/api/user-prompts/folders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error("Failed to create folder");
      const { data: folder } = await res.json();
      set((s) => ({ folders: [...s.folders, folder] }));
    } catch (err) {
      console.error("[user-prompts] folder create failed", err);
      feedback.error(tr("profile:customPrompts.folderCreateFailed"));
    }
  },

  updateFolder: async (id, data) => {
    try {
      const res = await fetch(`${apiBase}/api/user-prompts/folders/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to update folder");
      const { data: updated } = await res.json();
      set((s) => ({
        folders: s.folders.map((f) => (f.id === id ? updated : f)),
      }));
    } catch (err) {
      console.error("[user-prompts] folder update failed", err);
      feedback.error(tr("profile:customPrompts.folderUpdateFailed"), {
        label: tr("common:action.retry"),
        onClick: () => void get().updateFolder(id, data),
      });
    }
  },

  deleteFolder: async (id) => {
    try {
      const res = await fetch(`${apiBase}/api/user-prompts/folders/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to delete folder");
      set((s) => ({
        folders: s.folders.filter((f) => f.id !== id),
        prompts: s.prompts.map((p) => (p.folderId === id ? { ...p, folderId: null } : p)),
      }));
    } catch (err) {
      console.error("[user-prompts] folder delete failed", err);
      feedback.error(tr("profile:customPrompts.folderDeleteFailed"), {
        label: tr("common:action.retry"),
        onClick: () => void get().deleteFolder(id),
      });
    }
  },

  importPrompts: async (json) => {
    try {
      const res = await fetch(`${apiBase}/api/user-prompts/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(json),
      });
      if (!res.ok) throw new Error("Failed to import prompts");
      const { data } = await res.json();
      // How much landed is the one thing the list cannot show — a count is worth
      // a neutral pill (T2).
      feedback.notice(
        tr("profile:customPrompts.imported", { prompts: data.imported, folders: data.folders }),
      );
      // Refetch to get the new data
      set({ fetched: false });
      get().fetchPrompts();
    } catch (err) {
      console.error("[user-prompts] import failed", err);
      feedback.error(tr("profile:customPrompts.importFailed"));
    }
  },
}));
