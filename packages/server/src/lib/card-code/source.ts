/**
 * A card's interface reaches players as its compiled code alone, once the
 * server has checked that code was built from the source it would have sent.
 *
 * Opening a card used to ship the interface twice: the creator's source and
 * the compiled copy the player actually runs. The browser kept the source only
 * to hash it and confirm the compiled copy was current. For the heaviest cards
 * that source was half of everything downloaded (FreeCiv: 6.46 MB gzipped per
 * open). The server now does that check, once per card version per instance,
 * and sends `files: {}` with `compiled.sourceOmitted` set.
 *
 * Only for browsers that say they understand it (the x-card-code header names
 * the compiled format they run), only for viewers who are not the card's
 * creator (the creator's errors are explained from the source), and only when
 * the source is big enough to matter: a small root, like the default chat,
 * keeps its source so the checks that read it still work. A stamp that no
 * longer matches its source is sent with the source as before, and restamped.
 */
import { COMPILED_FORMAT_VERSION, hashRootFiles } from "@yumina/shared";
import { stampCompiledLater } from "./stamp.js";

export const CARD_CODE_HEADER = "x-card-code";
/** Below this much source the saving is noise, and small roots (the default
 *  chat) are read by the client to decide how to show the card. */
const MIN_SOURCE_CHARS = 20_000;
const MAX_REMEMBERED = 2000;

/** world@hash → whether the compiled code can stand in for the source. */
const verified = new Map<string, boolean>();

/** Sources the player's browser rewrites before compiling, so the stored
 *  compiled copy is not what it runs: Oncin's cloud gallery gets a hook
 *  inserted (app features/chat/oncin-cloud-gallery.ts). Those keep their
 *  source. */
function rewrittenInBrowser(files: Record<string, string>): boolean {
  return Object.values(files).some((source) => source.includes("oncin:gallery:") && source.includes("oswUseGalleryStore"));
}

function disabled(): boolean {
  return process.env.CARD_CODE_SOURCE === "keep";
}

interface RootLike {
  entryFile?: unknown;
  files?: unknown;
  compiled?: { code?: unknown; filesHash?: unknown; compilerVersion?: unknown } & Record<string, unknown>;
}

/**
 * The schema to send this viewer: the same object when nothing can be left
 * out, else a copy whose rootComponent carries the compiled code only.
 */
export function playerSchema<S>(
  world: { id: string; updatedAt: Date | string | null; schema: S },
  opts: { clientFormat: string | undefined; isCreator: boolean },
): S {
  if (disabled() || opts.isCreator || opts.clientFormat !== String(COMPILED_FORMAT_VERSION)) return world.schema;
  const schema = world.schema as unknown as { rootComponent?: RootLike } | null;
  const rc = schema?.rootComponent;
  const files = rc?.files;
  const compiled = rc?.compiled;
  if (!rc || !compiled || typeof compiled.code !== "string" || typeof compiled.filesHash !== "string") return world.schema;
  if (compiled.compilerVersion !== COMPILED_FORMAT_VERSION) return world.schema;
  if (!files || typeof files !== "object" || Array.isArray(files)) return world.schema;
  const sources = Object.values(files as Record<string, unknown>);
  if (sources.length === 0 || !sources.every((s) => typeof s === "string")) return world.schema;
  let size = 0;
  for (const s of sources as string[]) size += s.length;
  if (size < MIN_SOURCE_CHARS) return world.schema;

  const entryFile = typeof rc.entryFile === "string" && rc.entryFile ? rc.entryFile : "index.tsx";
  const key = `${world.id}@${compiled.filesHash}:${size}`;
  let matches = verified.get(key);
  if (matches === undefined) {
    matches = hashRootFiles(entryFile, files as Record<string, string>) === compiled.filesHash
      && !rewrittenInBrowser(files as Record<string, string>);
    if (verified.size >= MAX_REMEMBERED) verified.clear();
    verified.set(key, matches);
  }
  if (!matches) {
    // Stamped from older source (players compile live, as before stamps
    // existed, until the restamp lands), or rewritten in the browser.
    if (!rewrittenInBrowser(files as Record<string, string>)) stampCompiledLater(world, { stale: true });
    return world.schema;
  }
  return {
    ...(schema as object),
    rootComponent: { ...rc, files: {}, compiled: { ...compiled, sourceOmitted: true } },
  } as unknown as S;
}
