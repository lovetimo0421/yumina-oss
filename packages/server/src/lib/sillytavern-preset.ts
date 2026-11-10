/**
 * SillyTavern chat-completion preset → the body /api/user-prompts/import takes.
 *
 * ST presets used to import by accident (their `prompts` array has `name` and
 * `content` too), which brought over every placeholder marker as an empty row,
 * turned on prompts the player had switched off in ST, and lost order, role and
 * in-chat depth. This reads the preset the way ST does:
 *
 * - On/off and order come from `prompt_order` (the global list, character_id
 *   100001, else the longest list). Prompts missing from it are off in ST, so
 *   they come in switched off.
 * - Markers (chat history, character description, …) are slots ST fills from
 *   the card. Yumina fills those itself, so they are skipped, as are empty prompts.
 * - injection_position 1 = in chat at injection_depth. Otherwise placement
 *   follows the markers: before the character → before the card, after chat
 *   history → after the chat, anything else → after the character.
 * - role user/assistant is kept; macros pass through (the engine expands
 *   {{char}}, {{user}}, {{random}}, {{// …}} and friends).
 */

const MARKER_IDS = new Set([
  "chatHistory",
  "dialogueExamples",
  "worldInfoBefore",
  "worldInfoAfter",
  "charDescription",
  "charPersonality",
  "scenario",
  "personaDescription",
]);
/** Markers that stand for the character card: prompts above them go before it. */
const CHARACTER_MARKER_IDS = new Set(["worldInfoBefore", "personaDescription", "charDescription", "charPersonality", "scenario"]);
const GLOBAL_ORDER_CHARACTER_ID = 100001;
const FOLDER_FALLBACK = "SillyTavern preset";

interface StPrompt {
  identifier: string;
  name?: unknown;
  content?: unknown;
  role?: unknown;
  marker?: unknown;
  enabled?: unknown;
  injection_position?: unknown;
  injection_depth?: unknown;
}
interface StOrderEntry { identifier: string; enabled: boolean }

export interface ImportBody {
  folders: Array<{ id: string; name: string; enabled: boolean }>;
  prompts: Array<{
    name: string;
    content: string;
    section: "system-presets" | "chat-history" | "post-history";
    position: number;
    depth: number | null;
    enabled: boolean;
    apiRole: "user" | "assistant" | null;
    folderId: string;
  }>;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function isSillyTavernPreset(raw: unknown): boolean {
  return isObject(raw)
    && Array.isArray(raw.prompts)
    && raw.prompts.some((p) => isObject(p) && typeof p.identifier === "string");
}

function readOrder(raw: Record<string, unknown>): StOrderEntry[] | null {
  if (!Array.isArray(raw.prompt_order)) return null;
  const lists = raw.prompt_order
    .filter(isObject)
    .map((o) => ({
      characterId: o.character_id,
      order: (Array.isArray(o.order) ? o.order : [])
        .filter((e): e is Record<string, unknown> => isObject(e) && typeof e.identifier === "string")
        .map((e) => ({ identifier: e.identifier as string, enabled: e.enabled !== false })),
    }))
    .filter((l) => l.order.length > 0);
  if (lists.length === 0) return null;
  const global = lists.find((l) => l.characterId === GLOBAL_ORDER_CHARACTER_ID);
  return (global ?? lists.reduce((a, b) => (b.order.length > a.order.length ? b : a))).order;
}

function folderName(fileName: string | null | undefined): string {
  const base = (fileName ?? "").replace(/\.json$/i, "").trim();
  return (base || FOLDER_FALLBACK).slice(0, 60);
}

/** Null when `raw` isn't an ST preset (the caller imports it as a Yumina export). */
export function convertSillyTavernPreset(raw: unknown, fileName?: string | null): ImportBody | null {
  if (!isSillyTavernPreset(raw) || !isObject(raw)) return null;
  const prompts = (raw.prompts as unknown[]).filter(
    (p): p is StPrompt => isObject(p) && typeof p.identifier === "string",
  );
  const byId = new Map(prompts.map((p) => [p.identifier, p]));

  const order = readOrder(raw);
  // Sequence as ST sends it; prompts the order list never mentions are off in ST.
  const listed = order
    ? order.filter((o) => byId.has(o.identifier))
    : prompts.map((p) => ({ identifier: p.identifier, enabled: p.enabled !== false }));
  const listedIds = new Set(listed.map((o) => o.identifier));
  const unlisted = order ? prompts.filter((p) => !listedIds.has(p.identifier)).map((p) => ({ identifier: p.identifier, enabled: false })) : [];
  const sequence = [...listed, ...unlisted];

  const chatAt = listed.findIndex((o) => o.identifier === "chatHistory");
  const characterAt = listed.findIndex((o) => CHARACTER_MARKER_IDS.has(o.identifier));

  const folderId = "st-preset";
  const out: ImportBody = { folders: [{ id: folderId, name: folderName(fileName), enabled: true }], prompts: [] };
  sequence.forEach((o, i) => {
    const p = byId.get(o.identifier)!;
    if (p.marker === true || MARKER_IDS.has(p.identifier)) return;
    const content = typeof p.content === "string" ? p.content : "";
    if (!content.trim()) return;
    const name = (typeof p.name === "string" && p.name.trim()) || p.identifier;
    const apiRole = p.role === "user" || p.role === "assistant" ? p.role : null;
    const inChat = Number(p.injection_position) === 1;
    const depthRaw = Number(p.injection_depth);
    const isListed = i < listed.length;

    let section: ImportBody["prompts"][number]["section"] = "system-presets";
    let position = 9500 + i;
    if (inChat) {
      section = "chat-history";
      position = i;
    } else if (isListed && chatAt >= 0 && i > chatAt) {
      section = "post-history";
      position = 50000 + i;
    } else if (isListed && characterAt >= 0 && i < characterAt) {
      position = -50000 + i;
    }

    out.prompts.push({
      name: name.slice(0, 120),
      content,
      section,
      position,
      depth: inChat ? (Number.isFinite(depthRaw) ? Math.max(0, Math.round(depthRaw)) : 4) : null,
      enabled: o.enabled,
      apiRole,
      folderId,
    });
  });
  if (out.prompts.length === 0) out.folders = [];
  return out;
}
