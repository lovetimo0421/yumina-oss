// LoRAs story illustrations are drawn with (TURN_IMAGE_LORAS):
//   - the card's art style   (world.settings.illustrationLora), every picture;
//   - a character's LoRA      (the character entry's imageLora), when they are in it;
//   - the player's own        (preferences.personaImageLoras[personaId]), when they are in it.
// Anima LoRAs only: they load on the Anima route, chained after its UNET.
//
// Who may use what: a LoRA bound to a card is used for every player of that
// card when the card's author owns it (or it is public), without making it
// public. A persona LoRA must be the player's own (or public). A LoRA taken
// down, deleted, failed or not yet in the Comfy library is skipped silently:
// the picture is drawn without it.

import { eq, inArray } from "drizzle-orm";
import type { ImageLoraBinding, WorldDefinition } from "@yumina/engine";
import { db } from "../../db/index.js";
import { generationModels, worlds } from "../../db/schema.js";
import { comfyAssetId, comfyLibraryEnabled, ensureInLibrary } from "../generation/comfy-library.js";
import { env } from "../env.js";
import { cleanTrigger, isExplicitMoment } from "./age.js";

export const STYLE_LORA_WEIGHT = 0.8;
export const CHARACTER_LORA_WEIGHT = 0.9;
const MAX_WEIGHT = 1.5;

/** One LoRA as the workflow loads it. */
export interface DrawLora {
  /** The generation_models row (counted as used, restored to the library when evicted). */
  modelId: string;
  file: string;
  weight: number;
  /** Tags that call it up, placed next to the character's own tags (or the style's place). */
  trigger: string;
}

export interface TurnImageLoras {
  style?: DrawLora;
  /** By the character entry's name (facets merged, as the cast reads them). */
  characters: { name: string; lora: DrawLora }[];
  persona?: DrawLora;
}

export function turnImageLorasEnabled(): boolean {
  return env.TURN_IMAGE_LORAS === "1" && comfyLibraryEnabled() && env.PER_TURN_IMAGE_ANIMA_MODEL !== "";
}

const HEAD_COUNT_RE = /^(?:\d\+?(?:girls?|boys?|others?)|solo|multiple (?:girls|boys))$/i;

/** The words that call a LoRA up when its binding names none: the first tag
 *  of its trained words that isn't a head count ("klukaigf2, baseout, …" →
 *  "klukaigf2"). Outfits and looks come from the story, not the LoRA's list. */
export function defaultTrigger(triggerWords: string | null | undefined): string {
  const tags = (triggerWords ?? "").replace(/<lora:[^>]*>/gi, "").split(/[,\n|]/).map((t) => t.trim()).filter(Boolean);
  return tags.find((t) => !HEAD_COUNT_RE.test(t)) ?? "";
}

/** A binding as the card or persona stores it, or null when it isn't one. */
export function readBinding(value: unknown): ImageLoraBinding | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.modelId !== "string" || !/^[0-9a-f-]{36}$/i.test(v.modelId)) return null;
  const weight = typeof v.weight === "number" && Number.isFinite(v.weight) ? Math.min(MAX_WEIGHT, Math.max(0, v.weight)) : undefined;
  const trigger = typeof v.trigger === "string" ? cleanTrigger(v.trigger.slice(0, 300)) : undefined;
  return { modelId: v.modelId, ...(weight !== undefined ? { weight } : {}), ...(trigger !== undefined ? { trigger } : {}) };
}

/** preferences.personaImageLoras as stored: persona id → binding, bounded. */
export function sanitizePersonaLoras(value: unknown): Record<string, ImageLoraBinding> {
  const out: Record<string, ImageLoraBinding> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [personaId, raw] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
    if (!/^[\w-]{1,80}$/.test(personaId)) continue;
    const binding = readBinding(raw);
    if (binding) out[personaId] = binding;
  }
  return out;
}

export function personaLoraFor(preferences: unknown, personaId: string | null | undefined): ImageLoraBinding | null {
  if (!personaId) return null;
  const map = ((preferences ?? {}) as Record<string, unknown>).personaImageLoras;
  return map && typeof map === "object" ? readBinding((map as Record<string, unknown>)[personaId]) : null;
}

/** Character entries' bindings, by entry name. */
function characterBindings(world: WorldDefinition): { id: string; name: string; binding: ImageLoraBinding }[] {
  const out: { id: string; name: string; binding: ImageLoraBinding }[] = [];
  for (const e of world.entries ?? []) {
    if (e.role !== "character" || !e.name) continue;
    const binding = readBinding(e.imageLora);
    if (binding) out.push({ id: e.id, name: e.name, binding });
  }
  return out;
}

export interface LoraOwners {
  /** The card's author: their LoRAs serve the card. */
  card: string | null | undefined;
  /** For a fork: the card it was copied from, as that card is now. A source
   *  author's private LoRA serves the fork only in the very slot the source
   *  card binds it in (its style, or the same character), never anywhere else. */
  source?: { creatorId: string; world: WorldDefinition } | null;
  /** The player: their LoRAs serve their persona. */
  player: string;
}

