import {
  estimateTokens,
  resolveInputs,
  resolveStation,
  type ModuleContextInput,
  type WorldDefinition,
  type Worldbook,
  isAnyModule,
} from "@yumina/engine";

/**
 * What one module's AI actually receives.
 *
 * A module is an AI with its own memory and its own instructions — the same
 * model as everyone else, holding a different head. Inside dungeon A it reads
 * A's lore, A's variables and A's run; step into dungeon B and it reads B's,
 * plus whatever B was told to carry over from A. That asymmetry is the whole
 * point of modules, and until now the only way to see it was to read the
 * prompt builder.
 *
 * So this is the answer written down: for a given module, everything that
 * reaches its turn, where each piece comes from, and what it costs. It is a
 * STATIC estimate — activation depends on live state, so "what is on at the
 * same time as this" can only be answered for the modules that are always on.
 * Everything conditional is named as conditional rather than guessed at.
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

export interface ContextGroup {
  /** Entries that ride along on every single turn. */
  alwaysEntries: number;
  alwaysTokens: number;
  /** Entries that wait for a keyword or a condition — free until they hit. */
  standbyEntries: number;
  /** Variables the AI can read. Their values are re-injected every turn. */
  vars: number;
  varTokens: number;
  behaviors: number;
}

export interface ImportedContext {
  index: number;
  kind: "memory" | "worker" | "variables" | "transcript";
  fromId: string;
  /** This wire addresses a role ("every archive", "every other writer") rather
   *  than one module, so it has no source node and can never be missing. */
  anyModule: boolean;
  /** Resolved name, or the raw id when the source module is gone. */
  fromName: string;
  missing: boolean;
  as: "history" | "lore";
  limit?: number;
}

export interface ModuleContextView {
  /** This module's own lore, variables and behaviours. */
  own: ContextGroup;
  /** The card's un-moduled content — in every turn, whatever else is on. */
  core: ContextGroup;
  /** Other modules that are on no matter what, so they share every turn with
   *  this one. Conditional modules are deliberately absent: whether they
   *  overlap depends on state this panel cannot see. */
  alsoAlwaysOn: Array<{ id: string; name: string; alwaysTokens: number; vars: number }>;
  /** How many modules are gated, i.e. how much of the card is NOT here. */
  gatedElsewhere: number;
  /** Whether this module answers the player itself. */
  narrates: boolean;
  /** Narrators only: what happens to this run when the module closes. */
  onClose: "archive" | "keep" | null;
  /** Context drawn from other modules. Directional by construction: it is
   *  listed on the module doing the drinking, so "B reads A's run, A never
   *  reads B's" is two different panels rather than one shared setting. */
  imported: ImportedContext[];
  /** Rough per-turn floor: always-on lore + variable block + imports we can
   *  bound. Rendered with a "~" because that is what it is. */
  perTurnTokens: number;
}

const EMPTY_GROUP = (): ContextGroup => ({
  alwaysEntries: 0,
  alwaysTokens: 0,
  standbyEntries: 0,
  vars: 0,
  varTokens: 0,
  behaviors: 0,
});

/** Mirrors the engine's AI-visibility gate closely enough for an estimate;
 *  the real one also consults live state, which is why every number here is
 *  shown with a "~". */
const aiReadable = (v: { internal?: boolean; aiAccess?: string }) =>
  !v.internal && (v.aiAccess ?? "write") !== "none";

/** An entry rides every turn only when nothing gates it. */
const isAlwaysOn = (e: { alwaysSend?: boolean; keywords?: unknown[] | null; conditions?: unknown[] | null }) =>
  Boolean(e.alwaysSend) && (e.keywords?.length ?? 0) === 0 && (e.conditions?.length ?? 0) === 0;

