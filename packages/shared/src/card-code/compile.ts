/**
 * Card code compiler: a rootComponent's TSX files → the one JS string the play
 * sandbox runs. Shared so the browser (Studio save, live preview) and the
 * server (stamping cards that were saved without it) emit the same bytes.
 * Pure: Sucrase and string work, no React, no DOM.
 *
 * Multi-file bundles resolve imports between files in a virtual file system,
 * compile each file independently, and stitch them together. Each imported
 * file becomes an IIFE in the bundled output:
 *   const __mod_stat_bar = (() => { ...compiled code...; return exports; })();
 *
 * The entry file's import statements become variable assignments:
 *   const StatBar = __mod_stat_bar.default;
 *   const { Foo, Bar } = __mod_utils;
 */

import { transform } from "sucrase";
import { codeRevision, createCodeDiagnostic, type CodeDiagnostic } from "./diagnostics.js";
import { COMPILED_FORMAT_VERSION, hashRootFiles, type CompiledRoot } from "./format.js";

export interface BundleInput {
  files: Record<string, string>;
  entryFile: string;
  /** Studio-only: compile so every rendered DOM node carries the source line
   *  that produced it (`data-yc-src="index.tsx:42"`), which is what lets the
   *  frontend inspector answer "where does this block live in the code?".
   *
   *  Sucrase's non-production JSX output attaches `__source: {fileName,
   *  lineNumber}` to each createElement call; the app's `inspectReact` turns that
   *  into the attribute and strips the raw props so they never reach the DOM.
   *
   *  NEVER set this on the play path. Play compiles the same files with
   *  `production: true` (bundleTSX → sandbox), so the bytes a player runs are
   *  unchanged by the existence of this mode. */
  inspect?: boolean;
}

/** Parent-side multi-file bundle to a single JS string the sandbox can feed
 *  into buildComponent without pulling Sucrase or the bundler into its bundle.
 *  `code` is the concatenated IIFEs + import resolutions + entry body + return. */
export interface BundleCodeResult {
  code: string | null;
  error: string | null;
  fileErrors: Record<string, string>;
  diagnostic?: CodeDiagnostic;
}

// ── Import Parsing ───────────────────────────────────────────────────

export interface ParsedImport {
  offset: number;
  /** Full import statement text (for replacement) */
  statement: string;
  /** Default import name: `import Foo from './foo'` → "Foo" */
  defaultImport: string | null;
  /** Named imports: `import { A, B as C } from './foo'` → [["A","A"], ["B","C"]] */
  namedImports: Array<[string, string]>;
  /** Namespace import: `import * as Foo from './foo'` → "Foo" */
  namespaceImport: string | null;
  /** Raw specifier: './foo' */
  specifier: string;
}

/**
 * Parse import statements from code.
 * Only handles relative imports (./xxx) — platform globals don't need import.
 */
export function parseImports(code: string): ParsedImport[] {
  const imports: ParsedImport[] = [];

  // Match: import [default] [{ named }] [* as ns] from './path'
  const importRegex = /import\s+(?:(?:([A-Za-z_$][\w$]*)(?:\s*,\s*)?)?(?:\{([^}]*)\})?(?:\*\s+as\s+([A-Za-z_$][\w$]*))?)\s+from\s+['"](\.[^'"]+)['"]\s*;?/g;

  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(code)) !== null) {
    const [statement, defaultName, namedStr, nsName, specifier] = match;

    const namedImports: Array<[string, string]> = [];
    if (namedStr) {
      for (const part of namedStr.split(",")) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const asMatch = trimmed.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
        if (asMatch) {
          namedImports.push([asMatch[1]!, asMatch[2]!]);
        } else {
          namedImports.push([trimmed, trimmed]);
        }
      }
    }

    imports.push({
      offset: match.index,
      statement,
      defaultImport: defaultName || null,
      namedImports,
      namespaceImport: nsName || null,
      specifier: specifier!,
    });
  }

  return imports;
}

// ── File Resolution ──────────────────────────────────────────────────

const EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ""];

