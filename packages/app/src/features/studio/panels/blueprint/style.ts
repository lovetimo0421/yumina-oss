import type { GraphNode } from "@yumina/engine";
import {
  BookOpen,
  Boxes,
  Code,
  Globe,
  MessageCircle,
  Music,
  Radio,
  Variable as VariableIcon,
  Zap,
  Images,
} from "lucide-react";

/**
 * What each visual device on this board is allowed to mean.
 *
 * Written down because the board was drifting: a stock-chat interface and the
 * card's memory ended up as two grey half-width boxes beside each other,
 * which made the one thing a player sees and the card's most expensive
 * decision look like a pair of toggles. Nothing was wrong with either block —
 * the board had simply stopped saying which things matter.
 *
 *   COLOUR   which KIND of thing this is. One kind, one hue, never reused:
 *            interface rose · memory lime · lore violet · variables sky ·
 *            behaviours orange · openings emerald · the card itself zinc.
 *            Amber is not a kind: it is this board's attention colour
 *            (selected, recent, added, the module gate that is on), which is
 *            why memory had to give it up — a memory block in amber read as
 *            something someone had just clicked. Its second try, indigo,
 *            was wrong for a different reason: lore and variables are the
 *            same blue-purple family, and a third hue between them reads
 *            as a shade of those rather than a kind of its own.
 *
 *   SIZE     how much it carries. Full width = a pillar of the card (the
 *            interface, the memory, each opening, each shelf of lore). Half
 *            width = one of a pair read against each other (variables and the
 *            behaviours that move them). A single header row = a setting.
 *
 *   POSITION what to look at first. What the PLAYER sees leads (interface),
 *            then what the AI remembers, then what the author writes, then
 *            the lists, and settings sink to the bottom.
 *
 *   SHAPE    whether there is anything inside. A block with content has a
 *            body; a block that is only a decision is one header tall — the
 *            height alone says whether opening it is worth a click.
 *
 *   LINE     how two things are related. Solid = they share one thing.
 *            Dashed = one reads the other and cannot write it. No line at
 *            all = independent, which is the default and needs no ink.
 *
 * Adding a block kind means answering these five before inventing anything.
 */
/** Edge tint by relationship type — every wire means one real schema binding. */
export function edgeColor(edgeId: string): string {
  if (edgeId.startsWith("e:world->")) return "#a1a1aa"; // the card owns this opening
  if (edgeId.includes("->module:")) return "#d9a13f"; // activation (gold)
  if (edgeId.startsWith("e:greeting:") && edgeId.includes("->var:")) return "#34b27a"; // opening seeds
  if (edgeId.startsWith("e:reaction:") && edgeId.includes("->reaction:")) return "#818cf8"; // emit chain (indigo)
  if (edgeId.includes("->entry:")) return "#8b5cf6"; // condition gate
  if (edgeId.endsWith("->frontend:read")) return "#22d3ee"; // a variable drives the UI
  if (edgeId.includes("->frontend:")) return "#f43f5e"; // LoreSlot binding
  if (edgeId.includes("->var:")) return "#f97316"; // behavior effect
  if (edgeId.includes("->audio:")) return "#14b8a6"; // audio
  return "#71717a"; // event trigger / misc
}

/**
 * A row's three states, always in its own kind's hue.
 *
 * `off` used to be `saturate-0`, which strips the hue outright — a switched
 * off variable and a switched off behaviour came out as the same grey row,
 * and a shelf of greys cannot be read as "these are quiet" rather than
 * "these are broken". Colour carries the KIND and nothing else; brightness
 * carries the state. So off is the kind's colour, dimmed; on is the kind's
 * colour, lit; and the turn it fires, the kind's colour at full.
 *
 * `off` is a text colour with no wash on purpose. If every row were washed,
 * the wash would say nothing about any of them — it is the LIT rows that
 * have to stand out of the shelf, so only they carry one.
 *
 * None of these adds a border. A row's height is counted to the pixel by the
 * block height model (see board.ts), and a border is a pixel.
 */
