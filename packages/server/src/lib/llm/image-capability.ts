import { IMAGE_MODEL_CAPABILITIES } from "@yumina/shared";
import type { LLMProvider } from "./types.js";
import { ensureOpenRouterCatalog, getCatalogImageSupport } from "./model-catalog.js";

/** Custom endpoints are unknown, never guessed from their model names. They
 * receive intact image parts and report their own supported capabilities. */
export async function assertImageModel(resolved: { providerName: string; provider: LLMProvider }, model: string): Promise<void> {
  let supported: boolean | undefined;
  if (resolved.providerName === "openrouter") {
    await ensureOpenRouterCatalog();
    supported = getCatalogImageSupport(model);
  } else if (resolved.providerName !== "custom") {
    supported = ["google", "anthropic", "openai"].includes(resolved.providerName) ? IMAGE_MODEL_CAPABILITIES[model] : undefined;
  }
  if (supported === false) {
    const error = new Error("This model cannot read images. Choose an image-capable model; your text and images are preserved.");
    error.name = "ImageModelError";
    throw error;
  }
}