/** Normalize `dir + specifier` using `.` / `..` semantics. */
function joinPath(dir: string, specifier: string): string {
  const parts = dir ? dir.split("/").filter(Boolean) : [];
  for (const seg of specifier.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

/**
 * Resolve a specifier like './stat-bar' or './components/foo' to an actual
 * file in the virtual FS. Relative specifiers resolve against the importing
 * file's directory so bundles can live under namespaced subfolders.
 */
export function resolveFile(
  specifier: string,
  parentFile: string,
  files: Record<string, string>,
): string | null {
  const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
  const parentDir = parentFile.includes("/")
    ? parentFile.slice(0, parentFile.lastIndexOf("/"))
    : "";
  const base = isRelative ? joinPath(parentDir, specifier) : specifier;

  for (const ext of EXTENSIONS) {
    const candidate = base + ext;
    if (candidate in files) return candidate;
  }

  // Try as directory with index
  for (const ext of EXTENSIONS) {
    const candidate = `${base}/index${ext}`;
    if (candidate in files) return candidate;
  }

  return null;
}

// ── Per-File Compilation ─────────────────────────────────────────────

/**
 * Strip TypeScript type annotations (same as tsx-compiler.ts).
 */
function stripTypeScriptForBundle(code: string): string {
  let result = code;
  result = result.replace(/^(?:export\s+)?(?:interface|type)\s+\w+[\s\S]*?(?:^}|;\s*$)/gm, "");
  result = result.replace(/<[A-Z]\w*(?:\s*\|\s*\w+)*(?:\s*,\s*[A-Z]\w*(?:\s*\|\s*\w+)*)*>/g, "");
  result = result.replace(/\s+as\s+\w+(?:\[\])?/g, "");
  result = result.replace(/:\s*(?:React\.)?(?:FC|ComponentType|ReactNode|CSSProperties|JSX\.Element)(?:<[^>]*>)?/g, "");
  result = result.replace(
    /(\(\s*(?:\{[^}]*\}|\w+))\s*:\s*(?:\{[^}]*\}|[\w<>[\]|&\s.]+?)(\s*[,)])/g,
    "$1$2",
  );
  result = result.replace(/\)\s*:\s*[\w<>[\]|&\s.]+?\s*(?=\{|=>)/g, ") ");
  return result;
}

export interface CompiledFile {
  /** Transformed JS code (no imports/exports) */
  code: string;
  /** Name of the default export (if any) */
  defaultExportName: string | null;
  /** Named exports: original name → local variable name */
  namedExports: Map<string, string>;
}

/**
 * Compile a single file: strip types, transform JSX, strip imports/exports.
 *
 * `inspect` flips Sucrase out of production mode so each JSX element carries
 * `__source`. Only the Studio inspector asks for it — see BundleInput.inspect.
 * The emitted `const _jsxFileName = …` is safe in every slot the bundler uses:
 * non-entry files are wrapped in their own IIFE, and the entry is the only
 * module emitted at factory top level, so the name can never collide.
 */
