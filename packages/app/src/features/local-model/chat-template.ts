/**
 * Make a Yumina prompt acceptable to a model's own chat template.
 *
 * LM Studio, llama.cpp and Jan render the prompt with the Jinja template baked
 * into the model file, and those templates police the message list. Qwen's
 * raises "System message must be at the beginning." for any system message
 * after the first; Mistral's and Command-R's raise "Conversation roles must
 * alternate user/assistant/user/assistant/...". The runtime turns either into
 * an error before a single token is generated. Ollama renders with its own,
 * forgiving templates, which is why the same prompt works there.
 *
 * Our pipeline legitimately produces exactly what those templates reject:
 * several system blocks up front (presets, persona, lore), more at an
 * insertion depth inside the history, and a chat that opens on the character's
 * greeting. So reshape it into the one form every template accepts, without
 * moving anything relative to the conversation:
 *
 *   - the system blocks before the first turn become ONE system message;
 *   - a system block inside the history becomes user-side text in place
 *     (merged into the neighbouring player turn), so depth-injected lore still
 *     sits where it was injected;
 *   - runs of the same role merge, so roles strictly alternate;
 *   - a chat that opens on the greeting gets a minimal user turn before it.
 *
 * `systemRole: false` is the fallback for templates with no system role at all
 * (Gemma 2, early Mistral): the system text opens the first user turn instead.
 */

export interface WireMessage {
  role: string;
  content: unknown;
}

type Part = { type?: unknown; text?: unknown } & Record<string, unknown>;

/**
 * The user turn placed before a chat that opens on the character's greeting.
 * Bracketed so no model reads it as something the player said in the story.
 */
export const OPENING_TURN = "[Start]";

function toParts(content: unknown): Part[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (Array.isArray(content)) return content.filter((p): p is Part => !!p && typeof p === "object");
  return [];
}

/** System blocks only ever carry text; anything else in them is dropped. */
function textOf(content: unknown): string {
  return toParts(content)
    .map((p) => (p.type === "text" && typeof p.text === "string" ? p.text : ""))
    .filter((t) => t.length > 0)
    .join("\n\n");
}

/**
 * Join two message contents with a blank line between their text, keeping any
 * image parts in place. All-text results collapse to a plain string: older
 * templates index `message['content']` as a string and choke on part arrays.
 */
function joinContent(a: unknown, b: unknown): unknown {
  const out: Part[] = [];
  for (const part of [...toParts(a), ...toParts(b)]) {
    if (part.type !== "text") {
      out.push(part);
      continue;
    }
    const text = typeof part.text === "string" ? part.text : "";
    if (!text) continue;
    const prev = out[out.length - 1];
    if (prev?.type === "text") out[out.length - 1] = { ...prev, text: `${prev.text as string}\n\n${text}` };
    else out.push({ ...part, text });
  }
  if (out.every((p) => p.type === "text")) return out.map((p) => p.text as string).join("\n\n");
  return out;
}

export function toTemplateSafeMessages(messages: WireMessage[], opts: { systemRole: boolean }): WireMessage[] {
  let start = 0;
  let system = "";
  while (start < messages.length && messages[start]!.role === "system") {
    system = joinContent(system, textOf(messages[start]!.content)) as string;
    start += 1;
  }

  const turns: WireMessage[] = [];
  for (const message of messages.slice(start)) {
    const isSystem = message.role === "system";
    const content = isSystem ? textOf(message.content) : message.content;
    // An empty system block has nothing to say; keeping it would only split a turn.
    if (isSystem && !content) continue;
    const role = message.role === "assistant" ? "assistant" : "user";
    const prev = turns[turns.length - 1];
    if (prev?.role === role) prev.content = joinContent(prev.content, content);
    else turns.push({ role, content: joinContent("", content) });
  }

  // A system-only prompt: the template needs something to answer.
  if (turns.length === 0) return system ? [{ role: "user", content: system }] : [];

  if (opts.systemRole || !system) {
    if (turns[0]!.role === "assistant") turns.unshift({ role: "user", content: OPENING_TURN });
    return system ? [{ role: "system", content: system }, ...turns] : turns;
  }

  // No system role: the instructions open the first user turn, which also
  // gives a greeting-first chat the user turn its template wants.
  if (turns[0]!.role === "user") turns[0] = { role: "user", content: joinContent(system, turns[0]!.content) };
  else turns.unshift({ role: "user", content: system });
  return turns;
}

/** Did the runtime reject the prompt's shape (as opposed to failing to run it)? */
export function isTemplateError(detail: string): boolean {
  return /jinja|chat template|prompt template|raise_exception|roles must alternate|system role|system message/i.test(detail);
}
