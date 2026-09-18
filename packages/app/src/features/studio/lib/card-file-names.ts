/**
 * Naming rules for the files inside a world's rootComponent.
 *
 * The bundler compiles EVERY file with the same Sucrase pass no matter what it
 * is called, and `resolveFile()` resolves an import by trying `.tsx`, `.ts`,
 * `.jsx`, `.js` and the exact name — so `import * as THREE from "./three-lib"`
 * finds `three-lib.js` exactly as well as `three-lib.tsx`. The extension is
 * cosmetic to the compiler and load-bearing only to the author reading the
 * file list.
 *
 * Both editors used to append `.tsx` unconditionally, which meant a pasted-in
 * JS vendor bundle came out as `three-lib.js.tsx` and there was no rename to
 * undo it — the only way to get an honest name was to import a world JSON that
 * already had one. Keep an extension the author typed; supply `.tsx` only when
 * they typed none.
 */

/** Extensions the bundler resolves without being told (see EXTENSIONS in tsx-bundler.ts). */
export const CARD_FILE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"] as const;

/** Files whose starter content should contain JSX. */
const JSX_EXTENSIONS = [".tsx", ".jsx"];

export type CardFileNameError = "empty" | "path" | "extension";

export type CardFileNameResult =
  | { ok: true; name: string }
  | { ok: false; reason: CardFileNameError };

function extensionOf(name: string): string | null {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  // A leading dot is part of the name (".env"), not an extension.
  if (dot <= 0) return null;
  return base.slice(dot).toLowerCase();
}

/**
 * Turn what the author typed into a file key, or say why it can't be one.
 *
 * Accepts subfolders (`scenes/atrium.tsx`) because installed bundles already
 * live under `_bundles/<slug>/`.
 */
export function normalizeCardFileName(input: string): CardFileNameResult {
  const trimmed = input.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!trimmed) return { ok: false, reason: "empty" };
  if (trimmed.startsWith("/")) return { ok: false, reason: "path" };
  const segments = trimmed.split("/");
  if (segments.some((seg) => seg === "" || seg === "." || seg === "..")) {
    return { ok: false, reason: "path" };
  }

  const ext = extensionOf(trimmed);
  if (!ext) return { ok: true, name: `${trimmed}.tsx` };
  if (!(CARD_FILE_EXTENSIONS as readonly string[]).includes(ext)) {
    return { ok: false, reason: "extension" };
  }
  // Keep the author's spelling of the name, normalize only the extension case.
  return { ok: true, name: trimmed.slice(0, trimmed.length - ext.length) + ext };
}

/** `scenes/stat-bar.tsx` → `StatBar`: an identifier for the starter file. */
export function componentNameFromFile(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
  const words = base.split(/[^a-zA-Z]+/).filter(Boolean);
  if (words.length === 0) return "Component";
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
}

/** Starter content for a newly created file — JSX only where JSX belongs. */
export function starterCardFile(name: string): string {
  const component = componentNameFromFile(name);
  const ext = extensionOf(name);
  if (ext && !JSX_EXTENSIONS.includes(ext)) {
    return `export function ${component}() {\n  return null;\n}\n`;
  }
  return `export default function ${component}() {\n  return <div>Hello</div>;\n}\n`;
}
