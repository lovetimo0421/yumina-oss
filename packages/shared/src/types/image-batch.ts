/** A batch contains independent prompts, not variations of one prompt. */
export const MAX_IMAGE_BATCH_ITEMS = 30;

export type ImageBatchTarget =
  | { kind: "entry_portrait"; entryId: string }
  | { kind: "component_image"; key: string };

export interface ImageBatchProposalItem {
  id: string;
  label: string;
  prompt: string;
  target?: ImageBatchTarget;
  /** Resolved by the server. Existing pictures are skipped by default. */
  existingAssetId?: string;
}

export interface ImageBatchProposal {
  purpose?: string;
  model: string;
  modelReason?: string;
  aspectRatio: string;
  resolution?: string;
  items: ImageBatchProposalItem[];
}

export type ImageBatchItemStatus =
  | "pending" | "queued" | "running" | "awaiting_credits"
  | "succeeded" | "failed" | "skipped" | "binding_failed";

export interface ImageBatchItem extends ImageBatchProposalItem {
  status: ImageBatchItemStatus;
  attempt: number;
  jobId?: string;
  assetId?: string;
  costMushies: number;
  errorCode?: string;
}

export interface ImageBatchSnapshot {
  id: string;
  worldId: string;
  runId: string;
  toolCallId: string;
  status: "running" | "paused" | "completed" | "partial" | "failed";
  pauseReason?: string;
  purpose?: string;
  model: string;
  aspectRatio: string;
  resolution?: string;
  estimatedMushies: number;
  costMushies: number;
  items: ImageBatchItem[];
  createdAt: string;
  updatedAt: string;
}
