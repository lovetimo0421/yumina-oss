import type { ImageBatchProposalItem, ImageBatchSnapshot } from "@yumina/shared";
import type { StudioImageBatchProposal } from "./types";

export function defaultImageBatchSelection(items: ImageBatchProposalItem[]): Set<string> {
  return new Set(items.filter(item => !item.existingAssetId).map(item => item.id));
}

export function selectedImageBatchItems(items: ImageBatchProposalItem[], selected: Set<string>, prompts: Record<string, string>) {
  return items.filter(item => selected.has(item.id) && !item.existingAssetId)
    .map(item => ({ id: item.id, prompt: (prompts[item.id] ?? item.prompt).trim() }));
}

export function imageBatchRetryIds(batch: ImageBatchSnapshot) {
  return batch.items.filter(item => item.status === "failed" || item.status === "binding_failed").map(item => item.id);
}

export function matchingImageBatch(proposal: StudioImageBatchProposal, worldId: string, snapshots: ImageBatchSnapshot[]) {
  return snapshots.find(batch => batch.worldId === worldId && batch.runId === proposal.runId && batch.toolCallId === proposal.toolCallId);
}

export function proposalWithImageBatch(proposal: StudioImageBatchProposal, batch: ImageBatchSnapshot): StudioImageBatchProposal {
  return { ...proposal, status: "submitted", batch };
}

export interface ImageBatchCardScope {
  owner: string | null;
  worldId: string;
  conversationId: string | null;
  runId: string;
  toolCallId: string;
}

export function sameImageBatchCardScope(a: ImageBatchCardScope, b: ImageBatchCardScope) {
  return !!a.owner && a.owner === b.owner && a.worldId === b.worldId
    && a.conversationId === b.conversationId && a.runId === b.runId && a.toolCallId === b.toolCallId;
}
