export interface ExampleTurn {
  role: "user" | "assistant";
  content: string;
}

const ROLE_LINE = /^\s*\{\{(user|char)\}\}:(?:[ \t])?(.*)$/i;

/**
 * Parse SillyTavern-style example dialogue without normalizing message text.
 *
 * The editor serializes after every keystroke, so this must be a lossless
 * round-trip for user-authored whitespace. Only the single separator after a
 * role marker is structural; all other spaces and blank lines are content.
 */
export function parseExampleContent(content: string): ExampleTurn[] {
  const turns: ExampleTurn[] = [];
  const blocks = content.split(/<START>/i).filter((block) => block.trim());

  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    let currentRole: ExampleTurn["role"] | null = null;
    let currentContent: string[] = [];

    const flush = () => {
      if (currentRole) {
        turns.push({ role: currentRole, content: currentContent.join("\n") });
      }
      currentContent = [];
    };

    for (const line of lines) {
      const roleMatch = line.match(ROLE_LINE);

      if (roleMatch) {
        flush();
        currentRole = roleMatch[1]!.toLowerCase() === "user" ? "user" : "assistant";
        currentContent.push(roleMatch[2] ?? "");
      } else if (currentRole) {
        currentContent.push(line);
      }
    }
    flush();
  }

  return turns;
}

export function serializeTurns(turns: ExampleTurn[]): string {
  if (turns.length === 0) return "";

  const lines = ["<START>"];
  for (const turn of turns) {
    const prefix = turn.role === "user" ? "{{user}}" : "{{char}}";
    lines.push(`${prefix}: ${turn.content}`);
  }
  return lines.join("\n");
}
