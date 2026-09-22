import type { ImageBatchSnapshot } from "@yumina/shared";
import type { StudioImageBatchProposal } from "./types";

export const proposal: StudioImageBatchProposal = {
  runId: "run-one", toolCallId: "tool-one", model: "bytedance-seed/seedream-5-0-lite", aspectRatio: "3:4", resolution: "2K",
  unitMushies: 35, estimatedMushies: 70, status: "pending",
  items: [{ id: "red", label: "Red hair", prompt: "A girl with red hair" },
    { id: "blue", label: "Blue hair", prompt: "A girl with blue hair" },
    { id: "existing", label: "Existing portrait", prompt: "Do not replace", existingAssetId: "old-asset", target: { kind: "entry_portrait", entryId: "character" } }],
};

export function snapshot(status: ImageBatchSnapshot["status"] = "partial"): ImageBatchSnapshot {
  return { id: "batch-one", worldId: "world-one", runId: proposal.runId, toolCallId: proposal.toolCallId, model: proposal.model,
    aspectRatio: proposal.aspectRatio, resolution: proposal.resolution, status, costMushies: 35, estimatedMushies: 70,
    createdAt: "2026-09-22T00:00:00Z", updatedAt: "2026-09-22T00:01:00Z",
    items: [{ ...proposal.items[0]!, status: "succeeded", attempt: 1, costMushies: 35, assetId: "asset-red" },
      { ...proposal.items[1]!, status: "failed", attempt: 1, costMushies: 0 },
      { ...proposal.items[2]!, status: "skipped", attempt: 0, costMushies: 0 }] };
}

