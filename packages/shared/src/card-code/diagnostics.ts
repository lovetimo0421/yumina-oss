/** Serializable code diagnostics shared by the compiler, preview and sandbox.
 * Only compiler-provided source positions are trusted. Eval stack coordinates
 * describe generated JS, and must never be presented as creator source lines. */
export type DiagnosticPhase = "compile" | "resolve" | "load" | "render";
export interface CodeDiagnostic {
  phase: DiagnosticPhase;
  name: string;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  excerpt?: string;
  stack?: string;
  componentStack?: string;
  revision?: string;
  hint?: "import" | "reference";
}

const limit = (value: string, max: number) => value.length > max ? value.slice(0, max) + "\n… [truncated]" : value;
function text(value: unknown): string | undefined { return typeof value === "string" && value ? value : undefined; }

/** Stable content fingerprint, not an identifier for a user, session or world. */
export function codeRevision(files: Record<string, string>): string {
  let hash = 2166136261;
  for (const file of Object.keys(files).sort()) {
    const value = JSON.stringify([file, files[file]]);
    for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function sourceExcerpt(source: string, line: number, column?: number): string | undefined {
  const lines = source.split(/\r?\n/);
  if (!Number.isInteger(line) || line < 1 || line > lines.length) return;
  const start = Math.max(0, line - 3), end = Math.min(lines.length, line + 2);
  const width = String(end).length;
  return lines.slice(start, end).map((value, i) => {
    const n = start + i + 1;
    const prefix = `${n === line ? ">" : " "} ${String(n).padStart(width)} | `;
    const display = limit(value, 400);
    return prefix + display + (n === line && column && column <= 400
      ? `\n${" ".repeat(width + 5)}${" ".repeat(Math.max(0, column - 1))}^` : "");
  }).join("\n");
}

export function createCodeDiagnostic(error: unknown, options: {
  phase: DiagnosticPhase;
  file?: string;
  source?: string;
  files?: Record<string, string>;
  /** Only set when the error came directly from parsing this original source. */
  sourcePosition?: boolean;
  line?: number;
  column?: number;
  componentStack?: string | null;
}): CodeDiagnostic {
  const e = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const message = limit(text(e.message) ?? text(error) ?? "Unknown code error", 4000);
  const loc = options.sourcePosition && e.loc && typeof e.loc === "object"
    ? e.loc as { line?: unknown; column?: unknown } : undefined;
  // Sucrase's loc is one-based line / zero-based column. Do not parse (n:m)
  // from arbitrary error strings: user code can throw anything it likes.
  const line = options.line ?? (typeof loc?.line === "number" ? loc.line : undefined);
  const column = options.column ?? (typeof loc?.column === "number" ? loc.column + 1 : undefined);
  const validLine = line && Number.isInteger(line) && line > 0 ? line : undefined;
  const validColumn = column && Number.isInteger(column) && column > 0 ? column : undefined;
  const files = options.files ?? (options.file && options.source !== undefined ? { [options.file]: options.source } : undefined);
  return {
    phase: options.phase,
    name: limit(text(e.name) ?? "Error", 100),
    message,
    ...(options.file ? { file: limit(options.file, 300) } : {}),
    ...(validLine ? { line: validLine, ...(validColumn ? { column: validColumn } : {}) } : {}),
    ...(validLine && options.source !== undefined ? { excerpt: sourceExcerpt(options.source, validLine, validColumn) } : {}),
    ...(text(e.stack) ? { stack: limit(e.stack as string, 8000) } : {}),
    ...(options.componentStack ? { componentStack: limit(options.componentStack, 4000) } : {}),
    ...(files ? { revision: codeRevision(files) } : {}),
    ...(/Cannot use import statement outside a module|Unexpected token ['"]?export/i.test(message)
      ? { hint: "import" as const } : /is not defined/.test(message) ? { hint: "reference" as const } : {}),
  };
}

export function formatCodeDiagnostic(diagnostic: CodeDiagnostic): string {
  const d = diagnostic;
  return [
    `Phase: ${d.phase}`, `${d.name}: ${d.message}`,
    `Source: ${d.file ?? "not located"}${d.line ? `:${d.line}${d.column ? `:${d.column}` : ""}` : ""}`,
    d.revision && `Code revision: ${d.revision}`,
    d.excerpt && `Source excerpt:\n${d.excerpt}`,
    d.stack && `Stack (may refer to generated code):\n${d.stack}`,
    d.componentStack && `Component stack:\n${d.componentStack}`,
  ].filter(Boolean).join("\n\n");
}
