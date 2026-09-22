import {
  MAX_IMAGE_BATCH_ITEMS, SMART_IMAGE_MODEL, SMART_IMAGE_MODEL_IDS,
  SMART_IMAGE_4K_COST_FACTOR, resolveSmartImageAspect, resolveSmartImageResolution,
  type ImageBatchProposal, type ImageBatchProposalItem, type ImageBatchTarget,
} from "@yumina/shared";

export const IMAGE_BATCH_TOOL_NAME = "generate_images";
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function normalizeTarget(value: unknown): ImageBatchTarget | null {
  if (!record(value)) return null;
  if (value.kind === "entry_portrait" && typeof value.entryId === "string"
    && value.entryId.trim() && value.entryId.length <= 200) {
    return { kind: "entry_portrait", entryId: value.entryId.trim() };
  }
  if (value.kind === "component_image" && typeof value.key === "string" && identifier.test(value.key)) {
    return { kind: "component_image", key: value.key };
  }
  return null;
}

/** Reject malformed or oversized batches instead of silently generating fewer
 * pictures than the creator was asked to approve. No client price is accepted. */
export function normalizeImageBatchProposal(value: unknown): ImageBatchProposal | null {
  if (!record(value) || !Array.isArray(value.items) || !value.items.length || value.items.length > MAX_IMAGE_BATCH_ITEMS) return null;
  const model = value.model === undefined ? SMART_IMAGE_MODEL : value.model;
  if (typeof model !== "string" || !(SMART_IMAGE_MODEL_IDS as readonly string[]).includes(model)) return null;
  const ids = new Set<string>();
  const targets = new Set<string>();
  const items: ImageBatchProposalItem[] = [];
  for (const item of value.items) {
    if (!record(item) || typeof item.id !== "string" || !identifier.test(item.id) || ids.has(item.id)) return null;
    if (typeof item.label !== "string" || !item.label.trim() || item.label.length > 120
      || typeof item.prompt !== "string" || !item.prompt.trim() || item.prompt.length > 2000) return null;
    const target = item.target === undefined ? undefined : normalizeTarget(item.target);
    if (target === null) return null;
    if (target) {
      const key = JSON.stringify(target);
      if (targets.has(key)) return null;
      targets.add(key);
    }
    ids.add(item.id);
    items.push({ id: item.id, label: item.label.trim(), prompt: item.prompt.trim(), ...(target ? { target } : {}) });
  }
  const resolution = resolveSmartImageResolution(model, typeof value.resolution === "string" ? value.resolution : undefined);
  return {
    model, items,
    aspectRatio: resolveSmartImageAspect(model, typeof value.aspectRatio === "string" ? value.aspectRatio : undefined),
    ...(resolution ? { resolution } : {}),
    ...(typeof value.purpose === "string" && value.purpose.trim() ? { purpose: value.purpose.trim().slice(0, 200) } : {}),
    ...(typeof value.modelReason === "string" && value.modelReason.trim() ? { modelReason: value.modelReason.trim().slice(0, 160) } : {}),
  };
}

/** Only prompts and generator settings may be edited on the confirmation card.
 * Binding targets and labels always come from the stored model proposal. */
export function editImageBatchProposal(original: ImageBatchProposal, value: unknown): ImageBatchProposal | null {
  if (!record(value) || !Array.isArray(value.items) || !value.items.length) return null;
  const byId = new Map(original.items.map(item => [item.id, item]));
  const selected = value.items.map(item => {
    if (!record(item) || typeof item.id !== "string") return null;
    const source = byId.get(item.id);
    if (!source || source.existingAssetId) return null;
    return { ...source, prompt: item.prompt === undefined ? source.prompt : item.prompt };
  });
  if (selected.some(item => item === null)) return null;
  return normalizeImageBatchProposal({ ...original, items: selected,
    model: value.model ?? original.model,
    aspectRatio: value.aspectRatio ?? original.aspectRatio,
    resolution: value.resolution ?? original.resolution,
  });
}

export function estimateImageBatch(proposal: ImageBatchProposal, estimates: Record<string, number>) {
  const base = estimates[proposal.model];
  if (base === undefined || !Number.isFinite(base) || base <= 0) throw new Error("IMAGE_ESTIMATE_UNAVAILABLE");
  const unitMushies = Math.ceil(base
    * (proposal.resolution === "4K" ? SMART_IMAGE_4K_COST_FACTOR : 1) * 10) / 10;
  return { unitMushies,
    estimatedMushies: Math.ceil(unitMushies * proposal.items.filter(item => !item.existingAssetId).length * 10) / 10 };
}

/** Server-owned proposal survives a disconnected confirmation and a later
 * conversation save. Its snapshot is fetched separately so progress is fresh. */
export function readPersistedImageBatchProposal(context: Record<string, unknown> | null, runStatus: string) {
  const raw = context?.imageBatchProposal;
  if (!record(raw) || typeof raw.runId !== "string" || typeof raw.toolCallId !== "string") return null;
  const proposal = normalizeImageBatchProposal(raw);
  if (!proposal || typeof raw.unitMushies !== "number" || !Number.isFinite(raw.unitMushies) || raw.unitMushies < 0
    || typeof raw.estimatedMushies !== "number" || !Number.isFinite(raw.estimatedMushies) || raw.estimatedMushies < 0) return null;
  const storedItems = raw.items as Record<string, unknown>[];
  return {
    ...proposal,
    items: proposal.items.map(item => {
      const original = storedItems.find(stored => stored.id === item.id);
      return { ...item, ...(typeof original?.existingAssetId === "string" && original.existingAssetId ? { existingAssetId: original.existingAssetId } : {}) };
    }),
    runId: raw.runId, toolCallId: raw.toolCallId,
    textContent: typeof raw.textContent === "string" ? raw.textContent : "",
    unitMushies: raw.unitMushies, estimatedMushies: raw.estimatedMushies,
    status: context?.imageBatchSubmitted === true ? "submitted" as const
      : runStatus === "awaiting_approval" && context?.imageBatchDeclined !== true ? "pending" as const : "declined" as const,
  };
}
