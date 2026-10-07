import type { CardGraph, GraphNode } from "./types.js";
import { UNPLACED_WORLDBOOK_ID } from "../lorebook/worldbook.js";

// The rack canvas drew the five stations of a turn, and every object was a row
// of text inside one. It was honest about how the engine runs — and it showed
// most creators an empty circuit board, because most cards have no circuit:
// across the stored library 62% of cards carry NO wire at all, two of the five
// stations are empty on two thirds of cards, and the median card is seven
// objects with zero wires. A wiring diagram of nothing is still nothing.
//
// So the board draws what the card IS rather than how the engine runs: its
// face, its openings, the knowledge it ships, its interface, and — only when
// they exist — the state and behaviours that move underneath. Blocks that have
// no content do not appear at all. The wires are still here, still load-
// bearing, still the same write-back contract; they are simply no longer the
// reason the canvas exists.

/** How an entry gets into the prompt. The one property a lore-heavy card is
 *  actually managed by: always-on entries burn tokens on every single turn,
 *  triggered ones cost nothing until they hit. */
export type EntryTrigger = "always" | "conditions" | "keywords" | "manual";

export const ENTRY_TRIGGER_ORDER: readonly EntryTrigger[] = ["always", "keywords", "conditions", "manual"];

/** Classify an entry by how it reaches the prompt. Reads the persisted shape
 *  rather than a type union — stored cards carry entries written by older
 *  builds and by imports. */
export function entryTrigger(entry: {
  alwaysSend?: boolean;
  conditions?: unknown[] | null;
  keywords?: unknown[] | null;
}): EntryTrigger {
  if (entry.alwaysSend) return "always";
  if ((entry.conditions?.length ?? 0) > 0) return "conditions";
  if ((entry.keywords?.length ?? 0) > 0) return "keywords";
  return "manual";
}

export type BlockKind =
  /** The card's own face: cover, name, description. Always present. */
  | "card"
  /** The picture behind the chat. Card-level and always present, standing
   *  under the face: it is a treatment of the cover, and a creator who has
   *  not thought about one needs to see that the slot exists. */
  | "background"
  /** One opening. The block IS the greeting — openings are what a player
   *  meets first, so each gets its own block rather than a row in a list. */
  | "opening"
  /** Entries grouped by how they reach the prompt. */
  | "lore"
  | "state"
  | "behavior"
  /** The card's frontend (rootComponent), rendered live. */
  | "frontend"
  | "audio"
  /** Scene images the AI may show mid-story. Card-level like audio: rows on
   *  the card, a count in every module. */
  | "image"
  /** What this frame's AI remembers and reads: its memory scope, the modules
   *  it draws from and the ones that draw from it, and what the card shares
   *  into it. A peer of lore and variables, because it is the third thing a
   *  module is made of. Carries no rows — the canvas fills it from the
   *  worldbooks, which is where the wiring is declared. */
  | "context"
  /** The module's own face: which scene file of the card's frontend shows
   *  while it is on, previewed and edited from here. Only on a card that has
   *  a frontend. Carries no rows. */
  | "scene"
  /** The slots a card has not used yet, drawn as one line of "+" instead of
   *  an empty block each. Never built here: the canvas adds it, in place of
   *  the empty audio, scene-image and background blocks, so a first look at
   *  a card is what the card has rather than a wall of "nothing yet". */
  | "tray"
  /** The AIs that answer in this frame — the card's narrator and the AIs
   *  that live on the card, or a situation's own. Never built here: the
   *  canvas adds one to the card and to every situation. Carries no rows. */
  | "ais";

export interface BlockSlot {
  portId: string;
  label: string;
}

export interface BoardRow {
  g: GraphNode;
  /** Individually-addressable child ports (frontend LoreSlots only). */
  slots: BlockSlot[];
  /** The card's own object, drawn inside a module. The same object is a row
   *  in every module's frame, because every module's AI receives it — there
   *  is one 血量, not four. Absent on a row drawn in its own home. */
  shared?: boolean;
}