export const ROW_TONE: Record<
  GraphNode["kind"],
  { dim: string; wash: string; hot: string; chip: string; chipOff: string }
> = {
  module: { dim: "text-amber-200/45", wash: "bg-amber-500/[0.06]", hot: "bg-amber-400/[0.18]", chip: "border-amber-500/40 bg-amber-500/10 text-foreground/85 hover:border-amber-400/75 hover:text-foreground", chipOff: "border-amber-500/20 bg-amber-500/[0.04] text-amber-200/45" },
  variable: { dim: "text-sky-200/45", wash: "bg-sky-500/[0.06]", hot: "bg-sky-400/[0.18]", chip: "border-sky-500/40 bg-sky-500/10 text-foreground/85 hover:border-sky-400/75 hover:text-foreground", chipOff: "border-sky-500/20 bg-sky-500/[0.04] text-sky-200/45" },
  greeting: { dim: "text-emerald-200/45", wash: "bg-emerald-500/[0.06]", hot: "bg-emerald-400/[0.18]", chip: "border-emerald-500/40 bg-emerald-500/10 text-foreground/85 hover:border-emerald-400/75 hover:text-foreground", chipOff: "border-emerald-500/20 bg-emerald-500/[0.04] text-emerald-200/45" },
  entry: { dim: "text-violet-200/45", wash: "bg-violet-500/[0.06]", hot: "bg-violet-400/[0.18]", chip: "border-violet-500/40 bg-violet-500/10 text-foreground/85 hover:border-violet-400/75 hover:text-foreground", chipOff: "border-violet-500/20 bg-violet-500/[0.04] text-violet-200/45" },
  rule: { dim: "text-orange-200/45", wash: "bg-orange-500/[0.06]", hot: "bg-orange-400/[0.18]", chip: "border-orange-500/40 bg-orange-500/10 text-foreground/85 hover:border-orange-400/75 hover:text-foreground", chipOff: "border-orange-500/20 bg-orange-500/[0.04] text-orange-200/45" },
  event: { dim: "text-zinc-300/45", wash: "bg-zinc-500/[0.06]", hot: "bg-zinc-400/[0.18]", chip: "border-zinc-500/45 bg-zinc-500/10 text-foreground/85 hover:border-zinc-400/75 hover:text-foreground", chipOff: "border-zinc-500/25 bg-zinc-500/[0.04] text-zinc-300/45" },
  component: { dim: "text-rose-200/45", wash: "bg-rose-500/[0.06]", hot: "bg-rose-400/[0.18]", chip: "border-rose-500/40 bg-rose-500/10 text-foreground/85 hover:border-rose-400/75 hover:text-foreground", chipOff: "border-rose-500/20 bg-rose-500/[0.04] text-rose-200/45" },
  audio: { dim: "text-teal-200/45", wash: "bg-teal-500/[0.06]", hot: "bg-teal-400/[0.18]", chip: "border-teal-500/40 bg-teal-500/10 text-foreground/85 hover:border-teal-400/75 hover:text-foreground", chipOff: "border-teal-500/20 bg-teal-500/[0.04] text-teal-200/45" },
  image: { dim: "text-pink-200/45", wash: "bg-pink-500/[0.06]", hot: "bg-pink-400/[0.18]", chip: "border-pink-500/40 bg-pink-500/10 text-foreground/85 hover:border-pink-400/75 hover:text-foreground", chipOff: "border-pink-500/20 bg-pink-500/[0.04] text-pink-200/45" },
  world: { dim: "text-zinc-300/45", wash: "bg-zinc-500/[0.06]", hot: "bg-zinc-400/[0.18]", chip: "border-zinc-400/40 bg-zinc-400/10 text-foreground/85 hover:border-zinc-300/75 hover:text-foreground", chipOff: "border-zinc-400/20 bg-zinc-400/[0.04] text-zinc-300/45" },
};

