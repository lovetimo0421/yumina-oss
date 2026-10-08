import type { CardGraph, GraphNode, GraphEdge, GraphPort, GraphPatch } from "./types.js";
import type { WorldDefinition, Rule, RuleAction, TriggerConfig, Condition } from "../types/index.js";
import type { GameEvent } from "../events/types.js";
import { matchesEventPattern } from "../events/event-matcher.js";
import { extractLoreSlotsFromFiles } from "../lorebook/lore-slot-scan.js";
import { extractVariableReadsFromFiles } from "./variable-read-scan.js";
import { frontendManifest } from "./frontend-manifest.js";
import { uiDocVariableRefs } from "../ui-doc/variable-refs.js";
import { entryTrigger } from "./board.js";
import { isAnyModule, resolveInputs, resolveStation } from "../lorebook/station.js";
import { ruleShapeIssues } from "../reactions/compile-rule.js";
import { UNPLACED_WORLDBOOK_ID } from "../lorebook/worldbook.js";

/** Every field `toGraph` reads, as data.
 *
 *  The canvas memoises the projection on these instead of on the whole draft:
 *  depending on the draft object rebuilt the entire graph whenever anything
 *  else in the card changed — a dragged frame, a sticky-note keystroke, a tag.
 *  Exported so that list cannot drift from this one; the assertion below turns
 *  a field added to WorldLogic and forgotten here into a compile error. */
export const WORLD_LOGIC_KEYS = [
  "rules", "variables", "reactions", "entries", "worldbooks", "loreUiBindings",
  "rootComponent", "audioTracks", "sceneImages", "name", "description", "avatar", "uiDoc",
] as const;

/** The slice of a world the projection reads. Everything beyond rules/variables
 *  is optional so legacy callers (and pre-module cards) project unchanged. */
type WorldLogic = Pick<WorldDefinition, "rules" | "variables"> &
  Partial<Pick<WorldDefinition,
    "reactions" | "entries" | "worldbooks" | "loreUiBindings" | "rootComponent" |
    "audioTracks" | "sceneImages" | "name" | "description" | "avatar" | "uiDoc">>;

/** Compile error the moment WorldLogic gains a key WORLD_LOGIC_KEYS lacks —
 *  without it a new field would silently stop refreshing the canvas. The error
 *  names the missing key. Type-level only; nothing ships. */
type MissingLogicKey = Exclude<keyof WorldLogic, (typeof WORLD_LOGIC_KEYS)[number]>;
const _worldLogicKeysAreComplete: [MissingLogicKey] extends [never] ? true : MissingLogicKey = true;
void _worldLogicKeysAreComplete;

const OP_SYMBOL: Record<Condition["operator"], string> = {
  eq: "=", neq: "≠", gt: ">", gte: "≥", lt: "<", lte: "≤", contains: "∋",
};

function conditionLabel(c: Condition): string {
  const rhs = c.valueRef ? `{${c.valueRef}}` : JSON.stringify(c.value);
  return `${OP_SYMBOL[c.operator] ?? c.operator} ${rhs}`;
}

const EVENT_TRIGGERS = new Set(["keyword", "ai-keyword", "every-turn", "turn-count", "session-start", "action", "manual"]);

/** Which event-source node id (if any) a trigger originates from. */
function eventSourceId(t: TriggerConfig): string | null {
  switch (t.type) {
    case "keyword": case "ai-keyword": case "manual": case "action": return "evt:user";
    case "every-turn": case "turn-count": return "evt:turn";
    case "session-start": return "evt:session";
    default: return null; // state-change / variable-crossed wire from a variable
  }
}

const EVENT_TITLES: Record<string, string> = { "evt:user": "Player input", "evt:turn": "Each turn", "evt:session": "Session start" };

/** Persisted cards carry effect shapes this build has never compiled against —
 *  other branches, older engine versions, imports. The projection is total over
 *  arbitrary JSON on purpose: a throw here white-screens someone's Studio. */
function hasPath(eff: unknown): eff is { path: string } {
  return typeof (eff as { path?: unknown } | null)?.path === "string";
}

function port(id: string, type: GraphPort["type"], direction: GraphPort["direction"], label?: string): GraphPort {
  return label ? { id, type, direction, label } : { id, type, direction };
}

export interface ToGraphOptions {
  /** Entry ids that must stay individual nodes even with nothing wired to
   *  them. The canvas pins whatever it just created: an entry that folds into
   *  a summary node the instant it is born reads as "my edit didn't take". */
  pinnedEntryIds?: string[];
  /** Fold relationship-free entries into per-module summary nodes (default
   *  true). The rack canvas passes false: a rack already folds its own long
   *  tail behind "N more", and unlike a summary node those rows keep their
   *  names and stay one click from being edited. */
  foldPlainEntries?: boolean;
}

