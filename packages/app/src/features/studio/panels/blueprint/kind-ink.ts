import type { Block } from "@yumina/engine";

// Colour is a signal, not structure (owner, 11/07). A block's kind is its
// icon's colour; the chip it sits in, the head and the edge are the same
// neutral on every block. Before, the colour WAS the structure (a stripe
// down each head, a tinted chip, a 60% coloured frame) in seven saturated
// hues; with none at all the shelves could not be told apart at a glance.
// The inks are one family: the same lightness and the same low chroma in
// OKLCH, only the hue moves, so seven of them side by side do not shout.
// Gold stays the colour of attention.
export const KIND_INK: Record<Block["kind"], string> = {
  card: "text-zinc-300",
  background: "text-zinc-300",
  opening: "text-[oklch(0.8_0.1_160)]",
  lore: "text-[oklch(0.78_0.1_300)]",
  behavior: "text-[oklch(0.8_0.1_60)]",
  state: "text-[oklch(0.8_0.09_235)]",
  frontend: "text-[oklch(0.78_0.1_20)]",
  audio: "text-[oklch(0.8_0.09_190)]",
  image: "text-[oklch(0.8_0.1_350)]",
  context: "text-[oklch(0.82_0.1_125)]",
  scene: "text-[oklch(0.78_0.1_20)]",
  tray: "text-muted-foreground",
  ais: "text-[oklch(0.78_0.11_330)]",
};

/** The icon's square: the same hue at 14%, so the kind reads from across the
 *  board the way a coloured app icon does, while the block round it stays
 *  neutral. */
export const KIND_CHIP: Record<Block["kind"], string> = {
  card: "bg-white/[0.08]",
  background: "bg-white/[0.08]",
  opening: "bg-[oklch(0.8_0.1_160/0.14)]",
  lore: "bg-[oklch(0.78_0.1_300/0.14)]",
  behavior: "bg-[oklch(0.8_0.1_60/0.14)]",
  state: "bg-[oklch(0.8_0.09_235/0.14)]",
  frontend: "bg-[oklch(0.78_0.1_20/0.14)]",
  audio: "bg-[oklch(0.8_0.09_190/0.14)]",
  image: "bg-[oklch(0.8_0.1_350/0.14)]",
  context: "bg-[oklch(0.82_0.1_125/0.14)]",
  scene: "bg-[oklch(0.78_0.1_20/0.14)]",
  tray: "bg-white/[0.06]",
  ais: "bg-[oklch(0.78_0.11_330/0.14)]",
};
