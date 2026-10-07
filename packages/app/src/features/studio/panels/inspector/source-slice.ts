/** Turning a `file:line` into something worth showing a person or an AI.
 *
 *  The inspector knows exactly one coordinate: the line whose JSX produced the
 *  DOM node under the cursor. A line alone is a poor handoff — "change this
 *  block" needs the whole element, and the AI needs to know which component it
 *  is standing in. Both are recovered here by reading the source text.
 */

export interface SourceSlice {
  file: string;
  /** 1-indexed, inclusive. */
  startLine: number;
  endLine: number;
  /** The lines themselves, unmodified. */
  text: string;
  /** Enclosing function/component name, when one can be identified. */
  component: string | null;
  /** True when the block hit the line cap rather than closing on its own. */
  truncated: boolean;
}

const MAX_BLOCK_LINES = 60;

/** Strip the things that would make angle brackets lie: string and template
 *  literal contents, and comments. Replaced with spaces so every column keeps
 *  its position — the caller reasons about the result positionally. */
function neutralize(line: string, state: { inBlockComment: boolean }): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (state.inBlockComment) {
      if (line.startsWith("*/", i)) {
        state.inBlockComment = false;
        out += "  ";
        i += 2;
      } else {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (line.startsWith("//", i)) {
      out += " ".repeat(line.length - i);
      break;
    }
    if (line.startsWith("/*", i)) {
      state.inBlockComment = true;
      out += "  ";
      i += 2;
      continue;
    }
    const ch = line[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      out += " ";
      i += 1;
      while (i < line.length) {
        if (line[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        if (line[i] === ch) {
          out += " ";
          i += 1;
          break;
        }
        out += " ";
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Net JSX element depth contributed by one (neutralized) line.
 *
 *  Counts openings `<Tag`, self-closings `/>`, and closings `</Tag>`. A
 *  self-closing tag registers as +1 then -1 and nets out, which is what makes
 *  a one-line element terminate immediately. */
function depthDelta(line: string): number {
  let delta = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== "<") continue;
    if (line[i + 1] === "/") {
      delta -= 1;
      continue;
    }
    // `<` used as less-than (`a < b`, `i<len`) is not an element. A JSX tag
    // name starts with a letter, `_`, `$`, or `>` for a fragment.
    if (/[A-Za-z_$>]/.test(line[i + 1] ?? "")) delta += 1;
  }
  for (let i = 0; i < line.length - 1; i++) {
    if (line[i] === "/" && line[i + 1] === ">") delta -= 1;
  }
  return delta;
}

const COMPONENT_DECL =
  /^\s*(?:export\s+)?(?:export\s+default\s+)?(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=)/;

/** The element that starts at `line`, plus the component it lives in. */
export function sliceSource(source: string, file: string, line: number): SourceSlice {
  const lines = source.split("\n");
  const startIdx = Math.max(0, Math.min(lines.length - 1, line - 1));

  const state = { inBlockComment: false };
  // Comment state has to be built from the top of the file, or a block comment
  // opened above the slice makes the first lines read as code.
  for (let i = 0; i < startIdx; i++) neutralize(lines[i], state);

  let depth = 0;
  let endIdx = startIdx;
  let truncated = true;
  for (let i = startIdx; i < lines.length && i - startIdx < MAX_BLOCK_LINES; i++) {
    depth += depthDelta(neutralize(lines[i], state));
    if (depth <= 0) {
      endIdx = i;
      truncated = false;
      break;
    }
    endIdx = i;
  }

  let component: string | null = null;
  for (let i = startIdx; i >= 0; i--) {
    const match = COMPONENT_DECL.exec(lines[i]);
    if (match) {
      const name = match[1] ?? match[2];
      // A component is capitalized by convention; a lowercase binding above the
      // JSX is a local, and naming it would mislead more than saying nothing.
      if (name && /^[A-Z]/.test(name)) {
        component = name;
        break;
      }
    }
  }

  return {
    file,
    startLine: startIdx + 1,
    endLine: endIdx + 1,
    text: lines.slice(startIdx, endIdx + 1).join("\n"),
    component,
    truncated,
  };
}

/** The block, rendered as the message the Studio AI receives.
 *
 *  Written as an instruction with an address rather than a pasted fragment: the
 *  agent has `read_custom_ui` and should re-read the file before editing it,
 *  so the snippet is orientation, not the source of truth it edits against. */
export function describeSliceForAgent(slice: SourceSlice, elementLabel: string): string {
  const where = slice.component
    ? `${slice.file} 第 ${slice.startLine}-${slice.endLine} 行（组件 ${slice.component}）`
    : `${slice.file} 第 ${slice.startLine}-${slice.endLine} 行`;
  return [
    `我在前端检查器里选中了这一块：${elementLabel}`,
    `位置：${where}`,
    slice.truncated ? "（片段在 60 行处截断，改之前请先读整个文件）" : "",
    "```tsx",
    slice.text,
    "```",
  ]
    .filter(Boolean)
    .join("\n");
}
