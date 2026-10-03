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
  /** "unrestrict" marks a 解除限制-type prompt (hidden entirely for accounts
   *  that aren't eligible for adult content). */
  kind?: "unrestrict" | null;
  /** Model families this prompt is bound to auto-apply on (e.g. ["gemini"]).
   *  null/empty = ordinary always-on prompt. Set via PUT .../bindings. */
  autoModels?: string[] | null;
  /** Provenance: the official preset's copy, or an installed prompt-hub pack. */
  sourceType?: "official" | "pack" | null;
  sourceId?: string | null;
  sourceVersion?: number | null;
  apiRole?: "system" | "user" | "assistant" | null;
  createdAt: string;
  updatedAt: string;
}

export interface PromptFolder {
  id: string;
  userId: string;
  name: string;
  enabled: boolean;
  /** Set when the folder holds an installed prompt-hub pack. */
  sourcePackId?: string | null;
  createdAt: string;
}

interface UserPromptsState {
  prompts: UserPromptItem[];
  folders: PromptFolder[];
  loading: boolean;
  fetched: boolean;

  fetchPrompts: () => Promise<void>;
  createPrompt: (data: { name: string; content?: string; section?: string; depth?: number; position?: number | null; folderId?: string | null; kind?: "unrestrict" | null; apiRole?: "system" | "user" | "assistant" | null; autoModels?: string[] | null }) => Promise<void>;
  /**
   * Save a prompt authored on the 创建提示词 page. One text can be split into
   * parts placed at different positions (最前 / 对话中 / 最后); a multi-part prompt
   * is grouped into a folder named after the title (mirrors how installing a pack
   * groups its rows). `autoModels` binds the created rows to model families so they
   * auto-apply on those models (empty/null = ordinary always-on). Returns true on
   * success. The map from position → section/depth/apiRole matches pack install.
   */
  savePrompt: (input: {
    title: string;
    parts: { content: string; position: "first" | "after-char" | "chat" | "last"; depth?: number }[];
    autoModels: string[] | null;
  }) => Promise<boolean>;
  updatePrompt: (id: string, data: Record<string, unknown>) => Promise<void>;
  deletePrompt: (id: string) => Promise<void>;
  createFolder: (name: string) => Promise<void>;
  updateFolder: (id: string, data: { name?: string; enabled?: boolean }) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;
  importPrompts: (json: unknown) => Promise<void>;
  /** Bind a model family to exactly one prompt (or clear it with promptId=null).
   *  The server sets auto_models on the chosen prompt and removes the family from
   *  any other prompt, then returns the full list which replaces ours. */
  setBinding: (family: string, promptId: string | null) => Promise<void>;
}

const apiBase = import.meta.env?.VITE_API_URL || "";

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

  savePrompt: async ({ title, parts, autoModels }) => {
    const trimmed = title.trim();
    const total = parts.length;
    const entryName = (i: number) => {
      if (total <= 1) return trimmed.slice(0, 60);
      const suffix = ` · ${i + 1}`;
      return trimmed.slice(0, 60 - suffix.length) + suffix;
    };
    // position → section / ordering / role, mirroring the server's pack install
    // (mapPackEntriesToPrompts) so a saved prompt behaves like an installed one.
    const row = (i: number) => {
      const part = parts[i]!;
      const base = { name: entryName(i), content: part.content, autoModels };
      switch (part.position) {
        case "after-char":
          return { ...base, section: "system-presets", position: 9500 + i, depth: null, apiRole: null };
        case "chat":
          return { ...base, section: "chat-history", position: null, depth: part.depth ?? 4, apiRole: null };
        case "last":
          return { ...base, section: "post-history", position: 50000 + i, depth: null, apiRole: "user" as const };
        case "first":
        default:
          return { ...base, section: "system-presets", position: -50000 + i, depth: null, apiRole: null };
      }
    };
    try {
      if (total === 1) {
        const res = await fetch(`${apiBase}/api/user-prompts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ ...row(0), folderId: null }),
        });
        if (!res.ok) throw new Error("Failed to save prompt");
        const { data: prompt } = await res.json();
        set((s) => ({ prompts: [...s.prompts, prompt] }));
        return true;
      }
      // Multi-part: one folder named after the title holds every part. The import
      // endpoint creates the folder + rows in one call and maps section/position.
      const folderRef = "new";
      const res = await fetch(`${apiBase}/api/user-prompts/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          folders: [{ id: folderRef, name: trimmed.slice(0, 60), enabled: true }],
          prompts: parts.map((_, i) => ({ ...row(i), folderId: folderRef, enabled: true })),
        }),
      });
      if (!res.ok) throw new Error("Failed to save prompt");
      set({ fetched: false });
      await get().fetchPrompts();
      return true;
    } catch (err) {
      console.error("[user-prompts] save failed", err);
      feedback.error(tr("profile:customPrompts.createFailed"));
      return false;
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

  setBinding: async (family, promptId) => {
    try {
      const res = await fetch(`${apiBase}/api/user-prompts/bindings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ family, promptId }),
      });
      if (!res.ok) throw new Error("Failed to set binding");
      const { data } = await res.json();
      // The endpoint returns the whole prompt list with refreshed auto_models,
      // since binding a family clears it from whatever held it before.
      if (data?.prompts) set({ prompts: data.prompts });
      else void get().fetchPrompts();
    } catch (err) {
      console.error("[user-prompts] set binding failed", err);
      feedback.error(tr("profile:customPrompts.updateFailed"), {
        label: tr("common:action.retry"),
        onClick: () => void get().setBinding(family, promptId),
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
