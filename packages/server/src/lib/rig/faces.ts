import { liveCharacters, type WorldDefinition } from "@yumina/engine";
import { publicRigCharacter } from "./characters.js";

/**
 * The creator's own expressions for the live characters a card shows beside its chat, by the ref the card names
 * them with ("@rig:<id>"), for the face prompt (engine buildLiveFaceBlock). The built-in faces need no lookup; only
 * the names the creator gave their own ones do, and only those switched on. A fixed pack ("@asset:") keeps the
 * built-in faces. Read through a short cache: a turn needs it, a changed setting may wait a few minutes.
 */
const TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; names: string[] }>();

async function ownFaces(id: string): Promise<string[]> {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.names;
  let names: string[] = [];
  try {
    const character = await publicRigCharacter(id);
    const off = new Set<string>(character?.settings.off ?? []);
    names = (character?.settings.custom ?? []).filter((c) => !off.has(c.slot)).map((c) => c.name);
  } catch (error) {
    console.error("[rig] own faces:", error);
    return hit?.names ?? [];
  }
  if (cache.size > 2000) cache.clear();
  cache.set(id, { at: Date.now(), names });
  return names;
}

const RIG_REF = /^@rig:([0-9a-f-]{36})$/i;

export async function liveFacesFor(world: Pick<WorldDefinition, "entries">): Promise<Record<string, string[]>> {
  const refs = [...new Set(liveCharacters(world.entries).map((e) => e.portraitLive!.trim()))];
  const out: Record<string, string[]> = {};
  await Promise.all(refs.map(async (ref) => {
    const id = RIG_REF.exec(ref)?.[1];
    if (!id) return;
    const names = await ownFaces(id.toLowerCase());
    if (names.length) out[ref] = names;
  }));
  return out;
}
