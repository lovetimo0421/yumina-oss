/**
 * Multi-file TSX Bundler for root component worlds.
 *
 * Resolves imports between files in a virtual file system, compiles each
 * file independently with Sucrase, and bundles them into a single
 * new Function() for execution in the sandbox.
 *
 * Each imported file becomes an IIFE in the bundled output:
 *   const __mod_stat_bar = (() => { ...compiled code...; return exports; })();
 *
 * The entry file's import statements become variable assignments:
 *   const StatBar = __mod_stat_bar.default;
 *   const { Foo, Bar } = __mod_utils;
 */

import { transform } from "sucrase";
import React from "react";
import { LucideScope } from "./lucide-scope";

// ── Types ────────────────────────────────────────────────────────────

export interface BundleInput {
  files: Record<string, string>;
  entryFile: string;
}

export interface CompileRuntimeScope {
  useAssetFont?: (assetRef: string, options?: Record<string, unknown>) => string;
  ChatCanvas?: React.ComponentType<Record<string, unknown>>;
  Chat?: React.ComponentType<Record<string, unknown>>;
  MessageList?: React.ComponentType<Record<string, unknown>>;
  MessageInput?: React.ComponentType<Record<string, unknown>>;
  ModelPickerModal?: React.ComponentType<Record<string, unknown>>;
  ModelTrigger?: React.ComponentType<Record<string, unknown>>;
  SessionMemoryModal?: React.ComponentType<Record<string, unknown>>;
  LoreSlot?: React.ComponentType<Record<string, unknown>>;
}

export interface BundleResult {
  Component: React.ComponentType<Record<string, unknown>> | null;
  error: string | null;
  fileErrors?: Record<string, string>;
}

/** Parent-side multi-file bundle to a single JS string the sandbox can feed
 *  into buildComponent without pulling Sucrase or the bundler into its bundle.
 *  `code` is the concatenated IIFEs + import resolutions + entry body + return. */
export interface BundleCodeResult {
  code: string | null;
  error: string | null;
  fileErrors: Record<string, string>;
}

// ── Import Parsing ───────────────────────────────────────────────────

