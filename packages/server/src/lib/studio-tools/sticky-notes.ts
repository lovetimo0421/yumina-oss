import type { WorldDefinition } from "@yumina/engine";

/**
 * The creator's sticky notes on the canvas, each with what it is stuck to.
 *
 * A note is how a creator explains to an AI what the card's parts cannot say
 * themselves: why a behaviour exists, what a hand-written interface expects
 * from the narrator, what to change next. The assistant and outside AIs read
 * the same list. Notes never reach play.
 */
export interface StickyNoteView {
  id: string;
  /** What it is stuck to, in words; absent for a note loose on the board. */
  on?: string;
  /** The stuck-to targets' ids, as the canvas names them. */
  targets?: string[];
  text: string;
}

const KIND_WORDS: Record<string, string> = {
  ais: "AI block",
  context: "Context block",
  frontend: "player interface",
  state: "variables block",
  behavior: "behaviours block",
  audio: "audio block",
  image: "scene images block",
  card: "cover block",
  background: "background block",
  scene: "scene block",
};

/** Words for a canvas id: an entry, a variable, a behaviour, a scenario, a block. */
export function describeCanvasTarget(world: WorldDefinition, id: string): string {
  const books = world.worldbooks ?? [];
  const scenario = (bookId: string) => `scenario "${books.find((b) => b.id === bookId)?.name ?? bookId}"`;
  const after = (prefix: string) => id.slice(prefix.length);
  if (id === "frame:card") return "the card";
  // A file of the player interface, or an AI call written in one — the two
  // things a coded card is made of that the canvas now draws as rows.
  if (id.startsWith("file:")) return `file "${after("file:")}" of the player interface`;
  if (id.startsWith("ai:code:")) {
    const m = /^ai:code:(.+):(d+)$/.exec(id);
    return m ? `the AI call at line ${m[2]} of "${m[1]}" in the player interface` : id;
  }
  if (id.startsWith("ai:")) {
    const key = id.slice(3);
    if (key === "narrator") return "the card's own AI";
    const b = books.find((x) => x.id === key);
    return b ? `AI "${b.station?.name?.trim() || b.name}"` : id;
  }
  if (id.startsWith("module:")) return scenario(after("module:"));
  if (id.startsWith("entry:") || id.startsWith("greeting:")) {
    const entryId = id.slice(id.indexOf(":") + 1);
    const e = (world.entries ?? []).find((x) => x.id === entryId);
    return e ? `entry "${e.name}"` : id;
  }
  if (id.startsWith("var:")) {
    const v = (world.variables ?? []).find((x) => x.id === after("var:"));
    return v ? `variable "${v.name}"` : id;
  }
  if (id.startsWith("reaction:") || id.startsWith("rule:")) {
    const ruleId = id.slice(id.indexOf(":") + 1);
    const r = [...(world.reactions ?? []), ...(world.rules ?? [])].find((x) => x.id === ruleId);
    return r ? `behaviour "${r.name}"` : id;
  }
  if (id.startsWith("block:")) {
    const m = /^block:m:([^:]+):(.+)$/.exec(id);
    const owner = m ? scenario(m[1]!) : "the card";
    const rest = m ? m[2]! : after("block:");
    const kind = rest.split(":")[0]!;
    if (kind === "lore") return `${owner}'s lore block`;
    if (kind === "opening") return `${owner}'s opening`;
    return `${owner}'s ${KIND_WORDS[kind] ?? `${kind} block`}`;
  }
  return id;
}

export function stickyNotes(world: WorldDefinition): StickyNoteView[] {
  return (world.graphLayout?.notes ?? [])
    .filter((n) => n.text.trim())
    .map((n) => {
      const targets = n.targets?.length ? n.targets : n.on ? [n.on] : [];
      return {
        id: n.id,
        ...(targets.length ? { on: targets.map((t) => describeCanvasTarget(world, t)).join(", "), targets } : {}),
        text: n.text,
      };
    });
}
