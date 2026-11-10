import { blockId, type Block } from "@yumina/engine";


export const STARTER_IDS = {
  setting: "block:starter:setting",
  opening: "block:starter:opening",
} as const;

export type CanvasBlock = Block & { sourceBlockId?: string; tray?: readonly TrayItem[] };

/** A slot the tray offers instead of an empty block. */
export type TrayItem = "state" | "behavior" | "audio" | "image" | "background" | "packs";

export interface TrayOptions {
  /** The card has a chat background already, so its block stays. */
  hasBackground: boolean;
  /** Slots the author has brought out of the tray this session. */
  revealed: ReadonlySet<TrayItem>;
  /** Offer the mechanic packs too. */
  packs: boolean;
}

function placeholder(id: string, kind: Block["kind"]): Block {
  return { id, kind, rows: [], headSlots: [], hiddenCount: 0, total: 0, sharedCount: 0 };
}

/** Presentation-only slots. They never become entries until the author adds one.
 * A writing node can keep its ReactFlow identity when its invitation becomes
 * real content. The authored object ids, rows and ports remain untouched. */
export function withStarterSlots(
  blocks: readonly Block[],
  showCreationSlots: boolean,
  stableWritingIds = false,
  tray?: TrayOptions,
): CanvasBlock[] {
  const firstOpening = blocks.find(b => b.kind === "opening" && b.total > 0);
  const firstSetting = blocks.find(b => b.kind === "lore" && b.total > 0);
  const result = stableWritingIds
    ? blocks.map(b => b === firstOpening
      ? { ...b, id: STARTER_IDS.opening, sourceBlockId: (b as CanvasBlock).sourceBlockId ?? b.id }
      : b === firstSetting ? { ...b, id: STARTER_IDS.setting, sourceBlockId: (b as CanvasBlock).sourceBlockId ?? b.id } : b)
    : [...blocks];
  if (showCreationSlots && !blocks.some(b => b.kind === "lore" && b.total > 0)) {
    result.push(placeholder(STARTER_IDS.setting, "lore"));
  }
  if (showCreationSlots && !blocks.some(b => b.kind === "opening")) {
    result.push(placeholder(STARTER_IDS.opening, "opening"));
  }
  // Variables, behaviours and the card's memory are drawn whether or not the
  // card has any yet. Only the card's own blocks count: a situation with
  // variables of its own does not give the card a variables block.
  //
  // A creator who has never made one has no way to find out they exist: the
  // board only showed what was already there, so a card with no variables was
  // a card whose author never learned there were variables. An empty block
  // with its name, what it is for, and the "+" that makes the first one is the
  // cheapest possible answer — and it uses the REAL block ids, so the first
  // variable lands in the block that was already standing there instead of
  // moving the board around.
  if (showCreationSlots) {
    // With a tray (not in a lesson, which teaches them as blocks), the two are
    // a "+" on the tray line like the rest: a new card's first look was the
    // two things it had and two empty blocks it did not need yet. Picking one
    // makes the first variable or behaviour, which brings the block out.
    const offered: TrayItem[] = [];
    if (!blocks.some(b => b.kind === "state" && !b.ownerId && !b.loose)) {
      if (tray && !tray.revealed.has("state")) offered.push("state");
      else result.push(placeholder(blockId.state(), "state"));
    }
    if (!blocks.some(b => b.kind === "behavior" && !b.ownerId && !b.loose)) {
      if (tray && !tray.revealed.has("behavior")) offered.push("behavior");
      else result.push(placeholder(blockId.behavior(), "behavior"));
    }
    // Music and sound are the slot most authors never find: the audio panel
    // is four clicks away and nothing on the card says it exists.
    //
    // With a tray, an unused slot is a "+" on one line at the foot of the
    // tile rather than an empty block: a new card was three blocks of
    // "nothing yet", which is most of what a first look took in. Clicking one
    // brings the block out, where it was.
    const slot = (kind: "audio" | "image", id: string) => {
      if (blocks.some(b => b.kind === kind && !b.ownerId && !b.loose)) return;
      if (tray && !tray.revealed.has(kind)) offered.push(kind);
      else result.push(placeholder(id, kind));
    };
    slot("audio", blockId.audio());
    // Scene images the same: the slot is where the upload and the generate
    // button live, so it has to be there before the first picture is.
    slot("image", blockId.image());
    // An unused chat background is not offered here: it is a picture most
    // cards never need, and it is in 面板 for the ones that do.
    if (tray && !tray.hasBackground && !tray.revealed.has("background")) {
      const at = result.findIndex(b => b.kind === "background");
      if (at >= 0) result.splice(at, 1);
    }
    // The packs stay on offer once every slot is in use: the tray is the one
    // place on the board they are offered, and it vanishing with the last
    // slot took that door with it.
    if (tray?.packs) offered.push("packs");
    if (offered.length) {
      const trayBlock: CanvasBlock = { ...placeholder(blockId.tray, "tray"), tray: offered };
      result.push(trayBlock);
    }
  }
  return result;
}