type Slot = { kind: "style" } | { kind: "character"; id: string; name: string };

/** The source card binds exactly this model in this slot. */
function boundInSource(source: LoraOwners["source"], modelId: string, slot: Slot): boolean {
  if (!source) return false;
  if (slot.kind === "style") return readBinding(source.world.settings?.illustrationLora)?.modelId === modelId;
  return (source.world.entries ?? []).some((e) => e.role === "character" && (e.id === slot.id || e.name === slot.name)
    && readBinding(e.imageLora)?.modelId === modelId);
}

/** Whether a card slot may draw with this model: the card author's (or public),
 *  or the fork source author's where the source card binds it in that slot. */
export function usableForCard(row: ModelRow | undefined, owners: Pick<LoraOwners, "card" | "source">, slot: Slot): row is ModelRow {
  if (!row) return false;
  if (usableLora(row as ModelRow | undefined, [owners.card])) return true;
  return !!owners.source && row.userId === owners.source.creatorId
    && usableLora(row, [owners.source.creatorId]) && boundInSource(owners.source, row.id, slot);
}

/** The fork source a card's LoRA bindings may lean on, read only when there is one. */
export async function loraSource(sourceWorldId: string | null | undefined, sourceCreatorId: string | null | undefined, creatorId: string | null | undefined): Promise<LoraOwners["source"]> {
  if (!sourceWorldId || !sourceCreatorId || sourceCreatorId === creatorId) return null;
  const [row] = await db.select({ schema: worlds.schema }).from(worlds).where(eq(worlds.id, sourceWorldId)).limit(1);
  return row?.schema ? { creatorId: sourceCreatorId, world: row.schema as unknown as WorldDefinition } : null;
}

type ModelRow = Pick<typeof generationModels.$inferSelect, "id" | "userId" | "filename" | "kind" | "status" | "baseFamily" | "takedownReason" | "isPublic" | "syncedRegions" | "triggerWords">;

/** Whether `owners` may draw with this model in story illustrations. */
export function usableLora(row: ModelRow | undefined, owners: (string | null | undefined)[]): row is ModelRow {
  if (!row || row.kind !== "lora" || row.status !== "ready" || row.baseFamily !== "anima" || row.takedownReason) return false;
  // An evicted library file (ready, no comfy:<id>) is uploaded again before the draw.
  return row.isPublic || (row.userId !== null && owners.includes(row.userId));
}

function toDraw(row: ModelRow, binding: ImageLoraBinding, weight: number): DrawLora {
  return { modelId: row.id, file: row.filename, weight: binding.weight ?? weight, trigger: cleanTrigger(binding.trigger ?? defaultTrigger(row.triggerWords)) };
}

/** A world about to be saved: its bindings' trigger words cleaned like looks,
 *  and a binding that isn't one dropped. Mutates and returns the schema. */
export function cleanWorldLoraBindings<T>(schema: T): T {
  if (!schema || typeof schema !== "object") return schema;
  const w = schema as { settings?: Record<string, unknown>; entries?: unknown };
  if (w.settings && typeof w.settings === "object" && "illustrationLora" in w.settings) {
    const binding = readBinding(w.settings.illustrationLora);
    if (binding) w.settings.illustrationLora = binding;
    else delete w.settings.illustrationLora;
  }
  if (Array.isArray(w.entries)) {
    for (const e of w.entries as Record<string, unknown>[]) {
      if (!e || typeof e !== "object" || !("imageLora" in e)) continue;
      const binding = readBinding(e.imageLora);
      if (binding) e.imageLora = binding;
      else delete e.imageLora;
    }
  }
  return schema;
}