export interface Block {
  id: string;
  kind: BlockKind;
  /** The module this block belongs to (a worldbook id), or undefined for the
   *  card itself. A module owns its own lore, variables and behaviours; this
   *  is what lets the canvas draw it as one complete thing instead of a label
   *  on rows scattered through global lists. */
  ownerId?: string;
  /** The single object this block renders as itself (card / opening /
   *  frontend). List blocks have rows instead. */
  head?: GraphNode;
  /** Individually-addressable ports on the head (the frontend's LoreSlots). */
  headSlots: BlockSlot[];
  /** Lore blocks: which injection class this block collects. */
  trigger?: EntryTrigger;
  rows: BoardRow[];
  /** Objects folded away behind "N more". */
  hiddenCount: number;
  total: number;
  /** How many of `total` are the card's objects shared in, as opposed to the
   *  module's own. The shelf under a module counts its own; the frame's
   *  header says both. */
  sharedCount: number;
  /** A card-level object not yet placed in a module: this block is its own,
   *  stands in no frame, and holds exactly that one row. */
  loose?: boolean;
}

/** Card-level ids keep their old spelling so saved layouts and expanded-sets
 *  survive; a module's blocks are namespaced under it. */
const own = (ownerId: string | undefined, rest: string) =>
  ownerId ? `block:m:${ownerId}:${rest}` : `block:${rest}`;

export const blockId = {
  card: "block:card",
  background: "block:background",
  tray: "block:tray",
  opening: (entryId: string) => `block:opening:${entryId}`,
  lore: (trigger: EntryTrigger, ownerId?: string) => own(ownerId, `lore:${trigger}`),
  state: (ownerId?: string) => own(ownerId, "state"),
  behavior: (ownerId?: string) => own(ownerId, "behavior"),
  frontend: "block:frontend",
  audio: (ownerId?: string) => own(ownerId, "audio"),
  image: (ownerId?: string) => own(ownerId, "image"),
  context: (ownerId?: string) => own(ownerId, "context"),
  ais: (ownerId?: string) => own(ownerId, "ais"),
  scene: (ownerId: string) => own(ownerId, "scene"),
  /** A module's openings, as a list — the card's openings are rows in every
   *  module, the way its lore is. */
  openings: (ownerId: string) => own(ownerId, "openings"),
  /** A loose object's own block, outside every frame. */
  loose: (objId: string) => `block:loose:${objId}`,
  /** The frame a module's blocks live in.
   *
   *  A module frame IS the module node: every activation and context wire on
   *  the canvas already points at `module:<id>`, and giving the frame a new
   *  id would silently drop all of them.
   */
  frame: (ownerId: string | null) => (ownerId ? `module:${ownerId}` : "frame:card"),
} as const;

export const isBlockId = (id: string) => id.startsWith("block:");

// ── Handles ─────────────────────────────────────────────────────────
//
// Unchanged from the rack canvas, deliberately. Every object in the projection
// has at most one inbound and one outbound port class, so a row carries one
// aggregate handle per side and loses nothing — the wire's other end already
// names the object. The frontend's LoreSlots are the single exception and keep
// their own addressable ports. `parseRowHandle` feeds `connectionPatch`
// exactly what it fed before, so the write-back contract never learns the
// canvas changed shape.

export const rowHandleId = (objId: string, side: "in" | "out") => `${objId}@${side}`;
export const portHandleId = (objId: string, portId: string) => `${objId}@${portId}`;

/** Split a handle back into the object id and, when it addressed a specific
 *  port (a LoreSlot), that port. Aggregate handles report no port, which is
 *  what `connectionPatch` wants: it infers the port from the two object kinds. */
export function parseRowHandle(handle: string | null | undefined): { objId: string; port?: string } | null {
  if (!handle) return null;
  const at = handle.lastIndexOf("@");
  if (at <= 0) return null;
  const objId = handle.slice(0, at);
  const tail = handle.slice(at + 1);
  if (!tail) return null;
  return tail === "in" || tail === "out" ? { objId } : { objId, port: tail };
}

