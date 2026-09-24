import { MAX_CHAT_IMAGE_BYTES, type ChatImageAttachment, type ChatImageInput } from "@yumina/shared";
import { getAssetCdnUrl } from "./asset-url";
import { readChatImages } from "./chat-image-input";

/** Read the original asset, never its thumbnail. The existing chat pipeline
 * validates and snapshots these bytes so later library edits cannot alter history. */
export async function readChatAsset(asset: ChatImageAttachment, signal?: AbortSignal): Promise<ChatImageInput> {
  const response = await fetch(getAssetCdnUrl(asset.assetId), {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
  });
  if (!response.ok || !response.body) throw new Error("read");
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    if (Number(response.headers.get("content-length")) > MAX_CHAT_IMAGE_BYTES) throw new Error("size");
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_CHAT_IMAGE_BYTES) throw new Error("size");
      chunks.push(new Uint8Array(chunk.value));
    }
    const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim() || asset.mimeType;
    const [image] = await readChatImages([new File(chunks, asset.name, { type: mimeType })], []);
    return image!;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
