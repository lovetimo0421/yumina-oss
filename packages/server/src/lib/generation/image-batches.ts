import type { ImageBatchProposal, ImageBatchSnapshot } from '@yumina/shared';

// Hosted image generation is unavailable in the local edition. Keep the
// shared Studio routes importable without importing billing or job workers.
export const isImageBatchEnabled = (): boolean => false;
export class ImageBatchError extends Error {
  constructor(public code: string, public status: 400 | 402 | 404 | 409 | 429 = 400) { super(code); }
}
const unavailable = (): never => { throw new ImageBatchError('GENERATION_UNAVAILABLE', 409); };
export async function createImageBatch(_input: {
  userId: string; worldId: string; runId: string; toolCallId: string;
  folderId?: string | null; proposal: ImageBatchProposal;
}): Promise<ImageBatchSnapshot> { return unavailable(); }
export async function getImageBatch(_userId: string, _batchId: string): Promise<ImageBatchSnapshot> { return unavailable(); }
export async function listImageBatchesForRun(_userId: string, _runId: string): Promise<ImageBatchSnapshot[]> { return []; }
export async function retryImageBatch(_userId: string, _batchId: string, _itemIds?: string[], _requestId?: string): Promise<ImageBatchSnapshot> { return unavailable(); }
export async function resumeImageBatch(_userId: string, _batchId: string): Promise<ImageBatchSnapshot> { return unavailable(); }