// ── Rows ────────────────────────────────────────────────────────────

/** Rows shown before the rest fold behind "N more". Lore rows carry two lines
 *  of the entry's actual text, so fewer of them fit before the block stops
 *  being readable at a glance. */
export const BLOCK_ROW_LIMIT: Record<"lore" | "state" | "behavior" | "audio" | "image" | "opening", number> = {
  lore: 6,
  state: 10,
  behavior: 8,
  audio: 6,
  image: 6,
  opening: 6,
};

/** Object ids carrying at least one wire. A load-bearing row is never folded
 *  away: when a card does have wiring, that wiring is the whole point. */
export function wiredNodeIds(graph: CardGraph): Set<string> {
  const wired = new Set<string>();
  for (const e of graph.edges) {
    wired.add(e.from);
    wired.add(e.to);
  }
  return wired;
}

function slotsOf(g: GraphNode): BlockSlot[] {
  if (g.kind !== "component") return [];
  return g.ports
    .filter((p) => p.id.startsWith("slot:"))
    .map((p) => ({ portId: p.id, label: p.label ?? p.id.slice("slot:".length) }));
}

function triggerOfNode(g: GraphNode): EntryTrigger {
  const t = g.data.trigger;
  return t === "always" || t === "keywords" || t === "conditions" || t === "manual" ? t : "manual";
}

export interface BuildBoardOptions {
  /** Rows that must stay on screen: the creator just created, selected,
   *  searched for or otherwise touched them. */
  forced?: ReadonlySet<string>;
  /** Second-band rows — shown before plain ones once the must-haves fit. */
  preferred?: ReadonlySet<string>;
  /** Block ids the creator has expanded: those show every row. */
  expanded?: ReadonlySet<string>;
  /** Rows shown before a block folds, per kind, when the caller draws rows
   *  smaller than the default assumes — a chip is a fraction of a row. */
  rowLimits?: Partial<Record<keyof typeof BLOCK_ROW_LIMIT, number>>;
  /** Card-level objects the creator has not yet put in a module. On a card
   *  with modules each is drawn as its own block outside every frame,
   *  instead of as a shared row in each module. Ignored for objects that
   *  have a module, and on a card without modules. */
  loose?: ReadonlySet<string>;
  /** The card keeps a frame of its own beside its modules — the root module,
   *  holding what the card itself owns as ordinary rows. Each module then
   *  carries the card's objects as a COUNT (`sharedCount`) rather than as
   *  rows: five shared entries redrawn in every module doubled the height of
   *  each one. Without this the card dissolves into its modules (the older
   *  drawing, kept for the callers and tests that expect it). */
  cardFrame?: boolean;
}

/** A module and everything inside it — or the card itself, which is the same
 *  shape with no module around it.
 *
 *  This is the unit a creator thinks in. A module is not a label on rows kept
 *  in global lists somewhere else on the canvas; it is a complete thing, and
 *  opening it shows what it is made of. */
export interface Frame {
  id: string;
  /** The worldbook, or null for the card's own contents. */
  ownerId: string | null;
  /** The module's gate node, so the frame can wear its name, activation and
   *  station badge. Null for the card frame. */
  module: GraphNode | null;
  blocks: Block[];
  /** Members across every block, for the collapsed header's count. */
  total: number;
  /** The module's own members, and the card's shared into it. `own + shared
   *  === total`. On the card's frame `shared` is always 0. */
  own: number;
  shared: number;
  /** The card's frame on a card that has modules. Its lore, variables and
   *  behaviours have gone into every module; what is left — face, openings,
   *  interface, audio — exists once and is not a fifth module. On a card
   *  with modules the card is not drawn at all; this is only ever set on the
   *  fallback frame that catches a block whose module vanished, and it draws
   *  as an unframed strip, never as a box called "the card". */
  strip: boolean;
}

/** Which frame an object lives in. Undefined parent = the card's own frame. */
export const frameIdForNode = (g: GraphNode): string =>
  g.parentId?.startsWith("module:")
    ? blockId.frame(g.parentId.slice("module:".length))
    : blockId.frame(null);