export function compileFile(
  filename: string,
  source: string,
  inspect = false,
): CompiledFile | { error: string; diagnostic: CodeDiagnostic } {
  let code = source;
  const jsxOpts = { production: !inspect, filePath: inspect ? filename : undefined };

  // Try Sucrase transform with fallback
  try {
    const result = transform(code, {
      transforms: ["typescript", "jsx"],
      jsxRuntime: "classic",
      ...jsxOpts,
    });
    code = result.code;
  } catch (firstError) {
    try {
      code = stripTypeScriptForBundle(source);
      const result = transform(code, {
        transforms: ["typescript", "jsx"],
        jsxRuntime: "classic",
        ...jsxOpts,
      });
      code = result.code;
    } catch {
      try {
        const result = transform(code, {
          transforms: ["jsx"],
          jsxRuntime: "classic",
          ...jsxOpts,
        });
        code = result.code;
      } catch {
        const diagnostic = createCodeDiagnostic(firstError, { phase: "compile", file: filename, source, sourcePosition: true });
        return { error: `${filename}: ${diagnostic.message}`, diagnostic };
      }
    }
  }

  // Strip import statements (we handle imports at the bundle level)
  code = code.replace(/import\s+.*?\s+from\s+['"][^'"]+['"]\s*;?/g, "");
  // Also strip bare imports: import './styles.css'
  code = code.replace(/import\s+['"][^'"]+['"]\s*;?/g, "");

  // Detect and strip exports, capture names
  let defaultExportName: string | null = null;
  const namedExports = new Map<string, string>();

  // export default function Foo() → function Foo()
  code = code.replace(
    /export\s+default\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
    (m, name) => { defaultExportName = name; return m.replace(/^export\s+default\s+/, ""); },
  );

  // export default class Foo → class Foo
  if (!defaultExportName) {
    code = code.replace(
      /export\s+default\s+class\s+([A-Za-z_$][\w$]*)/,
      (m, name) => { defaultExportName = name; return m.replace(/^export\s+default\s+/, ""); },
    );
  }

  // export default <expr> → var __default__ = <expr>
  // Guard: if regex 1 already captured a named default, skip — otherwise a
  // surviving "export default" inside a comment/string would overwrite
  // defaultExportName to a variable that was never actually declared.
  if (!defaultExportName) {
    code = code.replace(
      /export\s+default\s+/,
      () => { defaultExportName = "__yumina_default__"; return "var __yumina_default__ = "; },
    );
  }

  // export function Foo() → function Foo(); track as named export
  code = code.replace(
    /export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g,
    (m, name) => { namedExports.set(name, name); return m.replace(/^export\s+/, ""); },
  );

  // export const Foo = ... → const Foo = ...; track as named export
  code = code.replace(
    /export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    (_, kind, name) => { namedExports.set(name, name); return `${kind} ${name}`; },
  );

  // export class Foo → class Foo; track as named export
  code = code.replace(
    /export\s+class\s+([A-Za-z_$][\w$]*)/g,
    (m, name) => { namedExports.set(name, name); return m.replace(/^export\s+/, ""); },
  );

  // export { Foo, Bar } → strip, track names
  code = code.replace(
    /export\s*\{([^}]+)\}\s*;?/g,
    (_, names: string) => {
      for (const part of names.split(",")) {
        const trimmed = part.trim();
        const asMatch = trimmed.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
        if (asMatch) {
          namedExports.set(asMatch[2]!, asMatch[1]!);
        } else if (trimmed) {
          namedExports.set(trimmed, trimmed);
        }
      }
      return "";
    },
  );

  return { code, defaultExportName, namedExports };
}

// ── Module Name Generation ───────────────────────────────────────────

function toModuleName(filename: string): string {
  return "__mod_" + filename
    .replace(/\.[^.]+$/, "")         // strip extension
    .replace(/[^a-zA-Z0-9_]/g, "_") // sanitize
    .replace(/^_+|_+$/g, "");       // trim underscores
}

// ── Bundler ──────────────────────────────────────────────────────────

/** Parent-side: produce a single JS string from a multi-file TSX bundle.
 *  The sandbox consumes this with buildComponent (no Sucrase in the sandbox).
 *  Performance: keeps the ~956K Sucrase chunk and the bundler off the iframe's
 *  critical path for multi-file root components. */
export function bundleTSX(input: BundleInput): BundleCodeResult {
  // `inspect` is dropped on the floor here, deliberately. This is the code the
  // sandbox evaluates against the REAL React, which would happily render
  // `__source` and `__self` as literal attributes on every element a player
  // sees. The attribute only makes sense paired with the wrapping React that
  // bundleAndCompile injects, so the flag cannot cross this boundary.
  return assembleBundle({ files: input.files, entryFile: input.entryFile });
}

/** Steps 1–4 of the multi-file bundle: graph → topo → per-file transform → stitch.
 *  Shared between bundleTSX (parent, returns JS string) and bundleAndCompile
 *  (parent, returns live React component for studio preview). */
