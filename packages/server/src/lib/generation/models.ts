/**
 * Open-source edition stub. Custom generation models (LoRAs and checkpoints
 * pulled from Civitai into hosted storage) are a hosted feature. The one
 * helper core code shares with it, the storage meter behind plan quotas,
 * reports nothing used: the local build keeps assets on disk with no quota.
 */
export async function getUserStorageUsed(_userId: string): Promise<number> {
  return 0;
}

export function inferModelKind(sizeBytes: number): "lora" | "checkpoint" {
  return sizeBytes > 1_500_000_000 ? "checkpoint" : "lora";
}

export function workerModelFilename(modelId: string): string {
  return modelId;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function listModelsFor(_userId: string): Promise<any[]> {
  return [];
}