const ownerOf = (g: GraphNode): string | undefined =>
  g.parentId?.startsWith("module:") ? g.parentId.slice("module:".length) : undefined;

/**
 * Group the projection into the blocks a card is made of, one set per module.
 *
 * Rows inside a list block are kept in three bands, in order: wired-or-forced,
 * then the caller's "worth seeing" nominations, then whatever else fits. The
 * rest fold behind a count. Order always follows the projection, so a row
 * never jumps position because it gained a wire or got expensive.
 *
 * A block with nothing in it is not returned at all. That is the whole point:
 * two thirds of cards have no behaviours, and a permanently empty "behaviours"
 * station was the loudest thing on the old canvas.
 */
export function buildBoard(graph: CardGraph, opts: BuildBoardOptions = {}): Block[] {
  const wired = wiredNodeIds(graph);
  const forced = opts.forced ?? new Set<string>();
  const preferred = opts.preferred ?? new Set<string>();
  const expanded = opts.expanded ?? new Set<string>();

  let world: GraphNode | undefined;
  let frontend: GraphNode | undefined;
  /** A bucket member: the object, and whether it is the card's own drawn
   *  inside a module. */
  type Member = { g: GraphNode; shared: boolean };
  /** owner ("" = the card) → its members, by kind. */
  const byOwner = new Map<
    string,
    {
      openings: Member[];
      lore: Map<EntryTrigger, Member[]>;
      variables: Member[];
      behaviors: Member[];
      audio: Member[];
      images: Member[];
    }
  >();
  const bucket = (owner: string) => {
    let b = byOwner.get(owner);
    if (!b) {
      b = { openings: [], lore: new Map(), variables: [], behaviors: [], audio: [], images: [] };
      byOwner.set(owner, b);
    }
    return b;
  };
  // Every module's bucket exists before the first object comes past, so the
  // card's objects have every module to land in. Order inside a bucket is
  // still projection order — the buckets are filled in ONE pass below.
  const moduleNodes = graph.nodes.filter((n) => n.kind === "module");
  const moduleIds = moduleNodes.map((n) => n.id.slice("module:".length));
  const moduleData = new Map(moduleNodes.map((n) => [n.id.slice("module:".length), n.data]));
  for (const id of moduleIds) bucket(id);
  const hasModules = moduleIds.length > 0;
  const cardFrame = opts.cardFrame === true;
  // The card is a frame of its own when there are no modules — or always,
  // as the root module, when the caller asks (see `cardFrame`). Otherwise,
  // with modules, everything it owns is drawn inside every one of them and
  // there is nothing left to draw as "the card".
  if (!hasModules || cardFrame) bucket("");

  /** Where a piece of lore / state / behaviour lands.
   *
   *  Its own module, when it has one. Otherwise it is the card's — and on a
   *  card with modules that means EVERY module, because that is what the
   *  runtime does with it: whichever module is narrating, the card's own
   *  entries and variables are in the prompt. Drawing them in a fifth box
   *  called "the card" made a dungeon look like one entry and one variable
   *  when its AI receives five of each. */
  /** Loose: the card's, but not yet placed — drawn once, alone, outside the
   *  frames, until the creator drags it into a module or sends it to all. */
  const looseIds = opts.loose ?? new Set<string>();
  // Outside every frame: not placed yet, so in play nowhere (drawn faded).
  const isLoose = (n: GraphNode) => ownerOf(n) === UNPLACED_WORLDBOOK_ID || (hasModules && ownerOf(n) === undefined && looseIds.has(n.id));
  const looseNodes: GraphNode[] = [];

  const homes = (n: GraphNode): Array<{ owner: string; shared: boolean }> => {
    const owner = ownerOf(n);
    if (owner !== undefined) return [{ owner, shared: false }];
    if (!hasModules) return [{ owner: "", shared: false }];
    // The root module owns the row; every module still counts it.
    if (cardFrame) return [{ owner: "", shared: false }, ...moduleIds.map((id) => ({ owner: id, shared: true }))];
    return moduleIds.map((id) => ({ owner: id, shared: true }));
  };

  for (const n of graph.nodes) {
    switch (n.kind) {
      case "world":
        world = n;
        break;
      // An opening is the card's — a module cannot have one — and so, with
      // modules, it is in every module: the player reads it whichever
      // module is on.
      case "greeting":
        for (const h of homes(n)) bucket(h.owner).openings.push({ g: n, shared: h.shared });
        break;
      case "entry": {
        if (isLoose(n)) {
          looseNodes.push(n);
          break;
        }
        const t = triggerOfNode(n);
        for (const h of homes(n)) {
          const b = bucket(h.owner);
          const list = b.lore.get(t);
          const m = { g: n, shared: h.shared };
          if (list) list.push(m);
          else b.lore.set(t, [m]);
        }
        break;
      }
      case "variable":
        if (isLoose(n)) {
          looseNodes.push(n);
          break;
        }
        for (const h of homes(n)) bucket(h.owner).variables.push({ g: n, shared: h.shared });
        break;
      case "rule":
        if (isLoose(n)) {
          looseNodes.push(n);
          break;
        }
        for (const h of homes(n)) bucket(h.owner).behaviors.push({ g: n, shared: h.shared });
        break;
      // An event source is not a thing a creator made or can edit — its whole
      // content is "this is what fires that behaviour". As a row of its own it
      // said nothing; the behaviour it triggers carries it instead. It still
      // needs a host so the wires it anchors are never orphaned.
      case "event":
        break;
      // A track plays whichever module is on, so the card's are in every
      // module like its lore; a module's own stay with it.
      case "audio":
        for (const h of homes(n)) bucket(h.owner).audio.push({ g: n, shared: h.shared });
        break;
      // Scene images travel exactly like tracks: the card's are in every
      // module as a count, rows only on the card itself.
      case "image":
        for (const h of homes(n)) bucket(h.owner).images.push({ g: n, shared: h.shared });
        break;
      // One frontend per card. Without modules it is the card's own block;
      // with modules it is the head of every module's scene block.
      case "component":
        frontend = n;
        break;
      // The module is the frame itself, not a member of one; its bucket was
      // made above.
      case "module":
        break;
    }
  }

  const list = (
    id: string,
    kind: "lore" | "state" | "behavior" | "audio" | "image" | "opening",
    all: Member[],
    ownerId: string | undefined,
    trigger?: EntryTrigger,
  ): Block | null => {
    // Beside the card's frame a situation is a place of its own, laid out
    // like the card: its settings, variables and behaviours are drawn even
    // empty, as the shelves to fill ("where are its variables?").
    const shelf = cardFrame && ownerId !== undefined && (kind === "state" || kind === "behavior" || (kind === "lore" && trigger === "always"));
    if (all.length === 0 && !shelf) return null;
    const limit = opts.rowLimits?.[kind] ?? BLOCK_ROW_LIMIT[kind];
    const mustShow = (m: Member) => wired.has(m.g.id) || forced.has(m.g.id);
    // With a root module on the board the card's objects have rows THERE;
    // in a module they are the count in the block's header, not rows.
    const listed = cardFrame ? all.filter((m) => !m.shared) : all;

    let shown: Member[];
    if (expanded.has(id) || listed.length <= limit) {
      shown = listed;
    } else {
      const must = listed.filter(mustShow);
      const room = limit - must.length;
      const rest = listed.filter((m) => !mustShow(m));
      const fill =
        room <= 0
          ? []
          : [...rest.filter((m) => preferred.has(m.g.id)), ...rest.filter((m) => !preferred.has(m.g.id))].slice(0, room);
      const keep = new Set([...must, ...fill].map((m) => m.g.id));
      shown = listed.filter((m) => keep.has(m.g.id));
    }

    return {
      id,
      kind,
      ...(ownerId ? { ownerId } : {}),
      headSlots: [],
      ...(trigger ? { trigger } : {}),
      rows: shown.map((m) => ({ g: m.g, slots: slotsOf(m.g), ...(m.shared ? { shared: true } : {}) })),
      hiddenCount: listed.length - shown.length,
      total: all.length,
      sharedCount: all.filter((m) => m.shared).length,
    };
  };

  const blocks: Block[] = [];

  for (const [owner, b] of byOwner) {
    const ownerId = owner || undefined;

    // The card's face comes first and never folds: it is the one block every
    // card has, and on a card with nothing else it is the whole canvas.
    if (!ownerId && world) {
      blocks.push({ id: blockId.card, kind: "card", head: world, headSlots: [], rows: [], hiddenCount: 0, total: 1, sharedCount: 0 });
      // Stands under the face, empty or not — the same reason a module's
      // shelves are drawn at zero. A slot a creator can see is a slot they
      // can fill; one that appears only once it has content is one they
      // never learn about.
      blocks.push({ id: blockId.background, kind: "background", head: world, headSlots: [], rows: [], hiddenCount: 0, total: 1, sharedCount: 0 });
    }

    if (ownerId) {
      // Inside a module the openings are a list, like its lore: the card's
      // openings drawn as shared rows, in every module. Not when the card is
      // its own frame: its openings are right there, and the same opening
      // drawn again in every module read as a new one appearing out of
      // nowhere ("where did this second opening come from?").
      const openingBlock = cardFrame ? undefined : list(blockId.openings(ownerId), "opening", b.openings, ownerId);
      if (openingBlock) blocks.push(openingBlock);
    } else {
      // On the card itself, one block per opening showing its text. A card
      // averages one and the busiest in the library has ten, so there is no
      // fold to design here.
      for (const m of b.openings) {
        blocks.push({
          id: blockId.opening(m.g.id.slice("greeting:".length)),
          kind: "opening",
          head: m.g,
          headSlots: [],
          rows: [],
          hiddenCount: 0,
          total: 1,
          sharedCount: 0,
        });
      }
    }

    for (const trigger of ENTRY_TRIGGER_ORDER) {
      const block = list(blockId.lore(trigger, ownerId), "lore", b.lore.get(trigger) ?? [], ownerId, trigger);
      if (block) blocks.push(block);
    }

    const behaviorBlock = list(blockId.behavior(ownerId), "behavior", b.behaviors, ownerId);
    if (behaviorBlock) blocks.push(behaviorBlock);

    const stateBlock = list(blockId.state(ownerId), "state", b.variables, ownerId);
    if (stateBlock) blocks.push(stateBlock);

    // On a card with a frontend, every module has a face: the scene its
    // interface shows while it is on. The one interface is the block's head
    // — its variable ports are here to wire to — and the block names the
    // module's scene file, shows the live preview while this module is the
    // one being previewed, and opens the file.
    // Beside the card's own frame, only a module given a scene file of its
    // own shows one: the empty "no interface of its own" box in every new
    // module was one more thing nobody knew what to do with.
    if (ownerId && frontend && (!cardFrame || moduleData.get(ownerId)?.frontendFile)) {
      blocks.push({
        id: blockId.scene(ownerId),
        kind: "scene",
        ownerId,
        head: frontend,
        headSlots: slotsOf(frontend),
        rows: [],
        hiddenCount: 0,
        total: 1,
        sharedCount: 0,
      });
    }

    // Every module has a memory, so every module frame gets the block that
    // says what it is — empty or not, the same way a module's shelves are
    // always drawn. The card gets none: with no modules there is one AI and
    // one memory and nothing to say, and with modules the card is not a
    // frame any more — each module's block already names who it shares its
    // memory with.
    if (ownerId) {
      blocks.push({
        id: blockId.context(ownerId),
        kind: "context",
        ownerId,
        headSlots: [],
        rows: [],
        hiddenCount: 0,
        total: 0,
        sharedCount: 0,
      });
    }

    if (!ownerId && frontend) {
      blocks.push({
        id: blockId.frontend,
        kind: "frontend",
        head: frontend,
        headSlots: slotsOf(frontend),
        rows: [],
        hiddenCount: 0,
        total: 1,
        sharedCount: 0,
      });
    }

    const audioBlock = list(blockId.audio(ownerId), "audio", b.audio, ownerId);
    if (audioBlock) blocks.push(audioBlock);

    const imageBlock = list(blockId.image(ownerId), "image", b.images, ownerId);
    if (imageBlock) blocks.push(imageBlock);
  }

  // Loose objects last: one block each, in no frame, wearing the kind of
  // block the object would be a row of once placed.
  for (const n of looseNodes) {
    const kind = n.kind === "entry" ? "lore" : n.kind === "variable" ? "state" : "behavior";
    blocks.push({
      id: blockId.loose(n.id),
      kind,
      headSlots: [],
      ...(kind === "lore" ? { trigger: triggerOfNode(n) } : {}),
      rows: [{ g: n, slots: slotsOf(n) }],
      hiddenCount: 0,
      total: 1,
      sharedCount: 0,
      loose: true,
    });
  }

  return blocks;
}

