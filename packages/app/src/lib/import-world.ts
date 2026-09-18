import {
  migrateWorldDefinition,
} from "@yumina/engine";
import type { WorldDefinition, YuminaBundle } from "@yumina/engine";
import {
  isTavernCharacterCard,
  isTavernWorldbook,
  convertTavernCard,
  convertTavernWorldbook,
} from "./convert-tavern-card";
import {
  isPng,
  readPngTextChunks,
  base64ToUtf8,
  YUMINA_KEYWORD,
  ST_V2_KEYWORD,
  ST_V3_KEYWORD,
} from "./png-metadata";

type ImportFormat = "yumina" | "ui-package" | "bundle" | "tavern-card" | "tavern-worldbook" | "unknown";

interface ParseImportOptions {
  sourceHint?: "auto" | "yumina";
}

function isYuminaBundleLike(obj: Record<string, unknown>): boolean {
  return (
    typeof obj.bundleVersion === "string" &&
    typeof obj.name === "string" &&
    typeof obj.createdAt === "string" &&
    Array.isArray(obj.entries) &&
    Array.isArray(obj.variables) &&
    Array.isArray(obj.rules) &&
    Array.isArray(obj.tags)
  );
}

function isYuminaWorldLike(obj: Record<string, unknown>): boolean {
  const hasCoreArrays =
    Array.isArray(obj.entries) &&
    Array.isArray(obj.variables) &&
    Array.isArray(obj.rules) &&
    Array.isArray(obj.components);

  if (hasCoreArrays) return true;

  if (typeof obj.version === "string" && Array.isArray(obj.entries)) return true;

  const hasAnyWorldField =
    Array.isArray(obj.entries) ||
    Array.isArray(obj.variables) ||
    Array.isArray(obj.rules) ||
    Array.isArray(obj.components) ||
    Array.isArray(obj.audioTracks) ||
    Array.isArray(obj.customUI) ||
    Array.isArray(obj.customComponents) ||
    obj.settings !== undefined ||
    obj.uiBlueprint !== undefined ||
    obj.messageRenderer !== undefined;

  return hasAnyWorldField;
}