function groupFor(world: WorldDefinition, bookId: string | undefined): ContextGroup {
  const g = EMPTY_GROUP();
  for (const e of world.entries ?? []) {
    if ((e.worldbookId || undefined) !== bookId) continue;
    if (e.role === "greeting") continue;
    if (e.enabled === false) continue;
    if (isAlwaysOn(e)) {
      g.alwaysEntries += 1;
      g.alwaysTokens += cachedTokens(e.content ?? "");
    } else {
      g.standbyEntries += 1;
    }
  }
  for (const v of world.variables ?? []) {
    if ((v.worldbookId || undefined) !== bookId) continue;
    if (!aiReadable(v)) continue;
    g.vars += 1;
    // The engine renders one `name: value` line per variable into
    // <game-state>. Estimating off the default is the best a static read can
    // do — the live value is whatever the playthrough made it.
    g.varTokens += cachedTokens(`${v.name}: ${String(v.defaultValue ?? "")}`);
  }
  for (const r of world.reactions ?? []) {
    if ((r.worldbookId || undefined) !== bookId) continue;
    g.behaviors += 1;
  }
  return g;
}

export function moduleContextView(world: WorldDefinition, book: Worldbook): ModuleContextView {
  const books = world.worldbooks ?? [];
  const byId = new Map(books.map((b) => [b.id, b]));
  const own = groupFor(world, book.id);
  const core = groupFor(world, undefined);
  const station = resolveStation(book);

  const alsoAlwaysOn: ModuleContextView["alsoAlwaysOn"] = [];
  let gatedElsewhere = 0;
  for (const other of books) {
    if (other.id === book.id) continue;
    if (other.enabled === false) continue;
    if (other.activation.mode === "always") {
      const g = groupFor(world, other.id);
      alsoAlwaysOn.push({ id: other.id, name: other.name, alwaysTokens: g.alwaysTokens, vars: g.vars });
    } else {
      gatedElsewhere += 1;
    }
  }

  const imported: ImportedContext[] = (station?.inputs ?? []).map((input, index) => {
    const any = isAnyModule(input.from);
    const source = input.from === "core" || any ? undefined : byId.get(input.from);
    return {
      index,
      kind: input.kind,
      fromId: input.from,
      anyModule: any,
      fromName: input.from === "core" || any ? "" : (source?.name ?? input.from),
      missing: input.from !== "core" && !any && !source,
      as: input.as ?? "history",
      ...("limit" in input && typeof input.limit === "number" ? { limit: input.limit } : {}),
    };
  });

  const perTurnTokens =
    own.alwaysTokens +
    own.varTokens +
    core.alwaysTokens +
    core.varTokens +
    alsoAlwaysOn.reduce((n, m) => n + m.alwaysTokens, 0);

  return {
    own,
    core,
    alsoAlwaysOn,
    gatedElsewhere,
    narrates: station?.kind === "narrator",
    onClose: station?.kind === "narrator" ? station.onClose : null,
    imported,
    perTurnTokens,
  };
}


/* ── who reads whom ──────────────────────────────────────────────────────
 *
 * A context wire is DECLARED on the module doing the reading: B says "I take
 * A's run". Which means A's own panel said nothing at all about it — stand on
 * A and you could not tell that anyone was reading you, and the asymmetry the
 * whole module model exists for ("B sees A, A never sees B") could only be
 * checked by opening both panels and comparing them by hand.
 *
 * So a link is computed from BOTH sides and carries its direction. Reading and
 * being read are the same edge seen from two ends, and when both ends declare
 * one, that is 互通 — one symbol, not two panels.
 *
 * What the engine actually guarantees, because these labels have to be true:
 *   · One hop. `buildInputBlocksFor` walks a station's own inputs and does not
 *     recurse, so A→B→C leaves C without A. Named here as `indirect` so the
 *     panel can say so instead of letting the creator assume a chain.
 *   · No cycles to fear. At most one narrator reads per turn (`activeNarrator`),
 *     so A⇄B is two wires that fire on different turns, never a loop.
 *   · Only a station has inputs at all; a plain module is content that joins
 *     whoever is narrating.
 */

export type ContextRole = "narrator" | "worker" | "plain";
export type LinkDirection = "in" | "out" | "both";

export interface ContextFlow {
  kind: ModuleContextInput["kind"];
  as: "history" | "lore";
  limit?: number;
}