export function toGraph(world: WorldLogic, options?: ToGraphOptions): CardGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  /**
   * Event source → the frame it belongs in.
   *
   * An event source is not a thing the creator made; it exists to anchor the
   * "what fires this" wire, so it has to live wherever the behaviour it fires
   * lives. When every reaction listening for it belongs to one module, the
   * source belongs to that module too. Mixed listeners (or any card-level
   * one) put it on the card, which is safe because a card-level listener
   * guarantees the card has a behaviours block to anchor on.
   *
   * Leaving it unowned was a silent wire loss: a card whose only event-driven
   * behaviour sat inside a module built no card-level behaviours block, so the
   * source had no host and the board dropped the wire without a word.
   *
   * `undefined` = the card's own frame. The sentinel below distinguishes
   * "not seen yet" from "seen, belongs to the card".
   */
  const eventSources = new Map<string, string | undefined>();
  const UNSEEN = Symbol("unseen");
  const noteEventSource = (src: string, parentId: string | undefined) => {
    const seen: string | undefined | typeof UNSEEN = eventSources.has(src)
      ? eventSources.get(src)
      : UNSEEN;
    if (seen === UNSEEN) eventSources.set(src, parentId);
    else if (seen !== parentId) eventSources.set(src, undefined);
  };

  const worldbooks = world.worldbooks ?? [];
  const bookIds = new Set(worldbooks.map((b) => b.id));
  /** module:<id> when the member's book exists, undefined otherwise (orphans → Core). */
  const parentOf = (worldbookId: string | undefined): string | undefined =>
    worldbookId === UNPLACED_WORLDBOOK_ID ? `module:${UNPLACED_WORLDBOOK_ID}`
      : worldbookId && bookIds.has(worldbookId) ? `module:${worldbookId}` : undefined;
  const varIds = new Set((world.variables ?? []).map((v) => v.id));
  const varIdByName = new Map((world.variables ?? []).map((v) => [v.name, v.id]));
  const varNameById = new Map((world.variables ?? []).map((v) => [v.id, v.name]));

  /** Rules, read the way `hasPath` reads effects: totally. `world.rules` is
   *  raw JSON from a card that may predate this build, so walking it as the
   *  `Rule` type promises is how a missing `trigger` used to white-screen the
   *  whole Studio — and the author could not even reach the panel that would
   *  let them fix it. Every walk below goes through these two. */
  const ruleList: Rule[] = (Array.isArray(world.rules) ? world.rules : []).filter(
    (r): r is Rule => Boolean(r) && typeof r === "object",
  );
  const actionsOf = (r: Rule): RuleAction[] =>
    (Array.isArray(r.actions) ? r.actions : []).filter(
      (a): a is RuleAction => Boolean(a) && typeof a === "object",
    );

  const reactionList = world.reactions ?? [];
  // Entries targeted by a toggle effect/action participate in a relationship —
  // they must render as real nodes, not fold into the core-entries summary.
  const toggledEntryIds = new Set<string>();
  /** Events emitted by reaction effects — the sources of reaction chains. */
  const emits: Array<{ rid: string; idx: number; event: GameEvent }> = [];
  for (const r of reactionList) {
    (r.then ?? []).forEach((eff, idx) => {
      if (!eff) return;
      if (eff.type === "emit") {
        emits.push({ rid: r.id, idx, event: eff.event });
      } else if (hasPath(eff) && eff.path.startsWith("@prompt.entry.") && typeof eff.value === "boolean") {
        const eid = eff.path.slice("@prompt.entry.".length);
        if (eid) toggledEntryIds.add(eid);
      }
    });
  }
  for (const r of ruleList) {
    for (const a of actionsOf(r)) if (a.type === "toggle-entry") toggledEntryIds.add(a.entryId);
  }

  // ── what the frontend reads, and what can ever write it ──
  // Both are needed before the variable nodes exist, because a variable node
  // carries the answer to "is this readout dead?".
  const codeScan = world.rootComponent
    ? extractVariableReadsFromFiles(world.rootComponent.files)
    : { names: [], dynamicReads: 0, writes: [], dynamicWrites: 0 };
  // Code compiled from a UI doc reads through one id-keyed helper, which the
  // scan can only count as dynamic; the doc's own bindings name every read.
  const docRefs = world.uiDoc && world.rootComponent?.generatedFrom === "uiDoc"
    ? uiDocVariableRefs(world.uiDoc)
    : null;
  const uiScan = docRefs
    ? {
        names: [...new Set([...codeScan.names, ...docRefs.reads])],
        dynamicReads: 0,
        writes: [...new Set([...codeScan.writes, ...docRefs.writes])],
        dynamicWrites: 0,
      }
    : codeScan;
  /** Sandbox state is keyed by variable id, with the display name as the
   *  fallback — the same resolution order GameStateManager uses. */
  const resolveVarKey = (key: string): string | undefined =>
    varIds.has(key) ? key : varIdByName.get(key);
  const uiReadVarIds = new Set(uiScan.names.map(resolveVarKey).filter((v): v is string => Boolean(v)));

  const writtenVarIds = new Set<string>();
  for (const key of uiScan.writes) {
    const id = resolveVarKey(key);
    if (id) writtenVarIds.add(id);
  }
  for (const r of reactionList) {
    for (const eff of r.then ?? []) {
      if (!hasPath(eff)) continue;
      if (eff.path.startsWith("@")) continue; // system effects, not value writes
      const rootId = eff.path.split(".")[0]!;
      if (varIds.has(rootId)) writtenVarIds.add(rootId);
    }
  }
  for (const r of ruleList) {
    for (const a of actionsOf(r)) {
      if (a.type === "modify-variable" && varIds.has(a.variableId)) writtenVarIds.add(a.variableId);
    }
  }
  // A custom AI call routes its answer fields into variables.
  for (const b of world.worldbooks ?? []) {
    for (const f of b.station?.output ?? []) {
      if (f.to?.kind !== "variable") continue;
      const id = resolveVarKey(f.to.variableId);
      if (id) writtenVarIds.add(id);
    }
  }
  for (const e of world.entries ?? []) {
    for (const key of Object.keys(e.initialVariables ?? {})) {
      const id = resolveVarKey(key);
      if (id) writtenVarIds.add(id);
    }
  }
  /** A frontend that computes its write targets could write anything — never
   *  claim a variable is unwritten when we could not read the target. */
  const writesAreKnown = uiScan.dynamicWrites === 0;

  // ── the card itself ──
  // Not decoration: every opening hangs off this node, and switching openings
  // is a real runtime move. Double-clicking it opens the card's overview.
  // `avatar` is the schema mirror of worlds.thumbnailUrl that the editor store
  // keeps current — inside the editor it IS the live cover.
  nodes.push({
    id: "world:root", kind: "world", title: world.name ?? "",
    ports: [port("openings", "signal", "out")],
    data: {
      drillTarget: "overview",
      ...(world.description ? { description: world.description } : {}),
      ...(world.avatar ? { coverUrl: world.avatar } : {}),
    },
  });

  // ── module nodes (worldbooks) ──
  for (const b of worldbooks) {
    nodes.push({
      id: `module:${b.id}`, kind: "module", title: b.name,
      ports: [port("activate", "module", "in")],
      data: {
        worldbookId: b.id, activationMode: b.activation.mode, enabled: b.enabled !== false,
        // The sticky note rides the projection so the canvas can pin it to the
        // gate — spread only when present, so noteless worlds project unchanged.
        ...(b.note ? { note: b.note } : {}),
        ...(resolveStation(b) ? { station: resolveStation(b)!.kind } : {}),
        ...(b.frontendFile ? { frontendFile: b.frontendFile } : {}),
        // all/any only matters once several condition wires point here
        ...(b.activation.mode === "conditions" && b.activation.conditions.length > 1
          ? { conditionLogic: b.activation.conditionLogic }
          : {}),
      },
    });
  }

  // ── variable nodes ──
  const seenVarNodes = new Set<string>();
  // Scene images are card-level objects the AI reaches for on its own — no
  // behaviour has to fire them — so the board lists them the way it lists
  // variables: as what the model can see. `show` is there for a behaviour to
  // wire into later.
  // Audio tracks the same way. They used to appear only once a behaviour
  // named one, so a card with five uploaded tracks and no behaviour yet showed
  // an author nothing at all — the upload looked like it had failed. Every
  // track the card has is a row; a behaviour that plays it wires into `play`.
  for (const track of world.audioTracks ?? []) {
    nodes.push({
      id: `audio:${track.id}`, kind: "audio", title: track.name || track.id,
      ports: [port("play", "signal", "in")],
      data: { trackId: track.id, url: track.url, ...(track.type ? { trackType: track.type } : {}) },
    });
  }
  for (const img of world.sceneImages ?? []) {
    nodes.push({
      id: `image:${img.id}`, kind: "image", title: img.name || img.id,
      ports: [port("show", "signal", "in")],
      data: {
        sceneImageId: img.id,
        url: img.url,
        scene: img.scene,
        ...(img.allowAiControl === false ? { manual: true } : {}),
      },
    });
  }

  for (const v of world.variables ?? []) {
    // Variable ids are user-editable and were historically duplicable
    // (2026-07-10 community report) — two nodes sharing one id break React
    // keys and React Flow alike, so the first one wins.
    if (seenVarNodes.has(v.id)) continue;
    seenVarNodes.add(v.id);
    const readByUi = uiReadVarIds.has(v.id);
    // The AI writes any variable it is allowed to write, so "nothing writes
    // this" only means something when the AI is locked out too.
    const aiMayWrite = v.aiAccess !== "read" && v.aiAccess !== "none";
    const dead = readByUi && writesAreKnown && !aiMayWrite && !writtenVarIds.has(v.id);
    nodes.push({
      id: `var:${v.id}`, kind: "variable", title: v.name,
      ports: [port("write", "state", "in"), port("read", "state", "out")],
      parentId: parentOf(v.worldbookId),
      data: {
        variableId: v.id,
        ...(readByUi ? { readByUi: true } : {}),
        ...(dead ? { uiReadNeverWritten: true } : {}),
        // Declared parts of a json value: the inspector lists them, and a
        // frontend that reads the variable is read as reading these.
        ...(v.fields?.length ? { fields: v.fields } : {}),
      },
    });
  }

  // ── module activation wiring ──
  worldbooks.forEach((b) => {
    if (b.activation.mode === "conditions") {
      b.activation.conditions.forEach((c, i) => {
        if (!varIds.has(c.variableId)) return;
        edges.push({
          id: `e:var:${c.variableId}->module:${b.id}:${i}`,
          from: `var:${c.variableId}`, fromPort: "read",
          to: `module:${b.id}`, toPort: "activate",
          label: conditionLabel(c),
        });
      });
    } else if (b.activation.mode === "greeting") {
      for (const gid of b.activation.greetingIds) {
        edges.push({
          id: `e:greeting:${gid}->module:${b.id}`,
          from: `greeting:${gid}`, fromPort: "select",
          to: `module:${b.id}`, toPort: "activate",
        });
      }
    }
  });

  // ── context wiring: what one station draws from another ──
  //
  // These are the wires the whole station model exists to let a creator draw:
  // this dungeon's chronicler reads that dungeon, the next narrator reads the
  // chronicler. Derived from the modules themselves, so they are read-only on
  // the canvas and edited in the module console.
  worldbooks.forEach((b) => {
    for (const input of resolveInputs(b, worldbooks)) {
      // Core is the card, not a module — it has no node to draw a wire from.
      if (input.from === "core") continue;
      // Neither does "all of them": drawing one wire per answering module is
      // the twenty-one-wire picture the wildcard exists to replace, and a wire
      // from a node id that is not on the board is how the canvas goes blank.
      // The module console states it in words instead.
      if (isAnyModule(input.from)) continue;
      const mode = input.as === "lore" ? "lore" : "history";
      edges.push({
        id: `e:module:${input.from}->module:${b.id}:${input.kind}:${mode}`,
        from: `module:${input.from}`, fromPort: "governs",
        to: `module:${b.id}`, toPort: "activate",
        labelKey: `contextWire.${input.kind}.${mode}`,
      });
    }
  });

  // A worker's trigger is a relationship too: "when that module closes, I run".
  worldbooks.forEach((b) => {
    const trigger = resolveStation(b)?.trigger;
    if (trigger?.on !== "module-closed") return;
    if (trigger.from === b.id) return;
    // "Whoever just closed" has no single source node either — same reason.
    if (isAnyModule(trigger.from)) return;
    if (!worldbooks.some((other) => other.id === trigger.from)) return;
    edges.push({
      id: `e:module:${trigger.from}->module:${b.id}:trigger`,
      from: `module:${trigger.from}`, fromPort: "governs",
      to: `module:${b.id}`, toPort: "activate",
      labelKey: "contextWire.wakeOnClose",
    });
  });

  // ── entry + greeting nodes ──
  //
  // In the order the PROMPT will send them, not the order they happen to sit
  // in the array. PromptBuilder sorts by `position`; the projection walked the
  // array, so wherever the two had drifted the board showed the creator an
  // order the AI never sees. Stable within equal positions, so entries nobody
  // has ever ordered keep the order they were written in.
  const entries = (world.entries ?? [])
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.position ?? Infinity) - (b.e.position ?? Infinity) || a.i - b.i)
    .map((x) => x.e);
  const bindings = world.loreUiBindings ?? [];
  const boundEntryIds = new Set(bindings.map((bd) => bd.entryId));
  const greetingIds = new Set<string>();
  let foldedCoreEntries = 0;

  const entryHasRelations = (e: (typeof entries)[number]): boolean =>
    (e.conditions?.length ?? 0) > 0 || boundEntryIds.has(e.id) || e.variableBound === true ||
    toggledEntryIds.has(e.id);

  const pinnedEntryIds = new Set(options?.pinnedEntryIds ?? []);
  /** Whether an entry renders as its own node rather than folding into a
   *  summary. Pinned entries are excluded from the fold counts too, so a fresh
   *  entry can never be what tips its module over the threshold. */
  const staysIndividual = (e: (typeof entries)[number]): boolean =>
    entryHasRelations(e) || pinnedEntryIds.has(e.id);

  // Relationship-free member entries fold into one summary node per module
  // once there are enough of them — a lore-heavy module must not explode the
  // canvas. Small modules keep individual nodes (names beat a ×4 box).
  const MODULE_FOLD_THRESHOLD = 5;
  const foldPlainEntries = options?.foldPlainEntries !== false;
  const plainPerModule = new Map<string, number>();
  for (const e of entries) {
    if (!foldPlainEntries || e.role === "greeting" || staysIndividual(e)) continue;
    const parent = parentOf(e.worldbookId);
    if (parent) plainPerModule.set(parent, (plainPerModule.get(parent) ?? 0) + 1);
  }
  const foldedModules = new Map<string, number>(); // module node id → folded count
  for (const [mid, count] of plainPerModule) {
    if (count >= MODULE_FOLD_THRESHOLD) foldedModules.set(mid, count);
  }

  const seenEntryNodes = new Set<string>();
  for (const e of entries) {
    // Same duplicate-id hazard as variables: imports and copies can land two
    // entries on one id, and the canvas needs one node per id.
    if (seenEntryNodes.has(e.id)) continue;
    seenEntryNodes.add(e.id);
    if (e.role === "greeting") {
      greetingIds.add(e.id);
      nodes.push({
        id: `greeting:${e.id}`, kind: "greeting", title: e.name || e.id,
        ports: [
          port("opening", "signal", "in"),
          port("select", "signal", "out"),
          port("seeds", "state", "out"),
        ],
        parentId: parentOf(e.worldbookId),
        data: { entryId: e.id, ...(e.enabled === false ? { disabled: true } : {}) },
      });
      edges.push({
        id: `e:world->greeting:${e.id}`,
        from: "world:root", fromPort: "openings",
        to: `greeting:${e.id}`, toPort: "opening",
      });
      // Opening presets: initialVariables seed variable values at session start.
      for (const [key, value] of Object.entries(e.initialVariables ?? {})) {
        const varId = varIds.has(key) ? key : varIdByName.get(key);
        if (!varId) continue;
        edges.push({
          id: `e:greeting:${e.id}->var:${varId}`,
          from: `greeting:${e.id}`, fromPort: "seeds",
          to: `var:${varId}`, toPort: "write",
          label: `= ${JSON.stringify(value)}`,
        });
      }
      continue;
    }

    // Non-greeting entries: project members of a module, and Core entries that
    // participate in a relationship. Relationship-free Core entries fold into
    // one summary node so a 300-entry card doesn't explode the canvas;
    // relationship-free module entries fold per module past the threshold.
    const parentId = parentOf(e.worldbookId);
    const hasRelations = staysIndividual(e);
    if (foldPlainEntries && !hasRelations) {
      if (!parentId) {
        foldedCoreEntries++;
        continue;
      }
      if (foldedModules.has(parentId)) continue;
    }
    nodes.push({
      id: `entry:${e.id}`, kind: "entry", title: e.name || e.id,
      ports: [port("gate", "entry", "in"), port("show", "entry", "out")],
      parentId,
      data: {
        entryId: e.id,
        // How this entry reaches the prompt. The board groups by it, and it is
        // the property a lore-heavy card is actually managed by, so it belongs
        // in the projection rather than being re-derived by every consumer.
        trigger: entryTrigger(e),
        ...((e.conditions?.length ?? 0) > 1 ? { conditionLogic: e.conditionLogic } : {}),
        ...(e.enabled === false ? { disabled: true } : {}),
      },
    });
    (e.conditions ?? []).forEach((c, i) => {
      if (!varIds.has(c.variableId)) return;
      edges.push({
        id: `e:var:${c.variableId}->entry:${e.id}:${i}`,
        from: `var:${c.variableId}`, fromPort: "read",
        to: `entry:${e.id}`, toPort: "gate",
        label: conditionLabel(c),
      });
    });
  }

  if (foldedCoreEntries > 0) {
    nodes.push({
      id: "core-entries", kind: "entry", title: "Core entries",
      ports: [],
      data: { count: foldedCoreEntries, drillTarget: "lorebook" },
    });
  }
  for (const [mid, count] of foldedModules) {
    nodes.push({
      id: `module-entries:${mid.slice("module:".length)}`, kind: "entry", title: "Entries",
      ports: [],
      parentId: mid,
      data: { count, drillTarget: "lorebook" },
    });
  }

  // Drop greeting→module activation edges whose greeting no longer exists.
  const staleGreetingEdges = edges.filter(
    (e) => e.from.startsWith("greeting:") && !greetingIds.has(e.from.slice("greeting:".length)),
  );
  for (const stale of staleGreetingEdges) edges.splice(edges.indexOf(stale), 1);

  // ── frontend node (rootComponent + LoreSlot bindings) ──
  if (world.rootComponent || bindings.length > 0) {
    const scannedSlots = world.rootComponent
      ? extractLoreSlotsFromFiles(world.rootComponent.files).map((s) => s.slotId)
      : [];
    const slotIds = [...new Set([...bindings.map((bd) => bd.slotId), ...scannedSlots])];
    const readIds = [...uiReadVarIds];
    // File by file: what each one reads, writes and asks the AI. The
    // interface is where a demo card hides its logic; this is what makes it
    // readable on the canvas, by the assistant and on the card's own page.
    const manifest = world.rootComponent ? frontendManifest(world.rootComponent.files, world.rootComponent.entryFile) : null;
    nodes.push({
      id: "frontend", kind: "component", title: world.rootComponent?.name || "Frontend",
      ports: [
        ...slotIds.map((s) => port(`slot:${s}`, "entry", "in")),
        ...readIds.map((id) => port(`read:${id}`, "state", "in", varNameById.get(id))),
      ],
      data: {
        drillTarget: "code-view", slotIds, readIds,
        ...(uiScan.dynamicReads > 0 ? { dynamicReads: uiScan.dynamicReads } : {}),
        ...(manifest ? { files: manifest.files, aiCalls: manifest.aiCalls, uses: manifest.uses } : {}),
      },
    });
    // "Which variable drives this panel?" — the wire the whole canvas was for.
    for (const id of readIds) {
      edges.push({
        id: `e:var:${id}->frontend:read`,
        from: `var:${id}`, fromPort: "read",
        to: "frontend", toPort: `read:${id}`,
      });
    }
    bindings.forEach((bd, i) => {
      if (!nodes.some((n) => n.id === `entry:${bd.entryId}`)) return;
      edges.push({
        id: `e:entry:${bd.entryId}->frontend:${bd.slotId}:${i}`,
        from: `entry:${bd.entryId}`, fromPort: "show",
        to: "frontend", toPort: `slot:${bd.slotId}`,
      });
    });
  }

  // ── reaction nodes + wiring ──
  for (const r of reactionList) {
    nodes.push({
      id: `reaction:${r.id}`, kind: "rule", title: r.name || r.id,
      ports: [port("trigger", "signal", "in"), port("condition", "signal", "in"), port("stop", "signal", "in"), port("effect", "signal", "out")],
      parentId: parentOf(r.worldbookId),
      data: { reactionId: r.id, ...(r.enabled === false ? { disabled: true } : {}) },
    });

    // WHEN: state:changed pinned to one variable wires from that variable;
    // a listener fed by another reaction's emit wires from the emitter (the
    // chain IS the event source); anything else wires from a generic
    // event-source node.
    // Every state:* event (changed, crossed, …) pinned to one variable is that
    // variable's wire; only "changed" used to count, so a threshold behaviour
    // watching a number sat on the board with no line to it.
    const pinnedVar =
      typeof r.when.eventType === "string" && r.when.eventType.startsWith("state:") &&
      r.when.match?.variableId?.operator === "eq" &&
      typeof r.when.match.variableId.value === "string"
        ? r.when.match.variableId.value
        : null;
    const chainSources = pinnedVar
      ? []
      : emits.filter((em) => em.rid !== r.id && matchesEventPattern(em.event, r.when));
    if (pinnedVar && varIds.has(pinnedVar)) {
      edges.push({
        id: `e:var:${pinnedVar}->reaction:${r.id}`,
        from: `var:${pinnedVar}`, fromPort: "read",
        to: `reaction:${r.id}`, toPort: "trigger",
      });
    } else if (chainSources.length > 0) {
      for (const em of chainSources) {
        edges.push({
          id: `e:reaction:${em.rid}->reaction:${r.id}:${em.idx}`,
          from: `reaction:${em.rid}`, fromPort: "effect",
          to: `reaction:${r.id}`, toPort: "trigger",
          label: em.event.type,
        });
      }
    } else {
      const src = `evt:${r.when.eventType}`;
      noteEventSource(src, parentOf(r.worldbookId));
      edges.push({ id: `e:${src}->reaction:${r.id}`, from: src, fromPort: "fires", to: `reaction:${r.id}`, toPort: "trigger" });
    }

    // ONLY IF / STOP WHEN: the variables a behaviour reads before it runs.
    // Not a trigger — the wire says "this decides whether I fire" — but
    // without it a behaviour that hinges on a number had no line to that
    // number, and the number's own panel could not say who depends on it.
    const readEdges = (list: readonly Condition[] | undefined, toPort: "condition" | "stop") => {
      (list ?? []).forEach((c, i) => {
        if (!c || typeof c.variableId !== "string") return;
        const vid = c.variableId.split(/[.[]/, 1)[0]!;
        if (varIds.has(vid)) {
          edges.push({ id: `e:var:${vid}->reaction:${r.id}:${toPort}:${i}`, from: `var:${vid}`, fromPort: "read", to: `reaction:${r.id}`, toPort });
        }
        const ref = typeof c.valueRef === "string" ? c.valueRef.split(/[.[]/, 1)[0]! : "";
        if (ref && varIds.has(ref) && ref !== vid) {
          edges.push({ id: `e:var:${ref}->reaction:${r.id}:${toPort}:${i}:ref`, from: `var:${ref}`, fromPort: "read", to: `reaction:${r.id}`, toPort });
        }
      });
    };
    readEdges(r.conditions, "condition");
    readEdges(r.stopConditions, "stop");

    // THEN: variable writes, entry toggles, audio plays. Emits surface as the
    // chain edges above; the remaining @ system effects have no node target.
    (r.then ?? []).forEach((eff, i) => {
      if (!hasPath(eff)) return;
      if (eff.path.startsWith("@prompt.entry.")) {
        const eid = eff.path.slice("@prompt.entry.".length);
        if (!eid || typeof eff.value !== "boolean" || greetingIds.has(eid)) return;
        const target = entries.find((e) => e.id === eid);
        ensureNode(nodes, {
          id: `entry:${eid}`, kind: "entry", title: target?.name || eid,
          ports: [port("gate", "entry", "in"), port("show", "entry", "out")],
          parentId: target ? parentOf(target.worldbookId) : undefined,
          data: { entryId: eid },
        });
        edges.push({
          id: `e:reaction:${r.id}->entry:${eid}:${i}`,
          from: `reaction:${r.id}`, fromPort: "effect",
          to: `entry:${eid}`, toPort: "gate",
          label: eff.value ? "unlock" : "lock",
        });
        return;
      }
      if (eff.path.startsWith("@audio.")) {
        const channel = eff.path.slice("@audio.".length);
        if (!["bgm", "sfx", "ambient", "stop"].includes(channel)) return;
        if (typeof eff.value !== "string" || !eff.value) return;
        // An audio effect names its track by id. The board renders audio as a
        // block a creator reads, so show the track's NAME when the card has
        // one — the raw id was a slug nobody chose for display.
        const track = (world.audioTracks ?? []).find((t) => t.id === eff.value || t.name === eff.value);
        // A track named by its title lands on the card's own node for it,
        // not on a second node spelled with the title.
        const trackId = track?.id ?? eff.value;
        ensureNode(nodes, {
          id: `audio:${trackId}`, kind: "audio", title: track?.name || eff.value,
          ports: [port("play", "signal", "in")],
          data: { trackId, ...(track?.type ? { trackType: track.type } : {}) },
        });
        edges.push({
          id: `e:reaction:${r.id}->audio:${trackId}:${i}`,
          from: `reaction:${r.id}`, fromPort: "effect",
          to: `audio:${trackId}`, toPort: "play",
          label: channel,
        });
        return;
      }
      const path = eff.path.startsWith("@vars.enabled.") ? eff.path.slice("@vars.enabled.".length) : eff.path;
      if (eff.path.startsWith("@") && path === eff.path) return; // other @ system effects: no node target
      const rootId = path.split(".")[0]!;
      if (!varIds.has(rootId)) return;
      const label = eff.path.startsWith("@vars.enabled.") ? "toggle" : (eff.operation ?? "set");
      edges.push({
        id: `e:reaction:${r.id}->var:${rootId}:${i}`,
        from: `reaction:${r.id}`, fromPort: "effect",
        to: `var:${rootId}`, toPort: "write",
        label,
      });
    });
  }

  // ── legacy rule nodes + wiring (projection unchanged from v1) ──
  for (const r of ruleList) {
    // A rule missing a piece still gets a node, carrying what is wrong with it.
    // Dropping it instead would read as "the editor ate my rule", and the
    // author would have no way to tell a broken rule from a deleted one.
    const shapeIssues = ruleShapeIssues(r);
    nodes.push({
      id: `rule:${r.id}`, kind: "rule", title: r.name || r.id,
      ports: [port("trigger", "signal", "in"), port("effect", "signal", "out")],
      parentId: parentOf(r.worldbookId),
      data: { ruleId: r.id, ...(shapeIssues.length ? { shapeIssues } : {}) },
    });

    const trigger = r.trigger;
    if (trigger && EVENT_TRIGGERS.has(trigger.type)) {
      const src = eventSourceId(trigger);
      if (src) {
        noteEventSource(src, parentOf(r.worldbookId));
        edges.push({ id: `e:${src}->rule:${r.id}`, from: src, fromPort: "fires", to: `rule:${r.id}`, toPort: "trigger" });
      }
    } else if (trigger?.variableId) {
      edges.push({ id: `e:var:${trigger.variableId}->rule:${r.id}`, from: `var:${trigger.variableId}`, fromPort: "read", to: `rule:${r.id}`, toPort: "trigger" });
    }

    actionsOf(r).forEach((a: RuleAction, i) => {
      if (a.type === "modify-variable") {
        edges.push({ id: `e:rule:${r.id}->var:${a.variableId}:${i}`, from: `rule:${r.id}`, fromPort: "effect", to: `var:${a.variableId}`, toPort: "write", label: a.operation });
      } else if (a.type === "toggle-entry") {
        ensureNode(nodes, { id: `entry:${a.entryId}`, kind: "entry", title: a.entryId, ports: [port("gate", "entry", "in"), port("show", "entry", "out")], data: { entryId: a.entryId } });
        edges.push({ id: `e:rule:${r.id}->entry:${a.entryId}:${i}`, from: `rule:${r.id}`, fromPort: "effect", to: `entry:${a.entryId}`, toPort: "gate", label: a.enabled ? "unlock" : "lock" });
      } else if (a.type === "play-audio") {
        ensureNode(nodes, { id: `audio:${a.trackId}`, kind: "audio", title: a.trackId, ports: [port("play", "signal", "in")], data: { trackId: a.trackId } });
        edges.push({ id: `e:rule:${r.id}->audio:${a.trackId}:${i}`, from: `rule:${r.id}`, fromPort: "effect", to: `audio:${a.trackId}`, toPort: "play", label: a.action });
      }
    });
  }

  // ── event-source nodes (only those actually referenced) ──
  for (const [src, parentId] of eventSources) {
    nodes.unshift({
      id: src, kind: "event", title: EVENT_TITLES[src] ?? src,
      ports: [port("fires", "signal", "out")],
      ...(parentId ? { parentId } : {}),
      data: {},
    });
  }

  return { nodes, edges };
}

function ensureNode(nodes: GraphNode[], node: GraphNode): void {
  if (!nodes.some((n) => n.id === node.id)) nodes.push(node);
}

const idOf = (nodeId: string) => nodeId.slice(nodeId.indexOf(":") + 1);

/** The initialVariables key an opening uses for a variable — the variable id,
 *  or its NAME on legacy cards. Null when the opening has no seed for it. */
function seedKeyOf(world: WorldLogic, greetingEntryId: string, variableId: string): string | null {
  const iv = (world.entries ?? []).find((e) => e.id === greetingEntryId)?.initialVariables;
  if (!iv) return null;
  if (variableId in iv) return variableId;
  const name = (world.variables ?? []).find((v) => v.id === variableId)?.name;
  return name && name in iv ? name : null;
}

/** A sensible starter condition for the variable's type — the creator refines
 *  operator/value in the inspector after drawing the wire. */
function defaultConditionFor(world: WorldLogic, variableId: string): Condition {
  const v = (world.variables ?? []).find((x) => x.id === variableId);
  switch (v?.type) {
    case "number": return { variableId, operator: "gte", value: 1 };
    case "string": return { variableId, operator: "neq", value: "" };
    default: return { variableId, operator: "eq", value: true };
  }
}

export function applyGraphEdit(world: WorldDefinition, patch: GraphPatch): WorldDefinition {
  // Same totality rule as toGraph: an edit anywhere on the canvas clones every
  // rule, so one unreadable rule must not make every drag throw.
  const rules: Rule[] = (Array.isArray(world.rules) ? world.rules : [])
    .filter((r): r is Rule => Boolean(r) && typeof r === "object")
    .map((r) => ({
      ...r,
      actions: Array.isArray(r.actions) ? [...r.actions] : [],
      conditions: Array.isArray(r.conditions) ? [...r.conditions] : [],
    }));
  const findRule = (nodeId: string) => rules.find((r) => r.id === idOf(nodeId));

  switch (patch.op) {
    case "add-edge": {
      const { from, to, toPort } = patch.edge;

      // rule:X → var:Y — append a modify-variable action (legacy behaviors)
      if (from.startsWith("rule:") && to.startsWith("var:")) {
        const r = findRule(from);
        if (r) r.actions.push({ type: "modify-variable", variableId: idOf(to), operation: "add", value: 1 });
        return { ...world, rules };
      }
      // evt → rule — reset the trigger to a keyword shell (legacy behaviors)
      if (from.startsWith("evt:") && to.startsWith("rule:")) {
        const r = findRule(to);
        if (r) r.trigger = { type: "keyword", keywords: [] };
        return { ...world, rules };
      }
      // reaction:X → var:Y — append a set effect
      if (from.startsWith("reaction:") && to.startsWith("var:")) {
        const rid = idOf(from);
        return {
          ...world,
          reactions: (world.reactions ?? []).map((r) =>
            r.id === rid
              ? { ...r, then: [...r.then, { type: "set" as const, path: idOf(to), value: 1, operation: "add" as const }] }
              : r,
          ),
        };
      }
      // reaction:X → entry:E — append an entry toggle effect (unlock by default;
      // the creator flips it to lock in the inspector)
      if (from.startsWith("reaction:") && to.startsWith("entry:")) {
        const rid = idOf(from);
        return {
          ...world,
          reactions: (world.reactions ?? []).map((r) =>
            r.id === rid
              ? { ...r, then: [...r.then, { type: "set" as const, path: `@prompt.entry.${idOf(to)}`, value: true }] }
              : r,
          ),
        };
      }
      // var:X → module:B — activation condition (always/manual convert to conditions;
      // a greeting-mode book keeps its mode — no silent clobber)
      if (from.startsWith("var:") && to.startsWith("module:")) {
        const bid = idOf(to);
        return {
          ...world,
          worldbooks: (world.worldbooks ?? []).map((b) => {
            if (b.id !== bid) return b;
            const cond = defaultConditionFor(world, idOf(from));
            if (b.activation.mode === "conditions") {
              return { ...b, activation: { ...b.activation, conditions: [...b.activation.conditions, cond] } };
            }
            if (b.activation.mode === "always" || b.activation.mode === "manual") {
              return { ...b, activation: { mode: "conditions" as const, conditions: [cond], conditionLogic: "all" as const } };
            }
            return b;
          }),
        };
      }
      // greeting:G → module:B — greeting activation (only from always/manual or
      // an existing greeting-mode book; never clobbers a conditions-mode book)
      if (from.startsWith("greeting:") && to.startsWith("module:")) {
        const bid = idOf(to);
        const gid = idOf(from);
        return {
          ...world,
          worldbooks: (world.worldbooks ?? []).map((b) => {
            if (b.id !== bid) return b;
            if (b.activation.mode === "greeting") {
              if (b.activation.greetingIds.includes(gid)) return b;
              return { ...b, activation: { ...b.activation, greetingIds: [...b.activation.greetingIds, gid] } };
            }
            if (b.activation.mode === "always" || b.activation.mode === "manual") {
              return { ...b, activation: { mode: "greeting" as const, greetingIds: [gid] } };
            }
            return b;
          }),
        };
      }
      // greeting:G → var:V — opening seeds the variable with its default value
      if (from.startsWith("greeting:") && to.startsWith("var:")) {
        const gid = idOf(from);
        const vid = idOf(to);
        if (seedKeyOf(world, gid, vid)) return world; // seed exists: never clobber its value
        const variable = (world.variables ?? []).find((v) => v.id === vid);
        const seed = variable?.defaultValue;
        if (seed === undefined || typeof seed === "object") return world; // json seeds: not wireable yet
        return {
          ...world,
          entries: (world.entries ?? []).map((e) =>
            e.id === gid ? { ...e, initialVariables: { ...(e.initialVariables ?? {}), [vid]: seed } } : e,
          ),
        };
      }
      // var:X → entry:E — gate the entry on a condition
      if (from.startsWith("var:") && to.startsWith("entry:")) {
        const eid = idOf(to);
        return {
          ...world,
          entries: (world.entries ?? []).map((e) =>
            e.id === eid ? { ...e, conditions: [...(e.conditions ?? []), defaultConditionFor(world, idOf(from))] } : e,
          ),
        };
      }
      // entry:E → frontend slot — bind the entry to a LoreSlot
      if (from.startsWith("entry:") && to === "frontend" && toPort.startsWith("slot:")) {
        const slotId = toPort.slice("slot:".length);
        return {
          ...world,
          loreUiBindings: [
            ...(world.loreUiBindings ?? []),
            { slotId, entryId: idOf(from), conditions: [], conditionLogic: "all" as const },
          ],
        };
      }
      return { ...world, rules };
    }

    case "remove-edge": {
      const id = patch.edgeId;
      let m: RegExpExecArray | null;

      // e:rule:<r>->var:<v>:<i> — remove the exact action (index guard vs stale ids)
      if ((m = /^e:rule:(.+?)->var:(.+?):(\d+)$/.exec(id))) {
        const actionIdx = parseInt(m[3]!, 10);
        const r = rules.find((x) => x.id === m![1]);
        if (r) {
          const a = r.actions[actionIdx];
          if (a && a.type === "modify-variable" && a.variableId === m[2]) {
            r.actions.splice(actionIdx, 1);
          }
        }
        return { ...world, rules };
      }
      // e:reaction:<r>->var:<v>:<i> — remove the exact set effect (the guard
      // normalizes @vars.enabled toggles the same way the projection does)
      if ((m = /^e:reaction:(.+?)->var:(.+?):(\d+)$/.exec(id))) {
        const [, rid, vid, idxStr] = m;
        const idx = parseInt(idxStr!, 10);
        return {
          ...world,
          reactions: (world.reactions ?? []).map((r) => {
            if (r.id !== rid) return r;
            const eff = r.then[idx];
            if (!eff || eff.type !== "set") return r;
            const p = eff.path.startsWith("@vars.enabled.") ? eff.path.slice("@vars.enabled.".length) : eff.path;
            if (p.split(".")[0] !== vid) return r;
            return { ...r, then: r.then.filter((_, i) => i !== idx) };
          }),
        };
      }
      // e:reaction:<r>->entry:<e>:<i> — remove the exact entry toggle effect
      if ((m = /^e:reaction:(.+?)->entry:(.+?):(\d+)$/.exec(id))) {
        const [, rid, eid, idxStr] = m;
        const idx = parseInt(idxStr!, 10);
        return {
          ...world,
          reactions: (world.reactions ?? []).map((r) => {
            if (r.id !== rid) return r;
            const eff = r.then[idx];
            if (!eff || eff.type !== "set" || eff.path !== `@prompt.entry.${eid}`) return r;
            return { ...r, then: r.then.filter((_, i) => i !== idx) };
          }),
        };
      }
      // e:reaction:<r>->audio:<track>:<i> — remove the exact audio effect
      if ((m = /^e:reaction:(.+?)->audio:(.+?):(\d+)$/.exec(id))) {
        const [, rid, track, idxStr] = m;
        const idx = parseInt(idxStr!, 10);
        return {
          ...world,
          reactions: (world.reactions ?? []).map((r) => {
            if (r.id !== rid) return r;
            const eff = r.then[idx];
            if (!eff || eff.type !== "set" || !eff.path.startsWith("@audio.") || eff.value !== track) return r;
            return { ...r, then: r.then.filter((_, i) => i !== idx) };
          }),
        };
      }
      // e:var:<v>->module:<b>:<i> — remove the activation condition; none left → always
      if ((m = /^e:var:(.+?)->module:(.+?):(\d+)$/.exec(id))) {
        const [, vid, bid, idxStr] = m;
        const idx = parseInt(idxStr!, 10);
        return {
          ...world,
          worldbooks: (world.worldbooks ?? []).map((b) => {
            if (b.id !== bid || b.activation.mode !== "conditions") return b;
            const c = b.activation.conditions[idx];
            if (!c || c.variableId !== vid) return b;
            const conditions = b.activation.conditions.filter((_, i) => i !== idx);
            return conditions.length === 0
              ? { ...b, activation: { mode: "always" as const } }
              : { ...b, activation: { ...b.activation, conditions } };
          }),
        };
      }
      // e:greeting:<g>->module:<b> — unbind the opening; empty → always
      if ((m = /^e:greeting:(.+?)->module:(.+?)$/.exec(id))) {
        const [, gid, bid] = m;
        return {
          ...world,
          worldbooks: (world.worldbooks ?? []).map((b) => {
            if (b.id !== bid || b.activation.mode !== "greeting") return b;
            const greetingIds = b.activation.greetingIds.filter((x) => x !== gid);
            return greetingIds.length === 0
              ? { ...b, activation: { mode: "always" as const } }
              : { ...b, activation: { ...b.activation, greetingIds } };
          }),
        };
      }
      // e:greeting:<g>->var:<v> — remove the opening seed (id- or name-keyed)
      if ((m = /^e:greeting:(.+?)->var:(.+?)$/.exec(id))) {
        const [, gid, vid] = m;
        const key = seedKeyOf(world, gid!, vid!);
        if (!key) return world;
        return {
          ...world,
          entries: (world.entries ?? []).map((e) => {
            if (e.id !== gid || !e.initialVariables) return e;
            const { [key]: _removed, ...rest } = e.initialVariables;
            return { ...e, initialVariables: rest };
          }),
        };
      }
      // e:var:<v>->entry:<e>:<i> — remove the exact entry condition
      if ((m = /^e:var:(.+?)->entry:(.+?):(\d+)$/.exec(id))) {
        const [, vid, eid, idxStr] = m;
        const idx = parseInt(idxStr!, 10);
        return {
          ...world,
          entries: (world.entries ?? []).map((e) => {
            if (e.id !== eid) return e;
            const c = (e.conditions ?? [])[idx];
            if (!c || c.variableId !== vid) return e;
            return { ...e, conditions: e.conditions.filter((_, i) => i !== idx) };
          }),
        };
      }
      // e:entry:<e>->frontend:<slot>:<i> — remove the LoreSlot binding
      if ((m = /^e:entry:(.+?)->frontend:(.+?):(\d+)$/.exec(id))) {
        const [, eid, slotId, idxStr] = m;
        const idx = parseInt(idxStr!, 10);
        const bindings = world.loreUiBindings ?? [];
        const b = bindings[idx];
        if (!b || b.entryId !== eid || b.slotId !== slotId) return world;
        return { ...world, loreUiBindings: bindings.filter((_, i) => i !== idx) };
      }
      return { ...world, rules };
    }

    case "update-edge": {
      const id = patch.edgeId;
      const upd = patch.data;
      const applyCond = (c: Condition): Condition => ({
        ...c,
        ...(upd.operator !== undefined ? { operator: upd.operator } : {}),
        ...(upd.value !== undefined ? { value: upd.value as Condition["value"] } : {}),
      });
      let m: RegExpExecArray | null;

      // e:var:<v>->module:<b>:<i> — edit the activation condition in place
      if ((m = /^e:var:(.+?)->module:(.+?):(\d+)$/.exec(id))) {
        const [, vid, bid, idxStr] = m;
        const idx = parseInt(idxStr!, 10);
        return {
          ...world,
          worldbooks: (world.worldbooks ?? []).map((b) => {
            if (b.id !== bid || b.activation.mode !== "conditions") return b;
            const c = b.activation.conditions[idx];
            if (!c || c.variableId !== vid) return b;
            const conditions = b.activation.conditions.map((x, i) => (i === idx ? applyCond(x) : x));
            return { ...b, activation: { ...b.activation, conditions } };
          }),
        };
      }
      // e:var:<v>->entry:<e>:<i> — edit the entry condition in place
      if ((m = /^e:var:(.+?)->entry:(.+?):(\d+)$/.exec(id))) {
        const [, vid, eid, idxStr] = m;
        const idx = parseInt(idxStr!, 10);
        return {
          ...world,
          entries: (world.entries ?? []).map((e) => {
            if (e.id !== eid) return e;
            const c = (e.conditions ?? [])[idx];
            if (!c || c.variableId !== vid) return e;
            return { ...e, conditions: e.conditions.map((x, i) => (i === idx ? applyCond(x) : x)) };
          }),
        };
      }
      // e:greeting:<g>->var:<v> — edit the opening seed value (id- or name-keyed)
      if ((m = /^e:greeting:(.+?)->var:(.+?)$/.exec(id))) {
        const [, gid, vid] = m;
        if (upd.value === undefined || typeof upd.value === "object") return world;
        const key = seedKeyOf(world, gid!, vid!);
        if (!key) return world;
        return {
          ...world,
          entries: (world.entries ?? []).map((e) => {
            if (e.id !== gid || !e.initialVariables) return e;
            return { ...e, initialVariables: { ...e.initialVariables, [key]: upd.value as number | string | boolean } };
          }),
        };
      }
      return world;
    }

    case "set-parent": {
      const worldbookId = patch.parentId?.startsWith("module:") ? idOf(patch.parentId) : undefined;
      const target = patch.nodeId;
      const setBook = <T extends { worldbookId?: string }>(obj: T): T => {
        const next = { ...obj };
        if (worldbookId === undefined) delete next.worldbookId;
        else next.worldbookId = worldbookId;
        return next;
      };
      if (target.startsWith("var:")) {
        const vid = idOf(target);
        return { ...world, variables: world.variables.map((v) => (v.id === vid ? setBook(v) : v)) };
      }
      if (target.startsWith("entry:") || target.startsWith("greeting:")) {
        const eid = idOf(target);
        return { ...world, entries: (world.entries ?? []).map((e) => (e.id === eid ? setBook(e) : e)) };
      }
      if (target.startsWith("reaction:")) {
        const rid = idOf(target);
        return { ...world, reactions: (world.reactions ?? []).map((r) => (r.id === rid ? setBook(r) : r)) };
      }
      if (target.startsWith("rule:")) {
        const rid = idOf(target);
        return { ...world, rules: rules.map((r) => (r.id === rid ? setBook(r) : r)) };
      }
      return world;
    }

    case "remove-node": {
      if (patch.nodeId.startsWith("rule:")) {
        return { ...world, rules: rules.filter((r) => r.id !== idOf(patch.nodeId)) };
      }
      return world;
    }
    case "update-node-data": {
      if (patch.nodeId.startsWith("rule:") && typeof patch.data.name === "string") {
        const r = findRule(patch.nodeId);
        if (r) r.name = patch.data.name;
      }
      return { ...world, rules };
    }
    case "add-node":
      // Node creation is handled by the store (mint id + insert into rules/variables),
      // so the compiler treats add-node as a no-op projection sync. See Task 9.
      return world;
    default:
      return world;
  }
}
