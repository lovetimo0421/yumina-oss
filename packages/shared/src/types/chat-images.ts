/** Portable across the app, creator sandbox and server. Data is bare base64. */
export interface ChatImageInput {
  type: "image";
  mimeType: string;
  name: string;
  data: string;
}
export type ImageMessageContent = string | Array<
  { type: "text"; text: string } |
  { type: "image_url"; image_url: { url: string } }
>;
export interface ImageCompletionMessage {
  role: string;
  content: ImageMessageContent;
  attachments?: ChatImageInput[];
}
export const CHAT_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const MAX_CHAT_IMAGES = 4;
export const MAX_CHAT_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_CHAT_IMAGE_TOTAL_BYTES = 16 * 1024 * 1024;
