import type { WorldDefinition, WorldGame } from "@yumina/engine";

/**
 * A card that is a character inside someone else's game. The game hands the
 * AI its state every turn and reads a few answers back; both sides go by the
 * variable's id, so a renamed id is a game that silently stops talking to
 * its NPC. The board marks those variables so the author can see which ones
 * the game owns.
 *
 * Two ways a card says so:
 * - it declares it (`game: { name, inputs, outputs }`), which any mod can
 *   read — the card says which variables its game writes and which it reads
 *   back, and the author sets that on each variable;
 * - it is a SpireTalk card (`spiretalk: { npc, kind }`), whose ids are what
 *   SpireTalkCode injects and reads (tools/build-cards.mjs in the mod), fixed
 *   here because those cards predate the declaration.
 */
export interface GameInterface {
  /** i18n key of the game's name (a built-in game). */
  gameKey?: string;
  /** The game's name as the card declares it. */
  gameName?: string;
  /** Written by the game before every turn; the value on the card is only
   *  what a playtest starts from. */
  inputs: ReadonlySet<string>;
  /** Written by the AI, read back by the game after the reply. */
  outputs: ReadonlySet<string>;
  /** Declared on the card, so the author edits it (variable by variable). */
  declared?: boolean;
}

const SPIRETALK: GameInterface = {
  gameKey: "blueprint.game.spiretalk",
  inputs: new Set([
    "language", "canon_language", "character", "character_id", "hp", "max_hp", "gold",
    "act", "act_index", "floor_in_act", "floor_total", "ascension", "players",
    "relics", "relic_count", "deck", "deck_size", "potions", "visits", "talks",
    "ancient_wins", "ancient_losses", "npc", "affection_source", "affection",
    "affection_tier", "married", "lines_left", "allowed_actions", "deal_offer",
    "deals", "keepsake", "shop_special",
  ]),
  outputs: new Set(["affection_delta", "choices", "action"]),
};

/** The card's `game` key, if it is an object (null switches it off). */
export function worldGameOf(world: Pick<WorldDefinition, "id">): WorldGame | null {
  const game = (world as { game?: unknown }).game;
  return game && typeof game === "object" && !Array.isArray(game) ? game as WorldGame : null;
}

/** A card that is an NPC in a game its mod runs: declared, not a page of ours. */
export function declaresGameInterface(game: WorldGame | null): boolean {
  return !!game && typeof game.path !== "string" && (Array.isArray(game.inputs) || Array.isArray(game.outputs));
}

export function gameInterfaceOf(world: Pick<WorldDefinition, "id">): GameInterface | null {
  const marker = (world as Record<string, unknown>).spiretalk;
  if (marker && typeof marker === "object") return SPIRETALK;
  const game = worldGameOf(world);
  if (!declaresGameInterface(game)) return null;
  const ids = (list: unknown) => new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
  return { gameName: game!.name?.trim() || undefined, inputs: ids(game!.inputs), outputs: ids(game!.outputs), declared: true };
}

type Translate = (key: string, opts?: Record<string, unknown>) => string;

/** The game's name for a sentence: its own, the built-in one, or "the game". */
export function gameNameOf(game: GameInterface, t: Translate): string {
  return game.gameName ?? (game.gameKey ? String(t(game.gameKey)) : String(t("blueprint.game.unnamed")));
}

/**
 * The card's `game` with one variable moved to a side of the game (or off
 * it). Ids stay in the order they were added; a variable is on one side.
 */
export function withGameSide(game: WorldGame, variableId: string, side: "in" | "out" | null): WorldGame {
  const without = (list: string[] | undefined) => (list ?? []).filter((id) => id !== variableId);
  const inputs = without(game.inputs);
  const outputs = without(game.outputs);
  if (side === "in") inputs.push(variableId);
  if (side === "out") outputs.push(variableId);
  return { ...game, inputs, outputs };
}

/**
 * What the player's screen is, on a card that is a game rather than a chat:
 * - `page`: the card opens a game page of ours full-frame (PvZ:
 *   `schema.game.path`, same-origin only, as chat-view plays it);
 * - `mod`: the card is an NPC inside a game that runs elsewhere (SpireTalk,
 *   or any game whose mod reads the card's declared interface).
 * The board shows that, not the stock chat a game card never displays.
 */
export type GameScreen =
  | { kind: "page"; path: string; cover?: string }
  | { kind: "mod"; game: GameInterface; npc?: string };

export function gameScreenOf(world: Pick<WorldDefinition, "id">): GameScreen | null {
  const schema = world as Record<string, unknown>;
  const path = worldGameOf(world)?.path;
  if (typeof path === "string" && path.startsWith("/") && !path.startsWith("//")) {
    // A game page ships its cover beside it (/pvz/cover.png). A folder path
    // is played as its index.html: the production server resolves /pvz/ by
    // itself, the dev server does not and answered the board with a 404.
    const [file, query] = path.split("?") as [string, string | undefined];
    const dir = file.replace(/[^/]*$/, "");
    const page = file.endsWith("/") ? `${file}index.html${query !== undefined ? `?${query}` : ""}` : path;
    return { kind: "page", path: page, cover: `${dir}cover.png` };
  }
  const game = gameInterfaceOf(world);
  if (!game) return null;
  const npc = (schema.spiretalk as { npc?: unknown } | undefined)?.npc;
  return { kind: "mod", game, ...(typeof npc === "string" ? { npc } : {}) };
}

/** Which side of the game a variable is on, if either. */
export function gameSide(game: GameInterface | null | undefined, variableId: string): "in" | "out" | null {
  if (!game) return null;
  if (game.inputs.has(variableId)) return "in";
  if (game.outputs.has(variableId)) return "out";
  return null;
}
