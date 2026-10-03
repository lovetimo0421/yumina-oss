/**
 * Turns creator- and member-written text (world descriptions, thread posts,
 * bios) into the plain sentence a search result or share card shows.
 *
 * The words stay the author's. This only removes markdown symbols and picks
 * how much of the text fits.
 */

const DEFAULT_MAX = 155;
const DEFAULT_MIN = 90;

/** Strip markdown and HTML so only the words remain, on one line. */
export function cleanMarkdown(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = raw.replace(/\r\n?/g, "\n");
  s = s.replace(/```[\s\S]*?```/g, " ");
  s = s.replace(/`([^`]*)`/g, "$1");
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/<[^>]+>/g, " ");
  s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "");
  s = s.replace(/^[ \t]{0,3}>[ \t]?/gm, "");
  s = s.replace(/^[ \t]*(?:[-*+]|\d+\.)[ \t]+/gm, "");
  s = s.replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, " ");
  s = s.replace(/(\*\*|__)(.+?)\1/g, "$2");
  s = s.replace(/~~(.+?)~~/g, "$1");
  s = s.replace(/(^|[\s(（「])[*_](?=\S)(.+?)(?<=\S)[*_](?=$|[\s.,;:!?)）」])/g, "$1$2");
  s = s.replace(/\*{2,}|_{2,}|#{2,}/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/**
 * If the text opens with a heading that only repeats the page's own name,
 * drop that line: the name is already the title.
 */
export function stripLeadingTitle(raw: string | null | undefined, name: string | null | undefined): string {
  if (!raw) return "";
  if (!name) return raw;
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === "") i++;
  const first = lines[i];
  if (first === undefined) return raw;
  const bare = cleanMarkdown(first).replace(/[:：.。!！]+$/, "").trim().toLowerCase();
  if (bare && bare === name.trim().toLowerCase()) {
    return lines.slice(i + 1).join("\n");
  }
  return raw;
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?。！？])\s*(?=\S)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Pick the opening of a text that fits a search snippet.
 *
 * Whole sentences are kept while they fit under `max`. If that leaves less
 * than `min` characters and there is more text, the snippet runs on to a
 * word boundary near `max` and ends with an ellipsis, so a long first
 * sentence still gives the reader something.
 */
export function summarizeText(
  raw: string | null | undefined,
  options: { max?: number; min?: number } = {},
): string {
  const max = options.max ?? DEFAULT_MAX;
  const min = options.min ?? DEFAULT_MIN;
  const clean = cleanMarkdown(raw);
  if (!clean) return "";
  if (clean.length <= max) return clean;

  let out = "";
  for (const sentence of splitSentences(clean)) {
    const next = out ? `${out} ${sentence}` : sentence;
    if (next.length > max) break;
    out = next;
  }
  if (out.length >= min) return out;

  const room = max - 1;
  const cut = clean.slice(0, room);
  const lastSpace = cut.lastIndexOf(" ");
  const hasSpaces = /\s/.test(clean);
  const body = hasSpaces && lastSpace > min ? cut.slice(0, lastSpace) : cut;
  return `${body.replace(/[\s,;:、，；：]+$/, "")}…`;
}
