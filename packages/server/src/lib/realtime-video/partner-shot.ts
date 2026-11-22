import type { FilmPartnerVideoModel } from "@yumina/shared";

// Partner video models run through the hosted Comfy Router, which the
// open-source edition does not ship. No partner model is ever available, so
// scene video falls back to the local path.
export function filmPartnerAvailable(_model: FilmPartnerVideoModel): boolean {
  return false;
}

export function filmPartnerShotUsd(_model: FilmPartnerVideoModel): number {
  return 0;
}

export async function renderPartnerShot(args: {
  model: FilmPartnerVideoModel;
  prompt: string;
  frame: Uint8Array | null;
  portraits: { name: string; url: string }[];
  deadlineAt: number;
}): Promise<{ bytes: ArrayBuffer; jobId: string; costUsd: number }> {
  throw new Error(`video model ${args.model} is not available`);
}
