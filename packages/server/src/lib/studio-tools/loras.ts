// list_loras: the creator's LoRAs story illustrations can be drawn with, for
// the creation assistant to bind (write_entry imageLora, update_settings
// illustrationLora). Importing stays with the creator, in the editor.

import { listModelsFor } from "../generation/models.js";
import { comfyAssetId } from "../generation/comfy-library.js";
import { defaultTrigger, turnImageLorasEnabled } from "../per-turn-image/loras.js";

export async function listLorasResult(userId: string) {
  if (!turnImageLorasEnabled()) {
    return { available: false, note: "Story-illustration LoRAs aren't offered on this server; don't set imageLora or illustrationLora." };
  }
  const rows = (await listModelsFor(userId)).filter((m) => m.kind === "lora" && m.baseFamily === "anima" && !m.takedownReason);
  return {
    available: true,
    loras: rows.map((m) => ({
      modelId: m.id,
      name: m.name,
      status: m.status,
      trainedWords: (m.triggerWords ?? "").slice(0, 300),
      defaultTrigger: defaultTrigger(m.triggerWords),
      mine: m.userId === userId,
    })),
    ...(rows.length === 0 ? { note: "No Anima LoRAs yet: the creator imports one in a character's or the card's 插图 LoRA field (Civitai link or .safetensors)." } : {}),
  };
}
