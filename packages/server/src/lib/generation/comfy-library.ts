/**
 * Open-source edition stub. The ComfyUI model library (creators' LoRAs
 * distributed to hosted GPU regions) is a hosted feature. Here no LoRA is
 * ever in a library, so per-turn illustration and the Studio tools draw
 * without custom models and the restore path reports nothing to restore.
 */
export const COMFY_LIBRARY_MAX_BYTES = 2 * 1024 ** 3;
export type LoraFamily = "anima" | "sdxl";

export function comfyLibraryEnabled(): boolean {
  return false;
}

export function workbenchLorasEnabled(): boolean {
  return false;
}

export function comfyLoraFamilies(): LoraFamily[] {
  return [];
}

export function loraFamilyRefusal(): "LORA_NOT_ANIMA" | "LORA_FAMILY_UNSUPPORTED" {
  return "LORA_FAMILY_UNSUPPORTED";
}

export function comfyAssetId(_regions: readonly string[] | null | undefined): string | null {
  return null;
}

export async function markLorasUsed(_modelIds: readonly string[]): Promise<void> {}

export async function ensureInLibrary(_model: unknown): Promise<string> {
  throw new Error("LORA_LIBRARY_UNAVAILABLE");
}
