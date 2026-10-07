import type { GraphNode, WorldDefinition } from "@yumina/engine";

export interface WorldSearchDocument {
  id: string;
  title: string;
  scope: string | null;
  body: string;
  identifiers: string;
  /** What the result shows under its title, when `body` is data rather than
   *  prose (a behaviour's JSON, a frontend's code): the words a creator wrote
   *  in it. Matching still reads `body`; only the excerpt comes from here. */
  readable?: string;
}

/** The strings a creator wrote inside a structure — what a behaviour tells the
 *  AI, a button's label — without the keys, paths and code around them. */
function writtenStrings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8 || out.length > 60) return out;
  if (typeof value === "string") {
    const text = value.trim();
    // Paths and ids (`@prompt.context`, `turn:complete`, a UUID) are not prose.
    if (text && /\s|[^\x00-\x7f]/.test(text) && !text.startsWith("@")) out.push(text);
  } else if (Array.isArray(value)) {
    for (const item of value) writtenStrings(item, out, depth + 1);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "path" || key === "id" || key === "variableId" || key === "eventType") continue;
      writtenStrings(item, out, depth + 1);
    }
  }
  return out;
}

/** `{{hp}}` reads as the variable's name; anything else in braces (an
 *  expression, a helper call) is dropped rather than shown as code. */
export function humanizeMacros(text: string, names: ReadonlyMap<string, string>): string {
  return text.replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (_m, inner: string) => {
    if (inner === "user" || inner === "char") return `{{${inner}}}`;
    return names.get(inner) ?? (/^[\w.-]+$/.test(inner) ? inner : "…");
  });
}

export interface WorldSearchResult extends WorldSearchDocument {
  excerpt: string;
}

/** Search the saved objects, including text that is folded out of the canvas. */
export function indexWorldContent(world: WorldDefinition): WorldSearchDocument[] {
  const books = new Map((world.worldbooks ?? []).map(book => [book.id, book.name]));
  const folders = new Map((world.entryFolders ?? []).map(folder => [folder.id, folder.name]));
  const scope = (bookId?: string, folderId?: string) =>
    [bookId ? books.get(bookId) ?? bookId : null, folderId ? folders.get(folderId) : null].filter(Boolean).join(" › ") || null;
  const names = new Map(world.variables.map(variable => [variable.id, variable.name]));
  const readableOf = (value: unknown, lead?: string) =>
    humanizeMacros([lead, ...writtenStrings(value)].filter(Boolean).join(" · "), names);
  const documents: WorldSearchDocument[] = [{
    id: "world:root", title: world.name, scope: null,
    body: world.description ?? "", identifiers: world.id,
  }];
  for (const entry of world.entries) documents.push({
    id: `${entry.role === "greeting" ? "greeting" : "entry"}:${entry.id}`,
    title: entry.name, scope: scope(entry.worldbookId, entry.folderId),
    body: [entry.content, ...(entry.keywords ?? []), ...(entry.tags ?? [])].join("\n"),
    identifiers: entry.id,
  });
  for (const variable of world.variables) documents.push({
    id: `var:${variable.id}`, title: variable.name, scope: scope(variable.worldbookId),
    body: [variable.description, variable.behaviorRules ?? variable.updateHints].filter(Boolean).join("\n"), identifiers: variable.id,
  });
  for (const rule of world.rules ?? []) documents.push({
    id: `rule:${rule.id}`, title: rule.name, scope: scope(rule.worldbookId),
    body: [rule.description, JSON.stringify({ trigger: rule.trigger, conditions: rule.conditions, actions: rule.actions })].filter(Boolean).join("\n"),
    identifiers: rule.id,
    readable: readableOf(rule.actions, rule.description),
  });
  for (const reaction of world.reactions ?? []) documents.push({
    id: `reaction:${reaction.id}`, title: reaction.name, scope: scope(reaction.worldbookId),
    body: [reaction.description, JSON.stringify({ when: reaction.when, conditions: reaction.conditions, then: reaction.then, stopConditions: reaction.stopConditions })].filter(Boolean).join("\n"),
    identifiers: reaction.id,
    readable: readableOf(reaction.then, reaction.description),
  });
  for (const book of world.worldbooks ?? []) documents.push({
    id: `module:${book.id}`, title: book.name, scope: null,
    body: JSON.stringify(book), identifiers: book.id,
    readable: readableOf(book),
  });
  for (const track of world.audioTracks ?? []) documents.push({
    id: `audio:${track.id}`, title: track.name, scope: null,
    body: track.url ?? "", identifiers: track.id,
  });
  if (world.rootComponent) documents.push({
    id: "frontend", title: world.rootComponent.name, scope: null,
    body: Object.entries(world.rootComponent.files ?? {}).map(([name, text]) => `${name}\n${text}`).join("\n"),
    identifiers: world.rootComponent.id,
    // A screen built in the visual editor shows the words on it; hand-written
    // code shows nothing rather than a slice of JSX.
    readable: world.uiDoc ? readableOf(world.uiDoc.pages.map(page => page.elements)) : "",
  });
  return documents;
}

/** A saved audio track is searchable before any behavior wires it into the
 * graph. This descriptor belongs to the result list, never the canvas data. */
export function getWorldSearchNode(result: WorldSearchResult, graph: ReadonlyMap<string, GraphNode>): GraphNode | undefined {
  return graph.get(result.id) ?? (result.id.startsWith("audio:") ? {
    id: result.id, kind: "audio", title: result.title, ports: [], data: { trackId: result.id.slice("audio:".length) },
  } : undefined);
}

export function getUnmappedSearchPanel(id: string, graph: ReadonlyMap<string, GraphNode>): { kind: "audio"; id: string; panelId: "audio" } | null {
  return !graph.has(id) && id.startsWith("audio:") ? { kind: "audio", id: id.slice("audio:".length), panelId: "audio" } : null;
}

function excerptAround(body: string, terms: string[]): string {
  const text = body.replace(/\s+/g, " ").trim();
  const lower = text.toLocaleLowerCase();
  const hits = terms.map(term => lower.indexOf(term)).filter(index => index >= 0);
  if (!hits.length) return "";
  const start = Math.max(0, Math.min(...hits) - 28);
  const end = Math.min(text.length, start + 110);
  return `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

export function searchWorldContent(documents: WorldSearchDocument[], query: string): WorldSearchResult[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return documents.flatMap(document => {
    const title = document.title.toLocaleLowerCase();
    const haystack = `${title}\n${document.scope ?? ""}\n${document.identifiers}\n${document.body}`.toLocaleLowerCase();
    if (!terms.every(term => haystack.includes(term))) return [];
    const excerpt = excerptAround(document.readable ?? document.body, terms);
    return [{ ...document, excerpt, rank: terms.every(term => title.includes(term)) ? 0 : 1 }];
  }).sort((a, b) => a.rank - b.rank).map(({ rank: _rank, ...document }) => document);
}