export const KIND_STYLE: Record<
  GraphNode["kind"],
  { icon: typeof Zap; accent: string; hover: string; chip: string; port: string; mini: string;
    /** The kind's colour washing the top of the inspector column — a
     *  radial wash off the top-left corner (studio material). */
    wash: string }
> = {
  module: { icon: Boxes, accent: "border-amber-500/45", hover: "hover:border-amber-400/80", chip: "bg-amber-500/15 text-amber-400", port: "!bg-amber-400", mini: "#d9a13f", wash: "bg-[radial-gradient(120%_100%_at_0%_0%,rgba(217,161,63,0.10),transparent_60%)]" },
  variable: { icon: VariableIcon, accent: "border-sky-500/45", hover: "hover:border-sky-400/80", chip: "bg-sky-500/15 text-sky-400", port: "!bg-sky-400", mini: "#38bdf8", wash: "bg-[radial-gradient(120%_100%_at_0%_0%,rgba(56,189,248,0.10),transparent_60%)]" },
  greeting: { icon: MessageCircle, accent: "border-emerald-500/45", hover: "hover:border-emerald-400/80", chip: "bg-emerald-500/15 text-emerald-400", port: "!bg-emerald-400", mini: "#34b27a", wash: "bg-[radial-gradient(120%_100%_at_0%_0%,rgba(52,178,122,0.10),transparent_60%)]" },
  entry: { icon: BookOpen, accent: "border-violet-500/45", hover: "hover:border-violet-400/80", chip: "bg-violet-500/15 text-violet-400", port: "!bg-violet-400", mini: "#8b5cf6", wash: "bg-[radial-gradient(120%_100%_at_0%_0%,rgba(139,92,246,0.10),transparent_60%)]" },
  rule: { icon: Zap, accent: "border-orange-500/45", hover: "hover:border-orange-400/80", chip: "bg-orange-500/15 text-orange-400", port: "!bg-orange-400", mini: "#f97316", wash: "bg-[radial-gradient(120%_100%_at_0%_0%,rgba(249,115,22,0.10),transparent_60%)]" },
  event: { icon: Radio, accent: "border-zinc-600/60", hover: "hover:border-zinc-400/70", chip: "bg-zinc-700/40 text-zinc-400", port: "!bg-zinc-400", mini: "#71717a", wash: "bg-[radial-gradient(120%_100%_at_0%_0%,rgba(113,113,122,0.08),transparent_60%)]" },
  component: { icon: Code, accent: "border-rose-500/45", hover: "hover:border-rose-400/80", chip: "bg-rose-500/15 text-rose-400", port: "!bg-rose-400", mini: "#f43f5e", wash: "bg-[radial-gradient(120%_100%_at_0%_0%,rgba(244,63,94,0.09),transparent_60%)]" },
  audio: { icon: Music, accent: "border-teal-500/45", hover: "hover:border-teal-400/80", chip: "bg-teal-500/15 text-teal-400", port: "!bg-teal-400", mini: "#14b8a6", wash: "bg-[radial-gradient(120%_100%_at_0%_0%,rgba(20,184,166,0.10),transparent_60%)]" },
  image: { icon: Images, accent: "border-pink-500/45", hover: "hover:border-pink-400/80", chip: "bg-pink-500/15 text-pink-400", port: "!bg-pink-400", mini: "#ec4899", wash: "bg-[radial-gradient(120%_100%_at_0%_0%,rgba(236,72,153,0.09),transparent_60%)]" },
  world: { icon: Globe, accent: "border-zinc-400/40", hover: "hover:border-zinc-300/70", chip: "bg-zinc-400/15 text-zinc-200", port: "!bg-zinc-300", mini: "#a1a1aa", wash: "bg-[radial-gradient(120%_100%_at_0%_0%,rgba(161,161,170,0.08),transparent_60%)]" },
};