function parseJsonStringIfPossible(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function extractImportPayload(json: unknown): unknown {
  let current: unknown = json;
  const seen = new Set<object>();

  while (current && typeof current === "object") {
    const obj = current as Record<string, unknown>;
    if (seen.has(obj)) break;
    seen.add(obj);

    if (
      isYuminaWorldLike(obj) ||
      isYuminaBundleLike(obj) ||
      obj.format === "yumina.ui-package"
    ) {
      break;
    }

    const schemaPayload = parseJsonStringIfPossible(obj.schema);
    if (schemaPayload && typeof schemaPayload === "object") {
      current = schemaPayload;
      continue;
    }

    const worldPayload = parseJsonStringIfPossible(obj.world);
    if (worldPayload && typeof worldPayload === "object") {
      current = worldPayload;
      continue;
    }

    const dataPayload = parseJsonStringIfPossible(obj.data);
    if (dataPayload && typeof dataPayload === "object") {
      const dataObj = dataPayload as Record<string, unknown>;
      const nestedSchema = parseJsonStringIfPossible(dataObj.schema);
      if (nestedSchema && typeof nestedSchema === "object") {
        current = nestedSchema;
        continue;
      }
      const nestedWorld = parseJsonStringIfPossible(dataObj.world);
      if (nestedWorld && typeof nestedWorld === "object") {
        current = nestedWorld;
        continue;
      }

      if (
        isYuminaWorldLike(dataObj) ||
        isYuminaBundleLike(dataObj)
      ) {
        current = dataObj;
        continue;
      }
    }

    break;
  }

  return current;
}

export function detectFormat(json: unknown): ImportFormat {
  if (!json || typeof json !== "object") return "unknown";
  const obj = json as Record<string, unknown>;

  if (obj.format === "yumina.ui-package") {
    return "ui-package";
  }

  if (isYuminaBundleLike(obj)) {
    return "bundle";
  }

  if (isYuminaWorldLike(obj)) {
    return "yumina";
  }

  // SillyTavern formats — check after Yumina formats. Standalone worldbooks
  // are structurally more specific and must win over the loose V1 card
  // fallback (name + description), because real world_info exports can carry
  // both of those top-level strings alongside an object-mapped entries field.
  if (isTavernWorldbook(json)) {
    return "tavern-worldbook";
  }

  if (isTavernCharacterCard(json)) {
    return "tavern-card";
  }

  return "unknown";
}

export function isYuminaBundleJson(json: unknown): json is YuminaBundle {
  if (!json || typeof json !== "object") return false;
  return isYuminaBundleLike(json as Record<string, unknown>);
}

export function isWorldLikeImportJson(json: unknown): boolean {
  const unwrapped = extractImportPayload(json);
  const format = detectFormat(unwrapped);
  return format === "yumina";
}

export function parseImportedJson(
  json: unknown,
  _options: ParseImportOptions = {}
): WorldDefinition {
  // Check for SillyTavern formats on the raw json BEFORE unwrapping,
  // since extractImportPayload won't know how to unwrap ST structures.
  const rawFormat = detectFormat(json);
  if (rawFormat === "tavern-card") {
    return convertTavernCard(json as Parameters<typeof convertTavernCard>[0]);
  }
  if (rawFormat === "tavern-worldbook") {
    return convertTavernWorldbook(json as Parameters<typeof convertTavernWorldbook>[0]);
  }

  const unwrapped = extractImportPayload(json);
  const format = detectFormat(unwrapped);

  switch (format) {
    case "yumina":
      return migrateWorldDefinition(unwrapped as WorldDefinition);

    case "ui-package":
      throw new Error(
        "This JSON is a Yumina UI package. Import it from Components > Import AI JSON."
      );

    case "bundle":
      throw new Error(
        "This JSON is a Yumina bundle. Import it via Bundle Import, not full world import."
      );

    default:
      throw new Error(
        "Unrecognized file format. Expected a Yumina world or character card JSON."
      );
  }
}

/**
 * Try to extract a Yumina world or SillyTavern card JSON from a PNG.
 * Looks at all tEXt/iTXt chunks; prefers our own `yumina` keyword,
 * then ST V3 (`ccv3`), then ST V1/V2 (`chara`). Each is base64 JSON.
 */
function extractJsonFromPng(bytes: Uint8Array): unknown {
  const chunks = readPngTextChunks(bytes);
  // SillyTavern occasionally writes mixed case; match case-insensitively.
  const findChunk = (kw: string) =>
    chunks.find((c) => c.keyword.toLowerCase() === kw.toLowerCase());

  const candidate =
    findChunk(YUMINA_KEYWORD) ?? findChunk(ST_V3_KEYWORD) ?? findChunk(ST_V2_KEYWORD);

  if (!candidate) {
    throw new Error(
      "PNG has no embedded character card data (no yumina/ccv3/chara metadata).",
    );
  }

  const trimmed = candidate.text.trim();
  // Base64 first (the spec for chara/ccv3/yumina), then raw JSON as a fallback
  // for tools that wrote plain JSON into the chunk.
  let jsonStr: string | null = null;
  try {
    jsonStr = base64ToUtf8(trimmed);
  } catch {
    jsonStr = null;
  }
  if (jsonStr) {
    try {
      return JSON.parse(jsonStr);
    } catch {
      // fall through to raw-JSON attempt
    }
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(
      `PNG metadata for "${candidate.keyword}" is not valid base64 or JSON.`,
    );
  }
}

export interface ParsedImport {
  world: WorldDefinition;
  /**
   * For PNG character cards, the image bytes themselves — to upload as the
   * world's cover. The PNG visual IS the cover both in the SillyTavern
   * convention and in Yumina's own PNG export (which bakes the cover into
   * the image). `null` for JSON imports, which carry no embedded image.
   */
  coverImage: Blob | null;
}

export async function parseImportedFile(
  file: File,
  options: ParseImportOptions = {}
): Promise<ParsedImport> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  if (isPng(bytes)) {
    const json = extractJsonFromPng(bytes);
    const world = parseImportedJson(json, options);
    return { world, coverImage: new Blob([buffer], { type: "image/png" }) };
  }

  let text = new TextDecoder("utf-8").decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      "Unrecognized file. Expected a Yumina world JSON, character card JSON, or PNG character card.",
    );
  }

  return { world: parseImportedJson(json, options), coverImage: null };
}

/**
 * A parsed import that may be EITHER a full world or a Yumina bundle.
 *
 * `parseImportedFile` throws on bundles ("import via Bundle Import") because the
 * editor's whole-world load can't apply a bundle. The create screen, by
 * contrast, starts from a blank world, so it CAN seed a fresh card from a
 * bundle — it just needs to know which kind it got without eating an exception.
 */
export type FlexibleImport =
  | { kind: "world"; world: WorldDefinition; coverImage: Blob | null }
  | { kind: "bundle"; bundle: YuminaBundle };

/**
 * Like `parseImportedFile`, but returns a discriminated `world | bundle` result
 * instead of rejecting bundles. UI-packages, unknown, and tavern formats still
 * route through `parseImportedJson` (which throws actionable messages / converts
 * tavern cards). Lets the create screen accept a bundle file directly.
 */
export async function parseImportedFileFlexible(
  file: File,
  options: ParseImportOptions = {}
): Promise<FlexibleImport> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  let json: unknown;
  let coverImage: Blob | null = null;

  if (isPng(bytes)) {
    json = extractJsonFromPng(bytes);
    coverImage = new Blob([buffer], { type: "image/png" });
  } else {
    let text = new TextDecoder("utf-8").decode(bytes);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(
        "Unrecognized file. Expected a Yumina world JSON, bundle JSON, character card JSON, or PNG character card.",
      );
    }
  }

  // Detect a bundle before world parsing (which would reject it). extractImportPayload
  // unwraps common wrappers (schema/world/data); a bundle stops the unwrap on itself.
  const payload = extractImportPayload(json);
  if (isYuminaBundleJson(payload)) {
    return { kind: "bundle", bundle: payload };
  }

  const world = parseImportedJson(json, options);
  return { kind: "world", world, coverImage };
}