/**
 * The blocks, gathered into the frames the canvas draws.
 *
 * The card's frame comes first and every module follows in projection order,
 * so the shape on screen matches the shape in the file. A module with nothing
 * in it still gets a frame: an empty module is a thing the creator made and
 * has not filled yet, and hiding it would hide the place to put things.
 */
export function buildFrames(graph: CardGraph, blocks: Block[], cardFrame = false): Frame[] {
  const modules = graph.nodes.filter((n) => n.kind === "module");
  const moduleFrames: Frame[] = [];
  const byOwner = new Map<string, Frame>();
  for (const m of modules) {
    const ownerId = m.id.slice("module:".length);
    const frame: Frame = { id: blockId.frame(ownerId), ownerId, module: m, blocks: [], total: 0, own: 0, shared: 0, strip: false };
    moduleFrames.push(frame);
    byOwner.set(ownerId, frame);
  }
  // With modules on the board everything the card owns is drawn inside every
  // one of them, so the card is not a frame: there are only the modules. The
  // card's frame exists when there are no modules — and, as a strip, when a
  // block has no module to be in (its module vanished mid-edit): an orphan
  // you can see is one you can re-home.
  // With `cardFrame` (see BuildBoardOptions) the card is the root module: a
  // real frame, first on the board, whatever else is there.
  let card: Frame | null = null;
  const theCard = () =>
    (card ??= { id: blockId.frame(null), ownerId: null, module: null, blocks: [], total: 0, own: 0, shared: 0, strip: modules.length > 0 && !cardFrame });
  if (modules.length === 0 || cardFrame) theCard();
  for (const b of blocks) {
    // A loose block is in no frame: it stands on the canvas by itself.
    if (b.loose) continue;
    const frame = b.ownerId ? byOwner.get(b.ownerId) : undefined;
    (frame ?? theCard()).blocks.push(b);
  }
  const frames = card ? [card, ...moduleFrames] : moduleFrames;
  for (const f of frames) {
    f.total = f.blocks.reduce((n, b) => n + b.total, 0);
    f.shared = f.blocks.reduce((n, b) => n + b.sharedCount, 0);
    f.own = f.total - f.shared;
  }
  return frames;
}

