import type { ImagePostRecipe, ImagePostRecipeModel } from "@yumina/shared";

type Params = Record<string, unknown> | null | undefined;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Models a recipe names (LoRAs + checkpoint), for the usability lookup. */
export function recipeModelIds(params: Params): string[] {
  const adv = (params?.advanced ?? null) as Record<string, unknown> | null;
  const loras = Array.isArray(adv?.loras) ? adv!.loras as { modelId?: unknown }[] : [];
  const ids = loras.map((l) => l?.modelId).filter((id): id is string => typeof id === "string");
  if (typeof adv?.checkpointModelId === "string") ids.push(adv.checkpointModelId);
  return [...new Set(ids)];
}

/**
 * The public snapshot of a finished image job's settings. What the model
 * actually received (the enhanced prompt when there is one) is the prompt;
 * reference images, folders and denoise never leave the author's account,
 * and a model is kept only when `usable` (platform or public community model)
 * has it — anything else is counted in `omittedModels`.
 */
export function buildImagePostRecipe(
  templateId: string,
  params: Params,
  usable: ReadonlyMap<string, { name: string; kind: "lora" | "checkpoint" }>,
): ImagePostRecipe {
  // Made with a sealed 做法: a post of it carries nothing of how it was made (no words, model, size or settings).
  const sealed = typeof params?.sealedSkillId === "string";
  const p = sealed ? {} : params ?? {};
  const adv = (p.advanced ?? null) as Record<string, unknown> | null;
  const cloud = (p.cloud ?? null) as Record<string, unknown> | null;
  const models: ImagePostRecipeModel[] = [];
  let omitted = 0;

  const loras: { modelId: string; weight: number }[] = [];
  for (const l of Array.isArray(adv?.loras) ? adv!.loras as { modelId?: unknown; weight?: unknown }[] : []) {
    if (typeof l?.modelId !== "string") continue;
    const m = usable.get(l.modelId);
    if (!m) { omitted++; continue; }
    const weight = num(l.weight) ?? 1;
    loras.push({ modelId: l.modelId, weight });
    models.push({ id: l.modelId, name: m.name, kind: "lora", weight });
  }
  let checkpointModelId: string | null = null;
  if (typeof adv?.checkpointModelId === "string") {
    const m = usable.get(adv.checkpointModelId);
    if (m) {
      checkpointModelId = adv.checkpointModelId;
      models.push({ id: checkpointModelId, name: m.name, kind: "checkpoint" });
    } else omitted++;
  }

  return {
    templateId,
    prompt: str(p.enhancedPrompt) ?? str(p.prompt) ?? "",
    style: str(p.style),
    quality: str(p.quality),
    aspectId: str(p.aspectId),
    seed: num(p.seed) ?? num(adv?.seed) ?? num(cloud?.seed) ?? null,
    cloud: cloud ? {
      ...(str(cloud.model) ? { model: str(cloud.model)! } : {}),
      ...(str(cloud.aspectRatio) ? { aspectRatio: str(cloud.aspectRatio)! } : {}),
      ...(str(cloud.resolution) ? { resolution: str(cloud.resolution)! } : {}),
    } : null,
    advanced: adv ? {
      ...(num(adv.width) !== undefined ? { width: num(adv.width) } : {}),
      ...(num(adv.height) !== undefined ? { height: num(adv.height) } : {}),
      ...(num(adv.steps) !== undefined ? { steps: num(adv.steps) } : {}),
      ...(num(adv.cfg) !== undefined ? { cfg: num(adv.cfg) } : {}),
      ...(str(adv.sampler) ? { sampler: str(adv.sampler)! } : {}),
      ...(str(adv.negativePrompt) ? { negativePrompt: str(adv.negativePrompt)!.slice(0, 4000) } : {}),
      loras,
      checkpointModelId,
    } : null,
    models,
    omittedModels: omitted,
  };
}
