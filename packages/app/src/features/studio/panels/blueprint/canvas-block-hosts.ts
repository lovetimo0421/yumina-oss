import { blockHostMap, blockHostsMap, type Block, type BlockHost, type CardGraph } from "@yumina/engine";
import type { CanvasBlock } from "./starter-board";

/** Editing and folding still address the engine's original block ids. */
export function resolveSourceBlockId(id: string, blocks: readonly CanvasBlock[]): string {
  return blocks.find(block => block.id === id)?.sourceBlockId ?? id;
}

/** ReactFlow addresses the stable node that displays that original block. */
export function resolveCanvasBlockId(id: string, blocks: readonly CanvasBlock[]): string {
  return blocks.find(block => block.sourceBlockId === id)?.id ?? id;
}

function restoreSourceBlocks(blocks: readonly CanvasBlock[]): Block[] {
  return blocks.map(block => block.sourceBlockId ? { ...block, id: block.sourceBlockId } : block);
}

function canvasHost(host: BlockHost, aliases: ReadonlyMap<string, string>): BlockHost {
  const id = aliases.get(host.host);
  return id && id !== host.host ? { ...host, host: id } : host;
}

/** Preserve the engine's ownership and row visibility, then translate only
 * its render target. An invitation becoming an editor must not lose wires. */
export function canvasBlockHostMap(blocks: readonly CanvasBlock[], graph: CardGraph): Map<string, BlockHost> {
  const aliases = new Map(blocks.filter(block => block.sourceBlockId).map(block => [block.sourceBlockId!, block.id]));
  return new Map([...blockHostMap(restoreSourceBlocks(blocks), graph)].map(([id, host]) => [id, canvasHost(host, aliases)]));
}

/** Shared content can have a host in several modules; keep every host. */
export function canvasBlockHostsMap(blocks: readonly CanvasBlock[], graph: CardGraph): Map<string, BlockHost[]> {
  const aliases = new Map(blocks.filter(block => block.sourceBlockId).map(block => [block.sourceBlockId!, block.id]));
  return new Map([...blockHostsMap(restoreSourceBlocks(blocks), graph)].map(([id, hosts]) => [id, hosts.map(host => canvasHost(host, aliases))]));
}