/** The block an object belongs to, whether or not it is currently on screen.
 *  Kept beside `buildBoard` so the two can never disagree about where an
 *  object lives. */
export function blockIdForNode(g: GraphNode, inOwner?: string): string | null {
  // An object's block lives inside its module's frame, so the owner is part of
  // the address. Getting this wrong would point a folded row's wires at a
  // block in somebody else's module.
  //
  // A core object is drawn in every module, so asking about it INSIDE a given
  // module (`inOwner`) answers with that module's block. An object that has
  // a module of its own is not re-homed by asking.
  const home = ownerOf(g);
  const owner = home ?? inOwner;
  switch (g.kind) {
    case "world": return blockId.card;
    // Inside a module an opening is a row of that module's openings block;
    // on a card without modules each opening is a block of its own.
    case "greeting": return inOwner ? blockId.openings(inOwner) : blockId.opening(g.id.slice("greeting:".length));
    case "entry": return blockId.lore(triggerOfNode(g), owner);
    case "variable": return blockId.state(owner);
    case "rule":
    case "event": return blockId.behavior(owner);

    // One frontend per card: inside a module it is the head of that
    // module's scene block, otherwise the card's own interface block.
    case "component": return inOwner ? blockId.scene(inOwner) : blockId.frontend;
    case "audio": return blockId.audio(owner);
    case "image": return blockId.image(owner);
    // A module is its own frame, not a member of any block.
    case "module": return null;
    default: return null;
  }
}

