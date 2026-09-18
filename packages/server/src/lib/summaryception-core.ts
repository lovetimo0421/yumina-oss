import type { SessionSummaryImplementation } from "@yumina/shared";

// Fold the oldest snippets up once a layer exceeds this. 30 meant a layer held
// ~30 chunks before folding — unreachable for normal sessions, so the hierarchy
// never engaged. 10 lets Layer 1 begin once a session overflows its budget by
// ~10 chunks, so genuinely long sessions actually build a multi-layer pyramid.
export const SUMMARYCEPTION_SNIPPETS_PER_LAYER = 10;
export const SUMMARYCEPTION_SNIPPETS_PER_PROMOTION = 3;
export const SUMMARYCEPTION_MAX_LAYERS = 5;

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
