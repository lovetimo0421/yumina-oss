import { computeActiveWorldbookIds, followingVoices, type GameState, type Worldbook } from "@yumina/engine";

/**
 * The client's half of a group chat (server lib/group-reply.ts): whether a
 * card can have one at all, and which voice answers next — read from the same
 * engine rule the server uses, so the "正在输入" name over the waiting bubble
 * is the voice whose answer then lands there.
 */

/** A card has group chats when some AI lives on the card or in a situation. */
export function hasGroupVoices(books: ReadonlyArray<Worldbook> | null | undefined): boolean {
  return (books ?? []).some((b) => b.host !== undefined && b.station?.kind === "narrator");
}

interface TurnMessage {
  role: string;
  status?: string | null;
  swipes?: ReadonlyArray<{ voice?: string }> | null;
  activeSwipeIndex?: number | null;
}

const voiceOf = (m: TurnMessage): string | undefined => m.swipes?.[m.activeSwipeIndex ?? 0]?.voice ?? m.swipes?.[0]?.voice;

/** Who answers next since the player last spoke, or null: no answer has
 *  landed yet, or the whole room has spoken. */
export function nextGroupVoice(
  books: Worldbook[],
  state: GameState,
  messages: ReadonlyArray<TurnMessage>,
): Worldbook | null {
  const lastUser = messages.map((m) => m.role).lastIndexOf("user");
  if (lastUser < 0) return null;
  const turn = messages.slice(lastUser + 1);
  if (turn.some((m) => m.status === "streaming")) return null;
  const answered = turn.filter((m) => m.role === "assistant" && m.status !== "failed");
  if (answered.length === 0) return null;
  const spoke = new Set(answered.map(voiceOf).filter((v): v is string => !!v));
  return followingVoices(books, computeActiveWorldbookIds(books, state)).find((f) => !spoke.has(f.id)) ?? null;
}
