import type { SessionSummaryImplementation } from "@yumina/shared";

// Fold the oldest snippets up once a layer exceeds this. 30 meant a layer held
// ~30 chunks before folding — unreachable for normal sessions, so the hierarchy
// never engaged. 10 lets Layer 1 begin once a session overflows its budget by
// ~10 chunks, so genuinely long sessions actually build a multi-layer pyramid.
export const SUMMARYCEPTION_SNIPPETS_PER_LAYER = 10;
export const SUMMARYCEPTION_SNIPPETS_PER_PROMOTION = 3;
export const SUMMARYCEPTION_MAX_LAYERS = 5;

/** sourceHash prefixes that mark a snippet's provenance. */
export const STALE_SNIPPET_PREFIX = "stale:";
export const LEGACY_SNIPPET_PREFIX = "legacy:";

/** A snippet whose passage was edited or deleted after it was written; it is
 *  revised (one call) before the recap grows again. */
export function isStaleSnippet(snippet: { sourceHash: string | null }): boolean {
  return !!snippet.sourceHash?.startsWith(STALE_SNIPPET_PREFIX);
}

/** The changed message ids recorded on a stale snippet. */
export function staleSnippetMessageIds(sourceHash: string | null): string[] {
  if (!sourceHash?.startsWith(STALE_SNIPPET_PREFIX)) return [];
  return sourceHash.slice(STALE_SNIPPET_PREFIX.length).split(",").filter(Boolean);
}

export function markSnippetStale(sourceHash: string | null, messageId: string): string {
  const ids = new Set(staleSnippetMessageIds(sourceHash));
  ids.add(messageId);
  // Bounded: a snippet edited many times is revised from its source anyway.
  return STALE_SNIPPET_PREFIX + [...ids].slice(-20).join(",");
}

/**
 * Which layer to shrink next when the recap is over its budget: the highest
 * layer holding at least two snippets whose two oldest can be merged. Higher
 * layers hold older story, so the oldest chapters are compressed first. Null
 * when nothing can be merged (every layer down to one snippet).
 */
export function pickLayerToShrink(
  snippets: Array<SummaryceptionSnippetLike & { sourceHash: string | null; sourceEndMessageId?: string | null }>,
): number | null {
  const layers = [...new Set(snippets.map((s) => s.layerIndex))].sort((a, b) => b - a);
  for (const layer of layers) {
    const rows = snippets.filter((s) => s.layerIndex === layer).sort((a, b) => a.snippetOrder - b.snippetOrder);
    if (rows.length < 2) continue;
    if (rows.slice(0, 2).every(isMergeableSnippet)) return layer;
  }
  return null;
}

/** Complete, current text: not a truncated preview, not awaiting revision. */
export function isMergeableSnippet(snippet: { sourceHash: string | null; sourceEndMessageId?: string | null }): boolean {
  if (snippet.sourceEndMessageId === null) return false;
  const hash = snippet.sourceHash ?? "";
  return !hash.startsWith("partial:") && !hash.startsWith("manual:partial:") && !hash.startsWith(STALE_SNIPPET_PREFIX);
}

export type SummaryceptionSnippetLike = {
  layerIndex: number;
  snippetOrder: number;
  text: string;
};

export function normalizeSessionSummaryImplementation(input: unknown): SessionSummaryImplementation {
  return input === "summaryception" ? "summaryception" : "localdev";
}

export function assembleSummaryceptionText(snippets: SummaryceptionSnippetLike[]): string {
  const ordered = [...snippets]
    .filter((snippet) => snippet.text.trim())
    .sort((a, b) => {
      if (a.layerIndex !== b.layerIndex) return b.layerIndex - a.layerIndex;
      return a.snippetOrder - b.snippetOrder;
    })
    .map((snippet) => snippet.text.trim());
  return ordered.join(" ");
}

export function formatSummaryceptionForPrompt(snippets: SummaryceptionSnippetLike[]): string | null {
  const summary = assembleSummaryceptionText(snippets);
  return summary
    ? `<summary>\n${summary}\n</summary>\n[The following is the current live roleplay, continuing from the above summary.]`
    : null;
}

/**
 * What one recap call reads of the recap so far: the chapters just before
 * the passage (up to `tailTokens`) and the story's opening chapters (up to
 * `headTokens`), with the middle left out. Every call used to read the whole
 * recap, so a call cost as much as the recap was long: one 631-call backfill
 * grew from 14k to 41k tokens a call (2026-11-03). `snippets` are the
 * chapters older than the passage, in any order.
 */
export function assembleRecapContext(
  snippets: SummaryceptionSnippetLike[],
  estimateTokens: (text: string) => number,
  tailTokens: number,
  headTokens: number,
): string {
  const ordered = [...snippets]
    .filter((snippet) => snippet.text.trim())
    .sort((a, b) => (a.layerIndex !== b.layerIndex ? b.layerIndex - a.layerIndex : a.snippetOrder - b.snippetOrder))
    .map((snippet) => snippet.text.trim());
  const sizes = ordered.map(estimateTokens);
  if (sizes.reduce((sum, n) => sum + n, 0) <= tailTokens + headTokens) return ordered.join(" ");
  let start = ordered.length;
  let used = 0;
  while (start > 0 && used + sizes[start - 1]! <= tailTokens) used += sizes[--start]!;
  const tail = ordered.slice(start);
  if (tail.length === 0) {
    // The newest chapter alone is longer than the window (an old carried-over
    // summary): its newest part.
    start = ordered.length - 1;
    const last = ordered[start]!;
    tail.push(last.slice(-Math.max(1, Math.floor(last.length * tailTokens / sizes[start]!))));
  }
  let headEnd = 0;
  let headUsed = 0;
  while (headEnd < start && headUsed + sizes[headEnd]! <= headTokens) headUsed += sizes[headEnd++]!;
  return [...ordered.slice(0, headEnd), ...(headEnd < start ? ["…"] : []), ...tail].join(" ");
}

/** Text cut off at the token cap, ended at its last full sentence or clause
 *  (when that keeps most of it). */
export function endAtLastSentence(text: string): string {
  const trimmed = text.trim();
  const match = /[\s\S]*[。！？!?；;.…」』”)）]/.exec(trimmed);
  if (!match) return trimmed;
  const end = match[0].length;
  return end >= trimmed.length * 0.6 ? trimmed.slice(0, end).trim() : trimmed;
}
