/**
 * TSX syntax validation with code-window diagnostics.
 *
 * Storage-agnostic by design: every function operates on a source STRING, never
 * on the world/JSONB. That is the durable seam — if the studio agent ever moves
 * to a real filesystem substrate or a rented harness with a pluggable FS bridge,
 * these validators keep working unchanged (they only ever see file contents).
 *
 * Purpose: kill the "unclosed bracket on a 4,500-line index.tsx" failure class.
 * The agent could previously only see a bare line number on a compile failure,
 * so it re-read the whole file (triggering the read-spiral). Now every syntax
 * error carries a ready-to-read code window with a caret, so the agent can fix
 * the break without re-reading the file.
 */

import { transform } from "sucrase";

export interface TsxIssue {
  /** 1-based line number of the syntax error (0 if not parseable from the message). */
  line: number;
  /** Column reported by the parser (0-based, best-effort). */
  col: number;
  /** Cleaned parser message. */
  message: string;
  /** A code window around the error with line numbers + a caret, or "" if line is unknown. */
  snippet: string;
}

const CONTEXT_BEFORE = 6;
const CONTEXT_AFTER = 3;

/**
 * Validate a TSX source string. Returns [] when it parses cleanly, otherwise a
 * single issue (Sucrase throws on the first syntax error). Empty/whitespace
 * source is treated as "no syntax error" — emptiness is a separate concern
 * handled by the write path, not a syntax error.
 */
export function validateTsx(code: string): TsxIssue[] {
  if (!code || !code.trim()) return [];
  try {
    transform(code, { transforms: ["typescript", "jsx"], jsxRuntime: "classic", production: true });
    return [];
  } catch (e) {
    const raw = e instanceof Error ? e.message : "TSX syntax error";
    const m = raw.match(/\((\d+):(\d+)\)/);
    const line = m ? Number(m[1]) : 0;
    const col = m ? Number(m[2]) : 0;
    return [{ line, col, message: cleanMessage(raw), snippet: line > 0 ? buildSnippet(code, line, col) : "" }];
  }
}

function cleanMessage(msg: string): string {
  // Sucrase sometimes prefixes "Error transforming <file>: ". Strip that noise.
  return msg.replace(/^Error transforming[^:]*:\s*/, "").trim();
}

/** Build a numbered code window around `line` (1-based) with a caret at `col`.
 *  `line` is clamped into [1, lines.length] so an error reported past EOF (e.g. an
 *  unclosed bracket where the parser points one line beyond the last) still yields a
 *  window instead of an empty string. */
export function buildSnippet(code: string, line: number, col: number): string {
  const lines = code.split("\n");
  const focus = Math.min(Math.max(1, line), lines.length);
  const start = Math.max(1, focus - CONTEXT_BEFORE);
  const end = Math.min(lines.length, focus + CONTEXT_AFTER);
  const width = String(end).length;
  const out: string[] = [];
  for (let n = start; n <= end; n++) {
    const text = lines[n - 1] ?? "";
    const marker = n === focus ? ">" : " ";
    out.push(`${marker} ${String(n).padStart(width)} | ${text}`);
    if (n === focus && col >= 0) {
      out.push(`  ${" ".repeat(width)} | ${" ".repeat(Math.max(0, col))}^`);
    }
  }
  return out.join("\n");
}

/** One-line + snippet rendering for tool error messages. */
export function formatTsxIssue(issue: TsxIssue): string {
  const head = `syntax error at line ${issue.line}:${issue.col} — ${issue.message}`;
  return issue.snippet ? `${head}\n${issue.snippet}` : head;
}
