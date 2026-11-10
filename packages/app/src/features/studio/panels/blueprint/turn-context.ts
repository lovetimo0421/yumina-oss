import {
  activeNarrator, resolveHistoryLimit,
  computeActiveWorldbookIds,
  estimateTokens,
  GameStateManager,
  filterEntriesByActiveLoreSlots,
  filterEntriesByActiveWorldbooks,
  isAiReadable,
  isVariableBoundEntry,
  resolveStation,
  type GameState,
  type WorldDefinition,
  type Worldbook,
} from "@yumina/engine";

/**
 * A configuration estimate, evaluated against initial or current game state.
 * Uses the engine's activation gates but does not rebuild a sent prompt:
 * message matching, token budgets, interpolation, history and memory differ.
 */

const tokenCache = new Map<string, number>();
function cachedTokens(text: string): number {
  if (!text) return 0;
  const hit = tokenCache.get(text);
  if (hit !== undefined) return hit;
  const n = estimateTokens(text);
  if (tokenCache.size > 4000) tokenCache.clear();
  tokenCache.set(text, n);
  return n;
}

export interface TurnSource {
  /** null = the card's core, which belongs to no module. */
  id: string | null;
  name: string;
  alwaysEntries: number;
  alwaysTokens: number;
  vars: number;
  varTokens: number;
}

export interface TurnContextView {
  /** True when a playtest session is driving this, so the gates are real
   *  rather than read off the variables' defaults. */
  live: boolean;
  /** The module answering the player, when one has taken over. */
  narrator: { id: string; name: string } | null;
  /** Everything switched on this turn, core first. */
  on: TurnSource[];
  /** Modules that are off right now — the point of the whole feature. */
  off: Array<{ id: string; name: string }>;
  /** Entries inside active sources that are still waiting for a keyword or a
   *  condition. They may or may not be in this turn; only the words said can
   *  decide, so they are counted, never claimed. */
  standby: number;
  /** The same total, split the way the board is split, so the bar's colours
   *  are the block headers' colours and no legend is needed to read it. */
  byKind: { presets: number; lore: number; variables: number };
  /** The single most expensive always-on entry. "Your context is heavy" is
   *  not actionable; "『世界观』alone is 320" is. */
  heaviest: { name: string; tokens: number } | null;
  /** History the narrator was told to carry in from elsewhere. */
  imports: Array<{ fromName: string; kind: string; as: "history" | "lore"; missing: boolean }>;
  /** The author's history window for this turn: null = everything the
   *  budget allows; otherwise the latest N messages, and who said so. */
  history: { limit: number; source: "module" | "card" } | null;
  total: number;
}

/** Authored defaults, before a particular opening or player input is chosen. */
export function defaultStateFor(world: WorldDefinition): GameState {
  return new GameStateManager(world).getSnapshot();
}

export function turnContextView(
  world: WorldDefinition,
  state: GameState,
  live: boolean,
): TurnContextView {
  const books: Worldbook[] = world.worldbooks ?? [];
  const activeIds = computeActiveWorldbookIds(books, state);
  const narratorBook = activeNarrator(books, activeIds);
  const knownBooks = new Set(books.map((book) => book.id));
  // Match the engine's orphan fail-open policy: deleted owners become core.
  const ownerOf = (id: string | undefined) => id && knownBooks.has(id) ? id : null;
  const eligibleEntries = filterEntriesByActiveLoreSlots(
    filterEntriesByActiveWorldbooks(world.entries ?? [], books, state),
    world.loreUiBindings,
    state,
  ).filter((entry) => entry.role !== "greeting" &&
    (state.ruleState?.toggledEntries?.[entry.id] ?? entry.enabled !== false));
  // Keywords do not override alwaysSend. Variable-bound entries, including
  // explicit variableBound with no conditions, take a separate engine path.
  const isAlwaysOn = (entry: (typeof eligibleEntries)[number]) =>
    Boolean(entry.alwaysSend) && !isVariableBoundEntry(entry);
  const frontendBound = new Set((world.loreUiBindings ?? []).map((binding) => binding.entryId));

  const sourceFor = (id: string | null, name: string): TurnSource => {
    const src: TurnSource = { id, name, alwaysEntries: 0, alwaysTokens: 0, vars: 0, varTokens: 0 };
    for (const e of eligibleEntries) {
      if (ownerOf(e.worldbookId) !== id) continue;
      if (!isAlwaysOn(e)) continue;
      src.alwaysEntries += 1;
      const entryTokens = cachedTokens(e.content ?? "");
      src.alwaysTokens += entryTokens;
      // The official narrative presets are a separate block on the board, so
      // they are a separate segment here — otherwise "lore" carries 1.4k an
      // author never wrote and cannot find.
      if (e.presetId) byKind.presets += entryTokens;
      else byKind.lore += entryTokens;
      if (!heaviest || entryTokens > heaviest.tokens) heaviest = { name: e.name, tokens: entryTokens };
    }
    for (const v of world.variables ?? []) {
      if (ownerOf(v.worldbookId) !== id) continue;
      if (!isAiReadable(v, state, books)) continue;
      src.vars += 1;
      const current = (state.variables as Record<string, unknown>)?.[v.id] ?? v.defaultValue;
      const value = typeof current === "object" ? JSON.stringify(current) : String(current ?? "");
      const varTokens = cachedTokens(`${v.name}: ${value}`);
      src.varTokens += varTokens;
      byKind.variables += varTokens;
    }
    return src;
  };

  // Split by what the author sees on the board, not by module: a creator
  // looking at a heavy turn wants to know which BLOCK to go trim.
  const byKind = { presets: 0, lore: 0, variables: 0 };
  let heaviest: { name: string; tokens: number } | null = null;

  const on: TurnSource[] = [sourceFor(null, "")];
  const off: Array<{ id: string; name: string }> = [];
  for (const b of books) {
    if (b.enabled !== false && activeIds.has(b.id)) on.push(sourceFor(b.id, b.name));
    else off.push({ id: b.id, name: b.name });
  }

  // Standby entries only count where they could actually fire: an entry inside
  // a module that is off is not waiting, it is gone.
  let standby = 0;
  for (const e of eligibleEntries) {
    if (!isAlwaysOn(e) && (isVariableBoundEntry(e) || e.keywords.length > 0 || frontendBound.has(e.id))) standby += 1;
  }

  const byId = new Map(books.map((b) => [b.id, b]));
  const station = narratorBook ? resolveStation(narratorBook) : null;
  const imports = (station?.inputs ?? []).map((input) => ({
    fromName: input.from === "core" ? "" : (byId.get(input.from)?.name ?? input.from),
    kind: input.kind,
    as: (input.as ?? "history") as "history" | "lore",
    missing: input.from !== "core" && !byId.has(input.from),
  }));

  const limit = resolveHistoryLimit(world, activeIds);
  const history = limit === undefined
    ? null
    : { limit, source: (station?.historyLimit ? "module" : "card") as "module" | "card" };

  return {
    live,
    narrator: narratorBook ? { id: narratorBook.id, name: narratorBook.name } : null,
    on,
    off,
    standby,
    byKind,
    heaviest,
    imports,
    history,
    total: on.reduce((n, s) => n + s.alwaysTokens + s.varTokens, 0),
  };
}