export function assembleBundle(input: BundleInput): BundleCodeResult {
  const { files, entryFile } = input;
  const fileErrors: Record<string, string> = {};

  if (!(entryFile in files)) {
    const error = `Entry file '${entryFile}' not found`;
    return { code: null, error, fileErrors, diagnostic: createCodeDiagnostic(error, { phase: "resolve", file: entryFile, files }) };
  }

  interface DepNode {
    filename: string;
    imports: ParsedImport[];
    resolvedDeps: Map<string, string>;
  }

  const graph = new Map<string, DepNode>();
  const compilationStack: string[] = [];
  let graphError: string | null = null;
  let graphDiagnostic: CodeDiagnostic | undefined;

  function buildGraph(filename: string): void {
    if (graphError) return;
    if (graph.has(filename)) return;

    if (compilationStack.includes(filename)) {
      graphError = `Circular import: ${[...compilationStack, filename].join(" → ")}`;
      return;
    }

    const source = files[filename];
    if (source === undefined) {
      graphError = `File '${filename}' not found`;
      return;
    }

    compilationStack.push(filename);

    const imports = parseImports(source);
    const resolvedDeps = new Map<string, string>();

    for (const imp of imports) {
      const resolved = resolveFile(imp.specifier, filename, files);
      if (!resolved) {
        graphError = `Cannot resolve '${imp.specifier}' from '${filename}' — file not found`;
        const before = source.slice(0, imp.offset);
        graphDiagnostic = createCodeDiagnostic(graphError, {
          phase: "resolve", file: filename, source, files,
          line: before.split("\n").length, column: imp.offset - before.lastIndexOf("\n"),
        });
        return;
      }
      resolvedDeps.set(imp.specifier, resolved);
      buildGraph(resolved);
    }

    compilationStack.pop();
    graph.set(filename, { filename, imports, resolvedDeps });
  }

  buildGraph(entryFile);
  if (graphError) return { code: null, error: graphError, fileErrors, diagnostic: graphDiagnostic ?? createCodeDiagnostic(graphError, { phase: "resolve", files }) };

  const compileOrder: string[] = [];
  const visited = new Set<string>();

  function topoSort(filename: string): void {
    if (visited.has(filename)) return;
    visited.add(filename);
    const node = graph.get(filename);
    if (!node) return;
    for (const dep of node.resolvedDeps.values()) topoSort(dep);
    compileOrder.push(filename);
  }

  topoSort(entryFile);

  const compiledFiles = new Map<string, CompiledFile>();
  for (const filename of compileOrder) {
    const result = compileFile(filename, files[filename]!, input.inspect);
    if ("error" in result) {
      fileErrors[filename] = result.error;
      return { code: null, error: result.error, fileErrors, diagnostic: { ...result.diagnostic, revision: codeRevision(files) } };
    }
    compiledFiles.set(filename, result);
  }

  const parts: string[] = [];

  for (const filename of compileOrder) {
    if (filename === entryFile) continue;
    const node = graph.get(filename)!;
    const compiled = compiledFiles.get(filename)!;
    const modName = toModuleName(filename);

    // Bind each of this file's imports inside the IIFE. The dep module is
    // declared as an outer `var __mod_...` earlier in the bundle (topo order
    // guarantees deps are emitted before their consumers), so these
    // assignments resolve on IIFE execution.
    const importLines: string[] = [];
    for (const imp of node.imports) {
      const depFilename = node.resolvedDeps.get(imp.specifier)!;
      const depModName = toModuleName(depFilename);
      if (imp.defaultImport) {
        importLines.push(`var ${imp.defaultImport} = ${depModName}.default;`);
      }
      if (imp.namespaceImport) {
        importLines.push(`var ${imp.namespaceImport} = ${depModName};`);
      }
      for (const [originalName, localName] of imp.namedImports) {
        importLines.push(`var ${localName} = ${depModName}["${originalName}"];`);
      }
    }

    const exportLines: string[] = [];
    if (compiled.defaultExportName) {
      exportLines.push(`__exports.default = ${compiled.defaultExportName};`);
    }
    for (const [exportName, localName] of compiled.namedExports) {
      exportLines.push(`__exports["${exportName}"] = ${localName};`);
    }
    parts.push(`var ${modName} = (function() {`);
    parts.push(`  var __exports = {};`);
    if (importLines.length) parts.push(`  ${importLines.join("\n  ")}`);
    parts.push(`  ${compiled.code}`);
    parts.push(`  ${exportLines.join("\n  ")}`);
    parts.push(`  return __exports;`);
    parts.push(`})();`);
    parts.push("");
  }

  const entryNode = graph.get(entryFile)!;
  const entryCompiled = compiledFiles.get(entryFile)!;

  for (const imp of entryNode.imports) {
    const resolvedFilename = entryNode.resolvedDeps.get(imp.specifier)!;
    const modName = toModuleName(resolvedFilename);
    if (imp.defaultImport) parts.push(`var ${imp.defaultImport} = ${modName}.default;`);
    if (imp.namespaceImport) parts.push(`var ${imp.namespaceImport} = ${modName};`);
    for (const [originalName, localName] of imp.namedImports) {
      parts.push(`var ${localName} = ${modName}["${originalName}"];`);
    }
  }

  parts.push(entryCompiled.code);

  const fallback = entryCompiled.defaultExportName ?? "undefined";
  parts.push("");
  parts.push(`return typeof exports !== 'undefined' && exports.default ? exports.default`);
  parts.push(`  : typeof module !== 'undefined' && module.exports && module.exports.default ? module.exports.default`);
  parts.push(`  : ${fallback};`);

  return { code: parts.join("\n"), error: null, fileErrors };
}


