/** What one AI call actually received, in the order it was assembled. Streamed
 *  with `done` so the studio playtest can show the real prompt by segment
 *  instead of an estimate — every number is measured on the messages the
 *  provider was sent, after history trimming. Sizes only, no text: the
 *  payload already carries `injectedEntryIds`, so this reveals nothing new. */
export type PromptSegmentKind =
  | "lore"            // always-send entries, user prompts, active rule directives
  | "persona"         // the player's persona
  | "platform"        // directive syntax, behavior rules, output contract, anti-repetition
  | "examples"        // example dialogue
  | "lore-triggered"  // keyword/condition entries, depth-injected entries
  | "memory"          // story summary, session memory, archived runs
  | "inputs"          // what other situations hand this one (station inputs)
  | "history"         // the conversation itself
  | "pending"         // context a behavior queued for this turn
  | "state"           // the variable summary and last turn's changes
  | "scene"           // 现场: what the card's interface showed at this moment
  | "game"            // 游戏数据: the game's reports this AI is wired to read
  | "post";           // post-history instructions

export interface PromptTrace {
  version: 1;
  /** The situation whose AI answered; null when the card itself did. */
  speaker: { id: string; name: string } | null;
  model: string;
  totalChars: number;
  segments: Array<{ kind: PromptSegmentKind; chars: number; messages: number }>;
  /** Real conversation messages that survived the window and the trim. */
  historyMessages: number;
  /** The game data sources this AI was given, by name (api.publish). */
}

const ORDER: PromptSegmentKind[] = ["lore", "persona", "platform", "examples", "lore-triggered", "memory", "inputs", "history", "pending", "state", "scene", "game", "post"];

type Msg = { content: string; sourceMessageId?: string };

/** Tag messages as the prompt is assembled; `take` labels everything in the
 *  list not labelled yet, so each step is one call after it pushes. Objects
 *  keep their identity through `buildMessageHistoryAsync` (it slices), which
 *  is what lets the trace be measured on the final list. */
export function createPromptTracer() {
  const kinds = new Map<object, PromptSegmentKind>();
  return {
    tag(msg: object, kind: PromptSegmentKind) {
      kinds.set(msg, kind);
    },
    take(list: readonly object[], kind: PromptSegmentKind) {
      for (const m of list) if (!kinds.has(m)) kinds.set(m, kind);
    },
    /** History rows without a stored message id are archived-run summaries. */
    takeHistory(list: readonly Msg[]) {
      for (const m of list) if (!kinds.has(m)) kinds.set(m, m.sourceMessageId ? "history" : "memory");
    },
    build(final: readonly Msg[], meta: { speaker: { id: string; name: string } | null; model: string }): PromptTrace {
      const sums = new Map<PromptSegmentKind, { chars: number; messages: number }>();
      let total = 0;
      let historyMessages = 0;
      for (const m of final) {
        // Anything added after the last take (compaction blocks, the output
        // contract) is platform plumbing unless it was tagged on the way in.
        const kind = kinds.get(m) ?? "platform";
        const chars = typeof m.content === "string" ? m.content.length : 0;
        const s = sums.get(kind) ?? { chars: 0, messages: 0 };
        s.chars += chars;
        s.messages += 1;
        sums.set(kind, s);
        total += chars;
        if (kind === "history") historyMessages += 1;
      }
      return {
        version: 1,
        speaker: meta.speaker,
        model: meta.model,
        totalChars: total,
        segments: ORDER.filter((k) => sums.has(k)).map((kind) => ({ kind, ...sums.get(kind)! })),
        historyMessages,
      };
    },
  };
}