interface ParsedImport {
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
function parseImports(code: string): ParsedImport[] {
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
          namedImports.push([asMatch[1], asMatch[2]]);
        } else {
          namedImports.push([trimmed, trimmed]);
        }
      }
    }

    imports.push({
      statement,
      defaultImport: defaultName || null,
      namedImports,
      namespaceImport: nsName || null,
      specifier,
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
function resolveFile(
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
function stripTypeScript(code: string): string {
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

interface CompiledFile {
  /** Transformed JS code (no imports/exports) */
  code: string;
  /** Name of the default export (if any) */
  defaultExportName: string | null;
  /** Named exports: original name → local variable name */
  namedExports: Map<string, string>;
}

/**
 * Compile a single file: strip types, transform JSX, strip imports/exports.
 */
function compileFile(filename: string, source: string): CompiledFile | { error: string } {
  let code = source;

  // Try Sucrase transform with fallback
  try {
    const result = transform(code, {
      transforms: ["typescript", "jsx"],
      jsxRuntime: "classic",
      production: true,
    });
    code = result.code;
  } catch {
    try {
      code = stripTypeScript(source);
      const result = transform(code, {
        transforms: ["typescript", "jsx"],
        jsxRuntime: "classic",
        production: true,
      });
      code = result.code;
    } catch {
      try {
        const result = transform(code, {
          transforms: ["jsx"],
          jsxRuntime: "classic",
          production: true,
        });
        code = result.code;
      } catch (e) {
        return { error: `${filename}: ${e instanceof Error ? e.message : "Compilation failed"}` };
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
          namedExports.set(asMatch[2], asMatch[1]);
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
  return assembleBundle(input);
}

/** Steps 1–4 of the multi-file bundle: graph → topo → per-file transform → stitch.
 *  Shared between bundleTSX (parent, returns JS string) and bundleAndCompile
 *  (parent, returns live React component for studio preview). */
function assembleBundle(input: BundleInput): BundleCodeResult {
  const { files, entryFile } = input;
  const fileErrors: Record<string, string> = {};

  if (!(entryFile in files)) {
    return { code: null, error: `Entry file '${entryFile}' not found`, fileErrors };
  }

  interface DepNode {
    filename: string;
    imports: ParsedImport[];
    resolvedDeps: Map<string, string>;
  }

  const graph = new Map<string, DepNode>();
  const compilationStack: string[] = [];
  let graphError: string | null = null;

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
        return;
      }
      resolvedDeps.set(imp.specifier, resolved);
      buildGraph(resolved);
    }

    compilationStack.pop();
    graph.set(filename, { filename, imports, resolvedDeps });
  }

  buildGraph(entryFile);
  if (graphError) return { code: null, error: graphError, fileErrors };

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
    const result = compileFile(filename, files[filename]);
    if ("error" in result) {
      fileErrors[filename] = result.error;
      return { code: null, error: result.error, fileErrors };
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

export function bundleAndCompile(
  input: BundleInput,
  useYuminaHook?: () => unknown,
  runtimeScope: CompileRuntimeScope = {},
): BundleResult {
  const assembled = assembleBundle(input);
  if (assembled.error || !assembled.code) {
    return { Component: null, error: assembled.error, fileErrors: assembled.fileErrors };
  }
  const fileErrors = assembled.fileErrors;
  const wrappedCode = assembled.code;

  // ── Step 5: Create Function and execute ──

  try {
    const safeHook =
      useYuminaHook ??
      (() => ({
        sendMessage: () => {},
        setVariable: () => {},
        executeAction: () => {},
        variables: {},
        worldName: "",
      }));
    const safeUseAssetFont = runtimeScope.useAssetFont ?? (() => "");
    const safeChatCanvas = runtimeScope.ChatCanvas ?? (() => null);
    const safeChat = runtimeScope.Chat ?? (() => null);
    const safeMessageList = runtimeScope.MessageList ?? (() => null);
    const safeMessageInput = runtimeScope.MessageInput ?? (() => null);
    const safeModelPickerModal = runtimeScope.ModelPickerModal ?? (() => null);
    const safeModelTrigger = runtimeScope.ModelTrigger ?? (() => null);
    const safeSessionMemoryModal = runtimeScope.SessionMemoryModal ?? (() => null);
    const safeLoreSlot = runtimeScope.LoreSlot ?? (() => null);

    const factory = new Function(
      "React",
      "useYumina",
      "useAssetFont",
      "Icons",
      "ChatCanvas",
      "Chat",
      "MessageList",
      "MessageInput",
      "ModelPickerModal",
      "ModelTrigger",
      "SessionMemoryModal",
      "LoreSlot",
      "exports",
      "module",
      wrappedCode,
    );

    const exports: Record<string, unknown> = {};
    const module = { exports: {} as Record<string, unknown> };

    const Component = factory(
      React,
      safeHook,
      safeUseAssetFont,
      LucideScope,
      safeChatCanvas,
      safeChat,
      safeMessageList,
      safeMessageInput,
      safeModelPickerModal,
      safeModelTrigger,
      safeSessionMemoryModal,
      safeLoreSlot,
      exports,
      module,
    );

    if (typeof Component === "function") {
      return { Component, error: null, fileErrors };
    }

    const defaultExport = exports.default ?? module.exports.default;
    if (typeof defaultExport === "function") {
      return {
        Component: defaultExport as React.ComponentType<Record<string, unknown>>,
        error: null,
        fileErrors,
      };
    }

    return {
      Component: null,
      error: `Entry file '${input.entryFile}' must export a default component`,
      fileErrors,
    };
  } catch (e) {
    return {
      Component: null,
      error: `Bundle runtime error: ${e instanceof Error ? e.message : String(e)}`,
      fileErrors,
    };
  }
}
