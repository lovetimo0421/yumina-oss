import { CHAT_IMAGE_MIME_TYPES, MAX_CHAT_IMAGES, MAX_CHAT_IMAGE_BYTES, MAX_CHAT_IMAGE_TOTAL_BYTES, type ChatImageInput } from "@yumina/shared";

/** Only consume an image paste. Plain text/HTML pastes keep native behavior. */
export function pastedImageFiles(items: ArrayLike<Pick<DataTransferItem, "kind" | "type" | "getAsFile">>): File[] {
  return Array.from(items).filter(item => item.kind === "file" && item.type.startsWith("image/"))
    .map(item => item.getAsFile()).filter((file): file is File => !!file);
}

export async function readChatImages(files: File[], current: ChatImageInput[]): Promise<ChatImageInput[]> {
  if (files.length + current.length > MAX_CHAT_IMAGES) throw new Error("count");
  let bytes = current.reduce((n, a) => n + a.data.length * 3 / 4, 0);
  for (const file of files) {
    if (!CHAT_IMAGE_MIME_TYPES.includes(file.type as typeof CHAT_IMAGE_MIME_TYPES[number])) throw new Error("format");
    if (!file.size || file.size > MAX_CHAT_IMAGE_BYTES) throw new Error("size");
    bytes += file.size;
  }
  if (bytes > MAX_CHAT_IMAGE_TOTAL_BYTES) throw new Error("total");
  return Promise.all(files.map(file => new Promise<ChatImageInput>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read"));
    reader.onload = () => resolve({ type: "image", mimeType: file.type, name: file.name || "image", data: String(reader.result).split(",")[1]! });
    reader.readAsDataURL(file);
  })));
}

export function chatImageCopy(language: string, key: string): string {
  const zh = language.startsWith("zh");
  const copy: Record<string, [string, string]> = {
    add: ["Add images", "添加图片"], remove: ["Remove image", "移除图片"],
    unsupported: ["This model cannot read images. Your draft is saved.", "当前模型不支持图片，图片和文字已保留。"],
    choose: ["Choose an image model", "选择读图模型"],
    count: ["Up to 4 images per message.", "每条消息最多 4 张图片。"],
    size: ["Each image must be under 8 MB.", "每张图片不能超过 8 MB。"],
    total: ["Images must total 16 MB or less.", "图片总大小不能超过 16 MB。"],
    format: ["Use PNG, JPEG, WebP or GIF.", "支持 PNG、JPEG、WebP 和 GIF。"],
    read: ["Could not read this image. Try again.", "图片读取失败，请重试。"],
  };
  return (copy[key] ?? copy.read)![zh ? 1 : 0];
}