/** Every binding of this card and persona that may be drawn with, in one query. */
export async function resolveTurnImageLoras(world: WorldDefinition, owners: LoraOwners, persona: ImageLoraBinding | null): Promise<TurnImageLoras> {
  const style = readBinding(world.settings?.illustrationLora);
  const characters = characterBindings(world);
  const ids = [...new Set([style?.modelId, persona?.modelId, ...characters.map((c) => c.binding.modelId)].filter((id): id is string => !!id))];
  if (ids.length === 0) return { characters: [] };
  const rows = await db.select({
    id: generationModels.id, userId: generationModels.userId, filename: generationModels.filename, kind: generationModels.kind,
    status: generationModels.status, baseFamily: generationModels.baseFamily, takedownReason: generationModels.takedownReason,
    isPublic: generationModels.isPublic, syncedRegions: generationModels.syncedRegions, triggerWords: generationModels.triggerWords,
  }).from(generationModels).where(inArray(generationModels.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: TurnImageLoras = { characters: [] };
  const styleRow = style ? byId.get(style.modelId) : undefined;
  if (style && usableForCard(styleRow, owners, { kind: "style" })) out.style = toDraw(styleRow, style, STYLE_LORA_WEIGHT);
  for (const c of characters) {
    const row = byId.get(c.binding.modelId);
    if (usableForCard(row, owners, { kind: "character", id: c.id, name: c.name })) out.characters.push({ name: c.name, lora: toDraw(row, c.binding, CHARACTER_LORA_WEIGHT) });
  }
  const personaRow = persona ? byId.get(persona.modelId) : undefined;
  if (persona && usableLora(personaRow, [owners.player])) out.persona = toDraw(personaRow, persona, CHARACTER_LORA_WEIGHT);
  return out;
}

/** A look's tags with a trigger right after its head count ("1girl, klukaigf2, silver hair, …"):
 *  the head count stays first, where the prompt builders look for it. */
export function withTrigger(look: string, raw: string): string {
  const trigger = cleanTrigger(raw);
  if (!trigger) return look;
  const tags = look.split(",").map((t) => t.trim()).filter(Boolean);
  const at = tags.length && /^1(?:girl|boy|other)$/i.test(tags[0]!) ? 1 : 0;
  tags.splice(at, 0, trigger);
  return tags.join(", ");
}

/** A picture whose LoRA triggers name something explicit is explicit itself. */
export function triggersExplicit(loras: readonly DrawLora[]): boolean {
  return isExplicitMoment(false, ...loras.map((l) => l.trigger));
}

/** The picture's LoRAs whose library file is there, restoring evicted ones first
 *  (the draw waits for the upload). One that can't be restored is left out. */
export async function loadLorasForDraw(loras: readonly DrawLora[]): Promise<DrawLora[]> {
  if (!loras.length) return [];
  const rows = await db.select().from(generationModels).where(inArray(generationModels.id, loras.map((l) => l.modelId)));
  const ok = await Promise.all(loras.map(async (l) => {
    const row = rows.find((r) => r.id === l.modelId);
    if (!row) return null;
    if (comfyAssetId(row.syncedRegions)) return l;
    return ensureInLibrary(row).then(() => l, (error) => {
      console.warn(`[PerTurnImage] LoRA ${row.filename} not restored:`, error instanceof Error ? error.message : error);
      return null;
    });
  }));
  return ok.filter((l): l is DrawLora => l !== null);
}

/** The schema's LoRA bindings (the card's style, each character's), for a pass over them. */
export function worldLoraBindings(schema: unknown): { binding: ImageLoraBinding }[] {
  if (!schema || typeof schema !== "object") return [];
  const w = schema as { settings?: { illustrationLora?: ImageLoraBinding }; entries?: { imageLora?: ImageLoraBinding }[] };
  return [
    ...(w.settings?.illustrationLora ? [{ binding: w.settings.illustrationLora }] : []),
    ...(Array.isArray(w.entries) ? w.entries.filter((e) => e?.imageLora).map((e) => ({ binding: e.imageLora! })) : []),
  ];
}

// A character LoRA draws its own hair and eyes. The card's words for them (the
// tagger's "dark blue hair, blue eyes") pulled a trained "Mira" away from her
// teal: for a character with a LoRA they are left out, and the LoRA + trigger decide.
const HAIR_EYE_TAG_RE = /(^|\s)(hair|eyes|eye color|pupils)$/i;
const HAIRSTYLE_TAG_RE = /^(?:[\w-]+ )*(?:bangs|ponytail|ponytails|twintails|twin tails|braid|braids|braided [\w ]+|hair bun|double bun|single hair bun|sidelocks?|ahoge|bob cut|hime cut|drill hair|ringlets|half updo|updo|side ponytail|low ponytail|high ponytail|hair over one eye|hair between eyes|heterochromia|parted bangs|swept bangs|blunt bangs)$/i;

/** A look's tags without its hair colour, hairstyle and eye colour (head count,
 *  build, species, marks, glasses stay): what a character LoRA draws itself. */
export function lookForLora(tags: string): string {
  return tags.split(",").map((t) => t.trim()).filter((t) => t && !HAIR_EYE_TAG_RE.test(t) && !HAIRSTYLE_TAG_RE.test(t)).join(", ");
}

const CAPTION_COLOR = String.raw`(?:(?:light|dark|pale|deep|bright|ash|steel)[- ])?(?:silver|white|black|blonde?|brown|red|pink|blue|green|purple|violet|teal|cyan|aqua|orange|gr[ae]y|yellow|golden|gold|platinum|navy|crimson|scarlet|emerald|amber|azure|turquoise|lavender|magenta|auburn|ginger|chestnut|hazel)(?:[- ](?:and|to)[- ][\w-]+)?`;

/** The caption with its hair and eye colours taken out ("a teal-haired woman with
 *  blue eyes" → "a woman with eyes"): for a picture of one character drawn by a LoRA. */
export function captionForLora(caption: string): string {
  return caption
    .replace(new RegExp(String.raw`\b${CAPTION_COLOR}[- ](?:haired|eyed)\b[ ,]*`, "gi"), "")
    .replace(new RegExp(String.raw`\b(?:(?:long|short|very long|wavy|straight|curly)[ ,]+)*${CAPTION_COLOR} (hair|eyes)\b`, "gi"), "$1")
    .replace(/\s{2,}/g, " ").trim();
}
