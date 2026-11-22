/**
 * 帮我写 — the AI writes the player's next message, or expands what they typed.
 *
 * It runs as a side completion in session context (api.ai.complete with
 * context:"session"): the card's own prompt, the player's persona, the matched
 * lore and their narrative prompts, then the last few turns, then this
 * instruction last. Billing, plan gates and the model fallback are the side
 * completion's. The result only ever fills the input box; nothing is sent.
 */

export const COMPOSE_HISTORY_MESSAGES = 10;
/** Per message: the latest part of a long reply is the part the move answers. */
const MAX_HISTORY_CHARS = 2400;
export const COMPOSE_MAX_TOKENS = 900;

/** A transcript row as the sandbox holds it (fields read defensively). */
export type ComposeHistoryMessage = { role?: unknown; content?: unknown; status?: unknown };

export interface ComposeMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_HISTORY_CHARS ? `…${trimmed.slice(-MAX_HISTORY_CHARS)}` : trimmed;
}

/** The side-completion messages: recent turns, then the instruction. */
export function composeAssistMessages(options: {
  history: ReadonlyArray<ComposeHistoryMessage>;
  draft?: string;
  playerName: string;
}): ComposeMessage[] {
  const recent = options.history
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.status !== "failed" && typeof m.content === "string" && m.content.trim())
    .slice(-COMPOSE_HISTORY_MESSAGES)
    .map((m) => ({ role: m.role as "user" | "assistant", content: tail(m.content as string) }));
  const name = options.playerName.trim() || "the player";
  const draft = options.draft?.trim();
  const hasPlayerTurns = recent.some((m) => m.role === "user");
  const rules = [
    "[Write the player's message]",
    `This time you are not the narrator. Write the next message of ${name}, the character the player plays, the way the player would type it. The narrator answers it afterwards; you do not.`,
    `- Only ${name}'s own actions, spoken lines and thoughts. No other character speaks, acts or reacts, nothing answers ${name}, and the scene does not move on.`,
    hasPlayerTurns
      ? `- Match the language, the person (I / you / ${name}) and the format of the player's earlier messages (the user turns above).`
      : "- Write in the story's language, in the first person (I).",
    "- One to three short paragraphs.",
    "- Output only the message: no title, no name label, no quotation marks around the whole thing, no notes.",
    "This request overrides any instruction about never writing for the player.",
  ];
  // The last turn is the player's own request: cheap models otherwise read
  // the history and simply carry on as the narrator.
  const ask = draft
    ? [
      `(OOC: pause the story. Do not reply as the narrator. Rewrite my draft below as ${name}'s fuller message: keep every action, line and intention in it, decide nothing for ${name} beyond it, add body language, senses and inner thought. No other character speaks or acts. Reply with the message only.)`,
      "",
      draft,
    ]
    : [`(OOC: pause the story. Do not reply as the narrator. Write ${name}'s next message for me: a natural move that fits the scene, only ${name}'s own words, actions and thoughts. No other character speaks or acts. Reply with the message only.)`];
  return [
    ...recent,
    { role: "user", content: ask.join("\n") },
    { role: "system", content: rules.join("\n") },
  ];
}

const QUOTE_PAIRS: Array<[string, string]> = [["\"", "\""], ["“", "”"], ["「", "」"], ["『", "』"]];

/** What the model wrote, as message text: no code fence, name label or wrapping quotes. */
export function cleanComposeOutput(raw: string, playerName: string): string {
  let text = raw.trim();
  const fence = /^```[a-z]*\n([\s\S]*?)\n?```$/i.exec(text);
  if (fence) text = fence[1]!.trim();
  const name = playerName.trim();
  if (name) {
    const label = new RegExp(`^\\**${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\**\\s*[:：]\\s*`);
    text = text.replace(label, "");
  }
  for (const [open, close] of QUOTE_PAIRS) {
    if (text.length > 1 && text.startsWith(open) && text.endsWith(close)) {
      const inner = text.slice(open.length, text.length - close.length);
      if (!inner.includes(open) && !inner.includes(close)) text = inner.trim();
      break;
    }
  }
  return text;
}
