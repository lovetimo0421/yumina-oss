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
 */
export function usePlayerPromptsChannel(active: boolean, modelId: string): PlayerPromptsChannelData | null {
  // Eligibility now only decides whether we nudge the player toward 解除限制
  // presets (server hides them from ineligible accounts anyway). It is a hosted
  // concern, so it comes through the edition seam.
  const eligible = usePromptPresetEligibility();
  const prompts = useUserPromptsStore((s) => s.prompts);
  const folders = useUserPromptsStore((s) => s.folders);
  const promptsFetched = useUserPromptsStore((s) => s.fetched);
  const fetchPrompts = useUserPromptsStore((s) => s.fetchPrompts);

  useEffect(() => {
    if (!active) return;
    ensurePromptPresetMeta();
  }, [active]);
  useEffect(() => {
    if (!active) return;
    void fetchPrompts();
  }, [active, fetchPrompts]);

  return useMemo(() => {
    if (!active || !promptsFetched) return null;
    const family = familyOf(modelId);
    const folderNames = new Map(folders.map((f) => [f.id, f.name]));
    const bound = prompts.find((p) => p.enabled && (p.autoModels ?? []).includes(family));
    return {
      eligible,
      family,
      familyLabel: familyLabel(family, i18n.t("unrestrict:bindings.families.other")),
      boundPromptName: bound?.name ?? null,
      prompts: prompts.map((p) => ({
        id: p.id,
        name: p.name,
        enabled: p.enabled,
        section: p.section,
        group: p.folderId ? folderNames.get(p.folderId) ?? null : null,
        autoModels: p.autoModels ?? [],
      })),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, eligible, prompts, folders, promptsFetched, modelId, i18n.language]);
}

/** Runs a sandbox → host call for these surfaces; undefined = not ours. */
export function handlePlayerPromptsBridgeCall(method: string, args: unknown[]): Promise<{ ok: boolean }> | undefined {
  if (method === "togglePlayerPrompt") {
    const [id, enabled] = args as [unknown, unknown];
    if (typeof id !== "string" || typeof enabled !== "boolean") return Promise.resolve({ ok: false });
    const store = useUserPromptsStore.getState();
    if (!store.prompts.some((p) => p.id === id)) return Promise.resolve({ ok: false });
    return store.updatePrompt(id, { enabled }).then(() => ({
      ok: useUserPromptsStore.getState().prompts.find((p) => p.id === id)?.enabled === enabled,
    }));
  }
  return undefined;
}
