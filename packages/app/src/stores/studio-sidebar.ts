import { create } from "zustand";
import { persist } from "zustand/middleware";

export type SidebarSectionKey =
  | "variables"
  | "overridesOnly"
  | "worldSummary"
  | "componentSummary";

export type PreviewVariableValue = number | string | boolean | Record<string, unknown> | unknown[];

interface SectionVisibility {
  variables: boolean;
  overridesOnly: boolean;
  worldSummary: boolean;
  componentSummary: boolean;
}

interface StudioSidebarState {
  sectionVisibility: SectionVisibility;
  previewVariableOverridesByWorld: Record<
    string,
    Record<string, PreviewVariableValue>
  >;

  setSectionVisibility: (section: SidebarSectionKey, visible: boolean) => void;
  setPreviewVariableOverride: (
    worldKey: string,
    variableId: string,
    value: PreviewVariableValue
  ) => void;
  clearPreviewVariableOverride: (worldKey: string, variableId: string) => void;
  clearPreviewVariableOverrides: (worldKey: string) => void;
}

const DEFAULT_SECTION_VISIBILITY: SectionVisibility = {
  variables: true,
  overridesOnly: false,
  worldSummary: true,
  componentSummary: true,
};

export const useStudioSidebarStore = create<StudioSidebarState>()(
  persist(
    (set) => ({
      sectionVisibility: DEFAULT_SECTION_VISIBILITY,
      previewVariableOverridesByWorld: {},

      setSectionVisibility: (section, visible) =>
        set((state) => ({
          sectionVisibility: { ...state.sectionVisibility, [section]: visible },
        })),

      setPreviewVariableOverride: (worldKey, variableId, value) =>
        set((state) => {
          const next = {
            ...state.previewVariableOverridesByWorld,
            [worldKey]: {
              ...(state.previewVariableOverridesByWorld[worldKey] ?? {}),
              [variableId]: value,
            },
          };
          // Cap at 20 worlds to prevent unbounded localStorage growth
          const keys = Object.keys(next);
          if (keys.length > 20) {
            for (const k of keys.slice(0, keys.length - 20)) {
              delete next[k];
            }
          }
          return { previewVariableOverridesByWorld: next };
        }),

      clearPreviewVariableOverride: (worldKey, variableId) =>
        set((state) => {
          const worldOverrides =
            state.previewVariableOverridesByWorld[worldKey];
          if (!worldOverrides || !(variableId in worldOverrides)) {
            return state;
          }

          const remaining = { ...worldOverrides };
          delete remaining[variableId];
          const nextByWorld = { ...state.previewVariableOverridesByWorld };

          if (Object.keys(remaining).length === 0) {
            delete nextByWorld[worldKey];
          } else {
            nextByWorld[worldKey] = remaining;
          }

          return { previewVariableOverridesByWorld: nextByWorld };
        }),

      clearPreviewVariableOverrides: (worldKey) =>
        set((state) => {
          if (!state.previewVariableOverridesByWorld[worldKey]) {
            return state;
          }
          const nextByWorld = { ...state.previewVariableOverridesByWorld };
          delete nextByWorld[worldKey];
          return { previewVariableOverridesByWorld: nextByWorld };
        }),
    }),
    {
      name: "yumina-studio-sidebar",
      partialize: (state) => ({
        sectionVisibility: state.sectionVisibility,
        previewVariableOverridesByWorld: state.previewVariableOverridesByWorld,
      }),
    }
  )
);
