import { parse } from "@babel/parser";

interface RootFiles {
  entryFile: string;
  files: Record<string, string>;
}

/** A source dependency check, not evidence that React mounts a component or
 * that its CSS makes it visible. Unknown graphs must not label files unused. */
export interface RootUiReachability {
  complete: boolean;
  unreachableFiles: string[];
}

const EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ""];
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 200;
// Runtime supplies these as React / Icons globals; imports are stripped by
// the compiler. Other bare module names are not assumed to be platform APIs.
const PLATFORM_MODULES = new Set(["react", "lucide-react"]);

function resolveReference(specifier: string, parent: string, files: Record<string, string>): string | null {
  let path = specifier;
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const parts = parent.split("/").slice(0, -1);
    for (const part of specifier.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") parts.pop();
      else parts.push(part);
    }
    path = parts.join("/");
  }
  // Same extension/directory lookup order as the app's TSX bundler.
  for (const candidate of [...EXTENSIONS.map((ext) => path + ext), ...EXTENSIONS.map((ext) => `${path}/index${ext}`)]) {
    if (Object.prototype.hasOwnProperty.call(files, candidate)) return candidate;
  }
  return null;
}

/** Inspect declarations without executing creator code. An AST avoids counting
 * imports in comments/strings as proof a sibling is connected. Literal dynamic
 * imports, bare virtual-file references and re-exports count conservatively as references, even though this
 * does not certify the current runtime bundler supports every module form. */
function references(source: string): { paths: string[]; complete: boolean } {
  const tree = parse(source, {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
    createImportExpressions: true,
    attachComment: false,
  });
  const paths: string[] = [];
  let complete = true;
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    const node = value as Record<string, unknown>;
    if (typeof node.type !== "string") return;
    if (node.type === "TSImportType") return;
    const sourceNode = node.source as { type?: string; value?: string } | undefined;
    if (node.type === "ImportDeclaration") {
      const specifiers = node.specifiers as Array<{ importKind?: string }>;
      const typeOnly = node.importKind === "type" || (specifiers.length > 0 && specifiers.every((s) => s.importKind === "type"));
      if (!typeOnly && typeof sourceNode?.value === "string") paths.push(sourceNode.value);
      return;
    }
    if (node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") {
      if (node.exportKind !== "type" && typeof sourceNode?.value === "string") paths.push(sourceNode.value);
    }
    if (node.type === "ImportExpression") {
      if (sourceNode?.type === "StringLiteral" && typeof sourceNode.value === "string") paths.push(sourceNode.value);
      else complete = false;
      return;
    }
    // require aliases and computed loaders cannot be resolved safely. Being
    // conservative here avoids a false warning; it does not endorse require.
    if (node.type === "Identifier" && ["require", "eval", "Function"].includes(String(node.name))) complete = false;
    for (const [key, child] of Object.entries(node)) {
      if (key !== "loc" && !key.endsWith("Comments")) visit(child);
    }
  };
  visit(tree.program);
  return { paths, complete };
}

export function analyzeRootUiReachability(root: RootFiles | undefined): RootUiReachability {
  const unknown: RootUiReachability = { complete: false, unreachableFiles: [] };
  if (!root || !Object.prototype.hasOwnProperty.call(root.files, root.entryFile)) return unknown;
  const filenames = Object.keys(root.files);
  if (filenames.length > MAX_FILES) return unknown;
  const visited = new Set<string>();
  const pending = [root.entryFile];
  let bytes = 0;
  while (pending.length) {
    const filename = pending.pop()!;
    if (visited.has(filename)) continue;
    visited.add(filename);
    const source = root.files[filename];
    if (typeof source !== "string") return unknown;
    const size = Buffer.byteLength(source, "utf8");
    bytes += size;
    if (size > MAX_FILE_BYTES || bytes > MAX_TOTAL_BYTES) return unknown;
    let refs: ReturnType<typeof references>;
    try { refs = references(source); } catch { return unknown; }
    if (!refs.complete) return unknown;
    for (const specifier of refs.paths) {
      const target = resolveReference(specifier, filename, root.files);
      if (!target && PLATFORM_MODULES.has(specifier)) continue;
      // A missing import already breaks linking; do not pretend the remaining
      // graph proves which files the author meant to connect.
      if (!target) return unknown;
      pending.push(target);
    }
  }
  return { complete: true, unreachableFiles: filenames.filter((name) => /\.[jt]sx?$/.test(name) && !visited.has(name)) };
}

export function rootUiConnectionNote(root: RootFiles | undefined, filename: string): string {
  if (!root || !analyzeRootUiReachability(root).unreachableFiles.includes(filename)) return "";
  return ` File "${filename}" is not referenced from entry "${root.entryFile}". Editing it alone cannot change the rendered UI. Import and mount the intended component from the entry or an already connected component; syntax checks do not verify visibility.`;
}