/**
 * Strip TypeScript-specific syntax that Sucrase may struggle with in JSX context.
 * This transparently handles AI-generated TypeScript so creators don't need to
 * think about it — generics, type annotations, etc. are removed before compilation.
 */
function stripTypeScriptForComponent(code: string): string {
  let result = code;

  // Remove interface/type declarations (multi-line)
  result = result.replace(/^\s*(?:export\s+)?(?:interface|type)\s+\w+[^{]*\{[^}]*\}/gm, "");
  // Remove single-line type aliases: type Foo = string | number;
  result = result.replace(/^\s*(?:export\s+)?type\s+\w+\s*=[^;\n]+;?/gm, "");

  // Remove generic type parameters from function calls: useState<string | null>() → useState()
  // Handles nested generics: Record<string, Array<number>> by matching balanced angle brackets
  result = result.replace(/(\w+)\s*<([^>]*(?:<[^>]*>[^>]*)*)>\s*\(/g, "$1(");

  // Remove 'as Type' assertions: value as string → value
  // Be careful not to match inside strings
  result = result.replace(/\bas\s+(?:const|[A-Z]\w*(?:\[\])?(?:\s*\|\s*\w+)*)/g, "");

  // Remove type annotations from function parameters: (x: string, y: number) → (x, y)
  result = result.replace(/(\w+)\s*:\s*(?:string|number|boolean|any|void|null|undefined|Record|Array|object|unknown|never)(?:<[^>]*>)?(?:\s*\|\s*(?:string|number|boolean|null|undefined|unknown|never)(?:<[^>]*>)?)*/g, "$1");

  // Remove return type annotations: function foo(): string { → function foo() {
  result = result.replace(/\)\s*:\s*(?:JSX\.Element|React\.ReactNode|React\.ReactElement|string|number|boolean|void|null|any)\s*(?:\{|\=>)/g, (match) => {
    return match.endsWith("{") ? ") {" : ") =>";
  });

  return result;
}

/** Parent-side TSX → JS transform. The compiled JS can be fed straight into
 *  buildComponent (in either the parent or the sandbox). Exposed separately so
 *  the parent can pre-compile before posting an install message, keeping the
 *  sandbox bundle free of Sucrase. */
export interface TransformResult {
  code: string | null;
  error: string | null;
  diagnostic?: CodeDiagnostic;
}

export function transformTSX(code: string, file?: string): TransformResult {
  try {
    const result = transform(code, {
      transforms: ["typescript", "jsx"],
      jsxRuntime: "classic",
      production: true,
    });
    return { code: result.code, error: null };
  } catch (firstError) {
    // Some AI-authored TSX confuses Sucrase. Fall back to the lossy stripper.
    const cleanedCode = stripTypeScriptForComponent(code);
    try {
      const result = transform(cleanedCode, {
        transforms: ["typescript", "jsx"],
        jsxRuntime: "classic",
        production: true,
      });
      return { code: result.code, error: null };
    } catch {
      try {
        const result = transform(cleanedCode, {
          transforms: ["jsx"],
          jsxRuntime: "classic",
          production: true,
        });
        return { code: result.code, error: null };
      } catch {
        // Fallback transforms remove lines/types. The original parser error is
        // the only one whose position can be used against the creator's source.
        const diagnostic = createCodeDiagnostic(firstError, { phase: "compile", file, source: code, sourcePosition: true });
        return {
          code: null,
          error: diagnostic.message,
          diagnostic,
        };
      }
    }
  }
}

/** The stored `compiled` blob for a rootComponent, or null when its code does
 *  not compile (play then compiles live and shows the error). One file is a
 *  plain transform; several are bundled. Same choice the editor has always
 *  made at save time. */
export function compileRootComponent(entryFile: string, files: Record<string, string>): CompiledRoot | null {
  const keys = Object.keys(files);
  if (keys.length === 0) return null;
  const code = keys.length <= 1
    ? transformTSX(files[entryFile] ?? files[keys[0] ?? ""] ?? "").code
    : bundleTSX({ files, entryFile }).code;
  if (!code) return null;
  return { code, filesHash: hashRootFiles(entryFile, files), compilerVersion: COMPILED_FORMAT_VERSION };
}
