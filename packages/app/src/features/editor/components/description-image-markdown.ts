/**
 * Card descriptions hold uploaded pictures as `![](@asset:id)` — markdown the
 * Discover page already renders. The editor box shows each one as a short
 * `[Image 1]` tag instead, so creators never see or break the raw reference.
 *
 * Numbers come from a registry that only grows while the box is open: a tag
 * keeps its number even when the creator moves it above another, so text still
 * sitting in the box maps back to the same picture after a commit.
 */
const STORED_IMAGE_RE = /!\[\]\(@asset:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/gi;

export interface ImageTagRegistry {
  byId: Map<string, number>;
  byNumber: Map<number, string>;
  next: number;
}

export function createImageTagRegistry(): ImageTagRegistry {
  return { byId: new Map(), byNumber: new Map(), next: 1 };
}

function numberFor(registry: ImageTagRegistry, id: string): number {
  const key = id.toLowerCase();
  let n = registry.byId.get(key);
  if (n === undefined) {
    n = registry.next++;
    registry.byId.set(key, n);
    registry.byNumber.set(n, key);
  }
  return n;
}

export function storedImageMarkdown(id: string): string {
  return `![](@asset:${id})`;
}

export function imageTag(label: string, n: number): string {
  return `[${label} ${n}]`;
}

/** Uploaded pictures in the order they appear, each once. */
export function storedImageIds(stored: string): string[] {
  const ids: string[] = [];
  for (const match of stored.matchAll(STORED_IMAGE_RE)) {
    const id = match[1]!.toLowerCase();
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

export function toDisplayText(stored: string, registry: ImageTagRegistry, label: string): string {
  return stored.replace(STORED_IMAGE_RE, (_m, id: string) => imageTag(label, numberFor(registry, id)));
}

export function toStoredText(display: string, registry: ImageTagRegistry, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return display.replace(new RegExp(`\\[${escaped} (\\d+)\\]`, "g"), (m, n: string) => {
    const id = registry.byNumber.get(Number(n));
    return id ? storedImageMarkdown(id) : m;
  });
}

/** Register ids and return their tags, in order. */
export function tagsFor(ids: string[], registry: ImageTagRegistry, label: string): string[] {
  return ids.map((id) => imageTag(label, numberFor(registry, id)));
}

/**
 * Splice blocks into `text` at `[start, end)`, each on its own paragraph so
 * the renderer sees a standalone image line.
 */
export function insertBlocks(text: string, start: number, end: number, blocks: string[]): { text: string; caret: number } {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const lead = before.length === 0 || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const trail = after.length === 0 || after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
  const inserted = `${lead}${blocks.join("\n\n")}${trail}`;
  return { text: before + inserted + after, caret: before.length + inserted.length };
}

/** Take one picture out, leaving no gap of blank lines where it stood. */
export function removeStoredImage(stored: string, id: string): string {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return stored
    .replace(new RegExp(`\\n*!\\[\\]\\(@asset:${escaped}\\)\\n*`, "gi"), (m) => (m.startsWith("\n") && m.endsWith("\n") ? "\n\n" : ""))
    .replace(/^\n+/, "");
}
