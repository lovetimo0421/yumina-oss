import type { Block, GraphNode, WorldDefinition } from "@yumina/engine";
import type { AiFocusItem, AiFocusKind } from "./ai-focus";

type Translate = (key: string) => string;

const BLOCK_LABEL_KEYS: Record<string, string> = {
  state: "studio.panels.variables",
  behavior: "studio.panels.behaviors",
  lore: "studio.panels.lorebook",
  frontend: "studio.stage.tabFrontend",
  audio: "studio.panels.audio",
  scene: "studio.panels.sceneImages",
  background: "studio.panels.backgrounds",
  opening: "studio.panels.firstMessage",
  card: "studio.panels.overview",
};

const json = (value: unknown) => {
  try { return JSON.stringify(value ?? "").length; } catch { return 0; }
};

/** How much text a block would put in front of the assistant. */
function blockSize(kind: string, world: WorldDefinition): number {
  const entries = world.entries ?? [];
  switch (kind) {
    case "state": return json(world.variables);
    case "behavior": return json(world.reactions) + json(world.rules);
    case "lore": return entries.filter((e) => e.role !== "greeting").reduce((n, e) => n + (e.content?.length ?? 0), 0);
    case "opening": return entries.filter((e) => e.role === "greeting").reduce((n, e) => n + (e.content?.length ?? 0), 0);
    case "frontend": return Object.values(world.rootComponent?.files ?? {}).reduce((n, code) => n + (code?.length ?? 0), 0);
    case "audio": return json(world.audioTracks);
    default: return 0;
  }
}

/** A canvas selection, described the way the composer's chips show it. */
export function describeFocus(
  id: string,
  ctx: { graphById: ReadonlyMap<string, GraphNode>; blocks: readonly Block[]; world: WorldDefinition; t: Translate },
): AiFocusItem | null {
  if (id.startsWith("block:")) {
    const block = ctx.blocks.find((b) => b.id === id);
    const blockKind = block?.kind ?? (id.includes("opening") ? "opening" : id.includes("setting") ? "lore" : "");
    const key = BLOCK_LABEL_KEYS[blockKind];
    const title = block?.head?.title ?? (key ? ctx.t(key) : "");
    if (!title) return null;
    return { id, kind: blockKind === "frontend" ? "frontend" : "block", title, size: blockSize(blockKind, ctx.world) };
  }
  const node = ctx.graphById.get(id);
  if (!node) return null;
  const raw = id.slice(id.indexOf(":") + 1);
  const entries = ctx.world.entries ?? [];
  let kind: AiFocusKind;
  let size = 0;
  switch (node.kind) {
    case "entry": kind = "entry"; size = entries.find((e) => e.id === raw)?.content?.length ?? 0; break;
    case "greeting": kind = "greeting"; size = entries.find((e) => e.id === raw)?.content?.length ?? 0; break;
    case "variable": kind = "variable"; size = json((ctx.world.variables ?? []).find((v) => v.id === raw)); break;
    case "rule": kind = "rule"; size = json([...(ctx.world.reactions ?? []), ...(ctx.world.rules ?? [])].find((r) => r.id === raw)); break;
    case "audio": kind = "audio"; size = json((ctx.world.audioTracks ?? []).find((a) => a.id === raw)); break;
    case "module": kind = "module"; break;
    case "world": kind = "world"; break;
    // The player's screen: picking it on the board hands its code over.
    case "component": return { id, kind: "frontend", title: node.title || ctx.t("studio.stage.tabFrontend"), size: blockSize("frontend", ctx.world) };
    default: return null;
  }
  return { id, kind, title: node.title || raw, size };
}

/** A written entry or opening, from the draft alone (for modifier-clicks on
 *  rows the canvas does not multi-select). */
export function describeWritingFocus(id: string, world: WorldDefinition): AiFocusItem | null {
  const raw = id.slice(id.indexOf(":") + 1);
  const entry = (world.entries ?? []).find((e) => e.id === raw);
  if (!entry) return null;
  return { id, kind: id.startsWith("greeting:") || entry.role === "greeting" ? "greeting" : "entry", title: entry.name || raw, size: entry.content?.length ?? 0 };
}
