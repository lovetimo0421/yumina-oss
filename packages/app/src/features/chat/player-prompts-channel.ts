import { useEffect, useMemo } from "react";
import type { PlayerPromptsChannelData } from "@/../sandbox/protocol";
import { ensurePromptPresetMeta, usePromptPresetEligibility } from "@/edition/slots.state";
import i18n from "@/lib/i18n";
import { familyLabel, familyOf } from "@/lib/model-families";
import { useUserPromptsStore } from "@/stores/user-prompts";

/**
 * Host side of the in-chat 「提示词」 surfaces (the sandbox quick panel and the
 * refusal bar). The sandbox iframe cannot call our API itself, so the host
 * pushes a small summary over the UI channel and runs the few writes for it.
 *
 * Since the 解除限制 rework, the summary is the per-model prompt binding: which
 * of the player's installed prompts auto-applies on the current model's family.
 *
 * Switches flipped here belong to the world being played (2026-11-04, a player
 * asked for writing-style prompts to stay on in one world and off in another);
 * a world never changed follows the account-wide switches from Settings.
 */
export function usePlayerPromptsChannel(active: boolean, modelId: string, worldId?: string | null): PlayerPromptsChannelData | null {
  // Eligibility now only decides whether we nudge the player toward 解除限制
  // presets (server hides them from ineligible accounts anyway). It is a hosted
  // concern, so it comes through the edition seam.
  const eligible = usePromptPresetEligibility();
  const prompts = useUserPromptsStore((s) => s.prompts);
  const folders = useUserPromptsStore((s) => s.folders);
  const promptsFetched = useUserPromptsStore((s) => s.fetched);
  const fetchPrompts = useUserPromptsStore((s) => s.fetchPrompts);
  const fetchWorldSwitches = useUserPromptsStore((s) => s.fetchWorldSwitches);
  const switches = useUserPromptsStore((s) => (worldId ? s.worldSwitches[worldId] : undefined));

  useEffect(() => {
    if (!active) return;
    ensurePromptPresetMeta();
  }, [active]);
  useEffect(() => {
    if (!active) return;
    void fetchPrompts();
  }, [active, fetchPrompts]);
  useEffect(() => {
    if (!active || !worldId) return;
    void fetchWorldSwitches(worldId);
  }, [active, worldId, fetchWorldSwitches]);

  return useMemo(() => {
    if (!active || !promptsFetched) return null;
    const family = familyOf(modelId);
    const folderNames = new Map(folders.map((f) => [f.id, f.name]));
    const on = (p: (typeof prompts)[number]) => switches?.[p.id] ?? p.enabled;
    const bound = prompts.find((p) => on(p) && (p.autoModels ?? []).includes(family));
    return {
      eligible,
      family,
      familyLabel: familyLabel(family, i18n.t("unrestrict:bindings.families.other")),
      boundPromptName: bound?.name ?? null,
      worldScoped: !!worldId,
      worldCustomized: !!switches && prompts.some((p) => p.id in switches),
      prompts: prompts.map((p) => ({
        id: p.id,
        name: p.name,
        enabled: on(p),
        section: p.section,
        group: p.folderId ? folderNames.get(p.folderId) ?? null : null,
        autoModels: p.autoModels ?? [],
      })),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, eligible, prompts, folders, promptsFetched, modelId, worldId, switches, i18n.language]);
}

/** Runs a sandbox → host call for these surfaces; undefined = not ours. */
export function handlePlayerPromptsBridgeCall(method: string, args: unknown[], worldId?: string | null): Promise<{ ok: boolean }> | undefined {
  if (method === "resetWorldPrompts") {
    if (!worldId) return Promise.resolve({ ok: false });
    return useUserPromptsStore.getState().resetWorldSwitches(worldId).then((ok) => ({ ok }));
  }
  if (method === "togglePlayerPrompt") {
    const [id, enabled] = args as [unknown, unknown];
    if (typeof id !== "string" || typeof enabled !== "boolean") return Promise.resolve({ ok: false });
    const store = useUserPromptsStore.getState();
    if (!store.prompts.some((p) => p.id === id)) return Promise.resolve({ ok: false });
    if (worldId) return store.setWorldSwitch(worldId, id, enabled).then((ok) => ({ ok }));
    return store.updatePrompt(id, { enabled }).then(() => ({
      ok: useUserPromptsStore.getState().prompts.find((p) => p.id === id)?.enabled === enabled,
    }));
  }
  return undefined;
}