export interface BlockHost {
  host: string;
  /** Whether the object has a row (and so a handle) of its own there. A
   *  folded row has none, so its wires re-anchor onto the block's head —
   *  folding must never silently drop a wire. */
  shown: boolean;
  /** The module whose frame the host block sits in. Absent on the card's. */
  ownerId?: string;
}

/** Which kinds the card shares into every module: everything it owns. The
 *  world node is the one exception — it is not drawn anywhere on a card
 *  with modules, and a module is a frame, not a member. */
const isSharedKind = (g: GraphNode) => g.kind !== "world" && g.kind !== "module";

/**
 * Every block that renders a given object, in module order.
 *
 * One object, several hosts: the card's own entry is a row in every module's
 * frame, and a wire touching it has to know which frame it is being drawn in.
 * Each host names its frame, and says whether the object is on screen THERE —
 * the fold is per block, so a row can be shown in one module and folded in
 * another.
 */
export function blockHostsMap(blocks: Block[], graph: CardGraph): Map<string, BlockHost[]> {
  const map = new Map<string, BlockHost[]>();
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const shownIn = new Map<string, Set<string>>();
  for (const b of blocks) {
    const ids = new Set<string>();
    if (b.head) ids.add(b.head.id);
    for (const row of b.rows) ids.add(row.g.id);
    shownIn.set(b.id, ids);
  }
  const moduleIds = graph.nodes.filter((n) => n.kind === "module").map((n) => n.id.slice("module:".length));

  for (const n of graph.nodes) {
    if (n.kind === "module") continue;
    // A loose object lives on its own block, and nowhere else.
    const looseHost = blockId.loose(n.id);
    if (byId.has(looseHost)) {
      map.set(n.id, [{ host: looseHost, shown: true }]);
      continue;
    }
    // A card object with a block of its own (the root module's) is hosted
    // there first; the modules it is counted in come after, so a wire to it
    // lands on the row that is actually drawn.
    const ownHost = blockIdForNode(n);
    const candidates =
      ownerOf(n) === undefined && moduleIds.length > 0 && isSharedKind(n)
        ? [...(ownHost && byId.has(ownHost) ? [ownHost] : []), ...moduleIds.map((m) => blockIdForNode(n, m))]
        : [ownHost];
    for (const host of candidates) {
      if (!host) continue;
      const block = byId.get(host);
      // A block that produced no rows at all is not on the canvas; an object
      // that would live there has nowhere to anchor, and its wires are
      // dropped rather than pointed at a node that does not exist.
      if (!block) continue;
      const entry: BlockHost = {
        host,
        shown: shownIn.get(host)!.has(n.id),
        ...(block.ownerId ? { ownerId: block.ownerId } : {}),
      };
      const list = map.get(n.id);
      if (list) list.push(entry);
      else map.set(n.id, [entry]);
    }
  }
  return map;
}

/** The first block that renders each object — enough for callers that want
 *  one answer (selection, reveal). Wires go through `blockHostsMap`. */
export function blockHostMap(blocks: Block[], graph: CardGraph): Map<string, BlockHost> {
  const map = new Map<string, BlockHost>();
  for (const [id, hosts] of blockHostsMap(blocks, graph)) {
    if (hosts[0]) map.set(id, hosts[0]);
  }
  return map;
}
