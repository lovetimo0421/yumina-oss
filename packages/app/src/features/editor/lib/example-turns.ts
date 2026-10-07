export interface ExampleTurn {
  role: "user" | "assistant";
  content: string;
  /** This turn opens a new `<START>` block. Only set on turns after the first —
   *  the first block's `<START>` is implicit. */
  startsBlock?: boolean;
}

const ROLE_LINE = /^\s*\{\{(user|char)\}\}:(?:[ \t])?(.*)$/i;
const START_LINE = /^\s*<START>\s*$/i;

/**
 * Parse SillyTavern-style example dialogue without normalizing message text.
 *
 * The editor serializes after every edit, so this must be a lossless
 * round-trip for user-authored whitespace. Only the single separator after a
 * role marker is structural; all other spaces and blank lines are content.
 * Each `<START>` line opens a new block; blocks are kept apart via
 * `startsBlock` so several example conversations survive an edit.
 *
 * Text that belongs to no turn (prose before the first role line, a block
 * with no role lines) is NOT represented — callers must check
 * `canEditAsTurns` before offering the structured editor.
 */
export function parseExampleContent(content: string): ExampleTurn[] {
  const turns: ExampleTurn[] = [];
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  let current: ExampleTurn | null = null;
  let currentContent: string[] = [];
  let pendingBlockStart = false;

  const flush = () => {
    if (current) {
      current.content = currentContent.join("\n");
      turns.push(current);
    }
    current = null;
    currentContent = [];
  };

  for (const line of lines) {
    if (START_LINE.test(line)) {
      flush();
      pendingBlockStart = turns.length > 0;
      continue;
    }
    const roleMatch = line.match(ROLE_LINE);
    if (roleMatch) {
      flush();
      const role: ExampleTurn["role"] = roleMatch[1]!.toLowerCase() === "user" ? "user" : "assistant";
      current = pendingBlockStart ? { role, content: "", startsBlock: true } : { role, content: "" };
      pendingBlockStart = false;
      currentContent.push(roleMatch[2] ?? "");
    } else if (current) {
      currentContent.push(line);
    }
  }
  flush();

  return turns;
}

export function serializeTurns(turns: ExampleTurn[]): string {
  if (turns.length === 0) return "";

  const lines = ["<START>"];
  turns.forEach((turn, i) => {
    if (i > 0 && turn.startsBlock) lines.push("<START>");
    const prefix = turn.role === "user" ? "{{user}}" : "{{char}}";
    lines.push(`${prefix}: ${turn.content}`);
  });
  return lines.join("\n");
}

/**
 * True when the structured turn editor can show `content` without losing a
 * character: re-serializing the parsed turns reproduces it exactly (line
 * endings aside). Prose-only examples, text before the first role line,
 * lowercase `<start>`, missing separator spaces etc. all fail this and must
 * be edited as plain text instead. Blank content is always editable.
 */
export function canEditAsTurns(content: string): boolean {
  if (content.trim() === "") return true;
  const normalized = content.replace(/\r\n/g, "\n");
  return serializeTurns(parseExampleContent(normalized)) === normalized;
}

/** Remove one turn, handing its block boundary to the next turn so the
 *  following turns don't silently merge into the previous block. */
export function removeTurnAt(turns: ExampleTurn[], index: number): ExampleTurn[] {
  const removed = turns[index];
  if (!removed) return turns;
  const next = turns.filter((_, i) => i !== index);
  const successor = next[index];
  if (removed.startsBlock && successor && !successor.startsBlock) {
    next[index] = { ...successor, startsBlock: true };
  }
  // The first turn's block start is implicit.
  const first = next[0];
  if (first?.startsBlock) next[0] = { role: first.role, content: first.content };
  return next;
}
