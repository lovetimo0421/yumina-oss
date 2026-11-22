// Reading a director's script while it is still being written: the JSON streams in, and each part
// that is complete (the scene states, the new cast, every finished shot) is taken as soon as its
// closing bracket arrives, so a film's first shot starts filming ~10 s before the script is done.

/** End of the JSON value starting at `start` (an object or array), or -1 while it is incomplete. */
function valueEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Where the value of top-level key `key` starts ("{" or "["), or -1. */
function keyValueStart(text: string, key: string): number {
  const m = new RegExp(`"${key}"\\s*:\\s*([\\[{])`).exec(text);
  return m ? m.index + m[0].length - 1 : -1;
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // The same repairs callDirector makes: a trailing comma, curly quotes inside Chinese text.
    try { return JSON.parse(text.replace(/,\s*([}\]])/g, "$1").replace(/[“”]/g, "\\\"")); } catch { return undefined; }
  }
}

/** A complete top-level value (`states`, `newCast`, `state`), or undefined while it is still being written. */
export function scriptValue(text: string, key: string): unknown {
  if (key === "state") {
    const m = /"state"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
    return m ? parse(`"${m[1]}"`) : undefined;
  }
  const start = keyValueStart(text, key);
  if (start < 0) return undefined;
  const end = valueEnd(text, start);
  return end < 0 ? undefined : parse(text.slice(start, end));
}

/** The shots of the "beats" array that are complete so far, in the order written. */
export function scriptBeats(text: string): Record<string, unknown>[] {
  const start = keyValueStart(text, "beats");
  if (start < 0 || text[start] !== "[") return [];
  const out: Record<string, unknown>[] = [];
  let i = start + 1;
  for (;;) {
    while (i < text.length && /[\s,]/.test(text[i]!)) i++;
    if (i >= text.length || text[i] !== "{") return out;
    const end = valueEnd(text, i);
    if (end < 0) return out;
    const beat = parse(text.slice(i, end));
    if (beat && typeof beat === "object") out.push(beat as Record<string, unknown>);
    i = end;
  }
}
