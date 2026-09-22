import { createHash } from "node:crypto";

/** Bump whenever extraction, ordering, labels, or bounds change. */
export const WORLD_EMBEDDING_INPUT_VERSION = "published-greetings-v1";
export const WORLD_EMBEDDING_MAX_BYTES = 8000;
export const WORLD_EMBEDDING_OPENING_MAX_CHARS = 2000;

export interface WorldEmbeddingContent {
  name: string;
  description?: string | null;
  tags?: string[] | null;
  announcement?: string | null;
  /** The live worlds.schema, never a working copy or a held edit. */
  schema: unknown;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Bound UTF-8 bytes as well as UTF-16 length; never split a surrogate pair. */
function bounded(value: string, maxBytes: number, maxChars = Infinity): string {
  let bytes = 0;
  let chars = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > maxBytes || chars + char.length > maxChars) break;
    bytes += size;
    chars += char.length;
  }
  return value.slice(0, chars);
}

function openingText(schema: unknown): string {
  if (!record(schema)) return "";
  // An explicit entries field is authoritative, including an empty list or
  // disabled greetings. Never resurrect stale legacy content in that case.
  if (!("entries" in schema)) {
    const legacy = Array.isArray(schema.firstMessage) ? schema.firstMessage[0] : schema.firstMessage;
    return typeof legacy === "string" ? bounded(legacy.trim(), 3000, WORLD_EMBEDDING_OPENING_MAX_CHARS) : "";
  }
  if (!Array.isArray(schema.entries)) return "";
  const greetings = schema.entries.filter((entry): entry is Record<string, unknown> =>
    record(entry) && entry.role === "greeting" && entry.enabled === true && typeof entry.content === "string",
  );
  // PromptBuilder.buildGreetingEntries / entrySort: ascending position,
  // missing positions last, stable ties. Parity is regression-tested.
  const position = (entry: Record<string, unknown>) =>
    typeof entry.position === "number" && Number.isFinite(entry.position) ? entry.position : Infinity;
  greetings.sort((a, b) => position(a) - position(b));
  let opening = "";
  for (const entry of greetings) {
    const content = (entry.content as string).trim();
    if (!content) continue;
    const separator = opening ? "\n\n" : "";
    const remaining = WORLD_EMBEDDING_OPENING_MAX_CHARS - opening.length;
    if (remaining <= separator.length) break;
    opening += separator + bounded(content, 3000, remaining - separator.length);
    if (Buffer.byteLength(opening, "utf8") >= 3000) break;
  }
  return bounded(opening, 3000, WORLD_EMBEDDING_OPENING_MAX_CHARS);
}

/** DB/env-free canonical input shared by publishing and the offline backfill.
 * Field budgets reserve space for openings even with oversized metadata.
 * 8000 UTF-8 bytes is a conservative input bound, not a token estimate.
 */
export function buildWorldEmbeddingText(world: WorldEmbeddingContent): string {
  const parts = [`Title: ${bounded(world.name.trim(), 256)}`];
  if (world.description?.trim()) parts.push(`Description: ${bounded(world.description.trim(), 3000)}`);
  if (world.tags?.length) {
    const tags = world.tags.slice(0, 50).filter((tag) => typeof tag === "string")
      .map((tag) => bounded(tag.trim(), 512)).filter(Boolean).join(", ");
    if (tags) parts.push(`Tags: ${bounded(tags, 512)}`);
  }
  if (world.announcement?.trim()) parts.push(`Announcement: ${bounded(world.announcement.trim(), 1000)}`);
  const opening = openingText(world.schema);
  if (opening) parts.push(`Opening: ${opening}`);
  return bounded(parts.join("\n\n"), WORLD_EMBEDDING_MAX_BYTES);
}

export function buildWorldEmbeddingInput(world: WorldEmbeddingContent) {
  const text = buildWorldEmbeddingText(world);
  const version = WORLD_EMBEDDING_INPUT_VERSION;
  return { text, version, hash: createHash("sha256").update(`${version}\n${text}`, "utf8").digest("hex") };
}
