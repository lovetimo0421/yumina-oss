import type { ImageBatchTarget } from '@yumina/shared';

export type ImageBatchBindingState = { ok: true; existingImage: string | null } | { ok: false; code: string; error: string };
export function getImageBatchBindingState(_schema: Record<string, unknown>, _target: ImageBatchTarget): ImageBatchBindingState {
  return { ok: false, code: 'GENERATION_UNAVAILABLE', error: 'Image generation is not available in this edition' };
}
