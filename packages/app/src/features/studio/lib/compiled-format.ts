/** Shared contract for storing a rootComponent's pre-compiled JS on the world,
 *  so play-time can skip the in-browser Sucrase/bundler compile.
 *
 *  Deliberately dependency-free (no Sucrase / bundler import) so world-renderer
 *  can import it cheaply to VALIDATE a stored blob and only pull the heavy
 *  compiler on the fallback path. The editor imports it at save-time to STAMP
 *  the blob. */

/** Format version of stored pre-compiled JS. Bump whenever the compiler output
 *  or the sandbox runtime's expectations of it change, so a world carrying an
 *  older `compiled` blob falls back to a fresh compile instead of shipping
 *  incompatible code to the sandbox. */
export const COMPILED_FORMAT_VERSION = 1;

export interface CompiledRoot {
  /** Bundled/transformed JS produced from { entryFile, files }. */
  code: string;
  /** Hash of the source it was produced from — must match the live files. */
  filesHash: string;
  /** COMPILED_FORMAT_VERSION at stamp time. */
  compilerVersion: number;
}

/** Stable, fast (non-crypto) hash of a rootComponent's source. Used only to
 *  detect whether a stored `compiled` blob still matches the live files — NOT
 *  for security. djb2 over a canonical JSON of { entryFile, sorted files },
 *  with a length suffix to cut collision risk. */
export function hashRootFiles(entryFile: string, files: Record<string, string>): string {
  const sortedKeys = Object.keys(files).sort();
  const canonical = JSON.stringify({ entryFile, files: sortedKeys.map((k) => [k, files[k]]) });
  let h = 5381;
  for (let i = 0; i < canonical.length; i++) {
    h = (((h << 5) + h) ^ canonical.charCodeAt(i)) >>> 0;
  }
  return h.toString(36) + ":" + canonical.length.toString(36);
}

/** True when a stored compiled blob can be trusted for the given live source. */
export function isCompiledValid(
  compiled: CompiledRoot | undefined,
  entryFile: string,
  files: Record<string, string>,
): compiled is CompiledRoot {
  return (
    !!compiled &&
    typeof compiled.code === "string" &&
    compiled.compilerVersion === COMPILED_FORMAT_VERSION &&
    compiled.filesHash === hashRootFiles(entryFile, files)
  );
}