export interface ContextLink {
  /** "core" means the card itself, which can be read but never reads. */
  otherId: string;
  otherName: string;
  dir: LinkDirection;
  /** What this module draws FROM the other. */
  reads: ContextFlow[];
  /** What the other draws from THIS module. */
  gives: ContextFlow[];
  /** The wire points at a module that no longer exists. */
  missing: boolean;
}

export interface ContextBadge {
  role: ContextRole;
  /** Narrators only: whether this module's run is sealed off when it closes.
   *  "archive" is what makes "inside A you only have A's messages" true. */
  ownRun: "archive" | "keep" | null;
  links: ContextLink[];
  /** Sources this module reads THROUGH another module and therefore does not
   *  actually get. The chain trap, named. */
  indirect: Array<{ viaName: string; sourceName: string }>;
}

const flowOf = (input: ModuleContextInput): ContextFlow => {
  // `limit` belongs to some variants and not others, and only `transcript`
  // requires it.
  const limit = "limit" in input ? input.limit : undefined;
  return {
    kind: input.kind,
    as: input.as === "lore" ? "lore" : "history",
    ...(typeof limit === "number" ? { limit } : {}),
  };
};

/** Rank so the eye meets the mutual ones first — those are the ones a creator
 *  is checking for. */
const DIR_RANK: Record<LinkDirection, number> = { both: 0, in: 1, out: 2 };

export function contextBadgeFor(book: Worldbook, allBooks: Worldbook[]): ContextBadge {
  const station = resolveStation(book);
  const byId = new Map(allBooks.map((b) => [b.id, b]));
  const links = new Map<string, ContextLink>();
  const nameOf = (id: string) => (id === "core" ? "core" : byId.get(id)?.name ?? id);

  const link = (otherId: string): ContextLink => {
    const found = links.get(otherId);
    if (found) return found;
    const fresh: ContextLink = {
      otherId,
      otherName: nameOf(otherId),
      dir: "in",
      reads: [],
      gives: [],
      missing: otherId !== "core" && !byId.has(otherId),
    };
    links.set(otherId, fresh);
    return fresh;
  };

  // Inbound: declared here. A role reference has no module on the other end,
  // so it is not a link — the console says it in words instead of drawing an
  // edge to a node that does not exist.
  for (const input of resolveInputs(book, allBooks)) {
    if (isAnyModule(input.from)) continue;
    link(input.from).reads.push(flowOf(input));
  }
  // Outbound: declared on the other module, about this one.
  for (const other of allBooks) {
    if (other.id === book.id) continue;
    for (const input of resolveInputs(other, allBooks)) {
      if (isAnyModule(input.from)) continue;
      if (input.from !== book.id) continue;
      link(other.id).gives.push(flowOf(input));
    }
  }
  for (const l of links.values()) {
    l.dir = l.reads.length && l.gives.length ? "both" : l.gives.length ? "out" : "in";
  }

  // One hop only: what the modules we read are themselves reading, which does
  // NOT arrive here. Reported so the panel can say it rather than let a chain
  // be assumed.
  const indirect: ContextBadge["indirect"] = [];
  for (const l of links.values()) {
    if (!l.reads.length || l.otherId === "core") continue;
    const via = byId.get(l.otherId);
    if (!via) continue;
    for (const upstream of resolveInputs(via, allBooks)) {
      if (isAnyModule(upstream.from)) continue;
      // What it reads off the card itself is not something to pass on.
      if (upstream.from === "core") continue;
      if (upstream.from === book.id) continue;
      if (links.has(upstream.from) && links.get(upstream.from)!.reads.length) continue;
      const sourceName = nameOf(upstream.from);
      if (indirect.some((x) => x.viaName === via.name && x.sourceName === sourceName)) continue;
      indirect.push({ viaName: via.name, sourceName });
    }
  }

  return {
    role: station && station.kind !== "custom" ? station.kind : "plain",
    ownRun: station?.kind === "narrator" ? station.onClose : null,
    links: [...links.values()].sort(
      (a, b) => DIR_RANK[a.dir] - DIR_RANK[b.dir] || a.otherName.localeCompare(b.otherName),
    ),
    indirect,
  };
}
