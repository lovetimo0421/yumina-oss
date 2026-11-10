import type { MessageContent } from "./types.js";

/**
 * Message content for an OpenAI-shaped server we don't control (a creator's
 * own key or endpoint, or a local runtime).
 *
 * Our prompt builders send text in parts — the Studio's system prompt is three,
 * each carrying an Anthropic cache mark. OpenRouter and Anthropic read that;
 * Mistral, Fireworks and Ollama reject it outright ("Input should be a valid
 * string", "cannot unmarshal array"), so the Studio failed on the first call
 * for every creator on those servers. Text alone becomes one string; content
 * with an image keeps its parts, minus the cache marks no other server knows.
 */
export function toWireContent(content: MessageContent): MessageContent {
  if (typeof content === "string") return content;
  if (content.every((part) => part.type === "text")) {
    return content.map((part) => (part.type === "text" ? part.text : "")).join("\n\n");
  }
  return content.map((part) => (part.type === "text" ? { type: "text", text: part.text } : part));
}
