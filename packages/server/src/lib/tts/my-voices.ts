/**
 * 我的声音: the fish.audio voices a person made (designed from words, or cloned from a recording).
 *
 * A kept voice is two things at once, so it is usable everywhere without being picked twice:
 *   - a workbench voice element (kind "voice", voice.provider "fish"): listed in the 声音 studio, @mentionable,
 *     and what a workbench character keeps as her voice;
 *   - an entry in the person's custom readout voices (preferences.ttsCustomVoices): the card editor's voice
 *     picker and the readout settings list those, so it can be a card character's voice straight away.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import {
  TTS_VOICE_POOL_MAX,
  WORKBENCH_ELEMENT_DESCRIPTION_MAX,
  WORKBENCH_ELEMENTS_PER_USER_MAX,
  readTtsCustomVoices,
  type TtsCustomVoice,
  type WorkbenchVoiceLang,
} from "@yumina/shared";
import { db } from "../../db/index.js";
import { user, workbenchElements, workbenchElementUses } from "../../db/schema.js";

/** design / clone: made here. saved: a voice id the person added to their readout voices some other way (pasted,
 *  or designed in the card editor before 我的声音 existed). */
export type VoiceSource = "design" | "clone" | "saved";

export interface MyVoice {
  /** The workbench element. */
  elementId: string;
  name: string;
  /** The fish.audio voice id (what a card character's voice field takes). */
  voiceId: string;
  /** The language its maker recommends, the cover picture: what the 广场 shows with it. */
  lang: WorkbenchVoiceLang | null;
  coverAssetId: string | null;
  coverUrl: string | null;
  /** For a designed voice, the words it was designed from. */
  description: string;
  source: VoiceSource;
  createdAt: string;
  /** On the 声音广场 (public, after review) or mine alone. */
  visibility: "private" | "public";
  /** A public voice's review: pending until someone approves it. */
  status: "pending" | "approved" | "rejected";
  /** How many people took it from the 声音广场. */
  useCount: number;
}

/** Marks a cloned voice's element; a designed one keeps its description. */
export const CLONE_MARK = "🎙";

const NAME_KEEP = /[^\p{L}\p{N}_\-·]+/gu;

/** A name an element can have (no spaces, 1–40) from what the person typed, else the description's first clause
 *  ("二十岁出头的女剑客，声音清冷…" → "二十岁出头的女剑客"). */
export function voiceElementName(raw: unknown, fallback: string): string {
  const typed = typeof raw === "string" ? raw.replace(NAME_KEEP, "").slice(0, 24) : "";
  if (typed) return typed;
  const clause = fallback.split(/[，,。.;；、!！?？:：\n]/).map((c) => c.trim()).find(Boolean) ?? "";
  const fromWords = clause.replace(NAME_KEEP, "").slice(0, 12);
  return fromWords || "声音";
}

const nameTaken = (error: unknown) => (error as { code?: string; cause?: { code?: string } })?.code === "23505"
  || (error as { cause?: { code?: string } })?.cause?.code === "23505";

/** Marks a voice brought in from the readout list. */
export const SAVED_MARK = "📎";

function toMyVoice(row: typeof workbenchElements.$inferSelect): MyVoice | null {
  if (row.voice?.provider !== "fish") return null;
  const mark = [CLONE_MARK, SAVED_MARK].find((m) => row.description.startsWith(m));
  return {
    elementId: row.id,
    name: row.name,
    voiceId: row.voice.voiceId,
    lang: row.voice.lang ?? null,
    coverAssetId: row.coverAssetId,
    coverUrl: row.coverAssetId ? `/cdn/${row.coverAssetId}` : null,
    description: mark ? row.description.slice(mark.length).trim() : row.description,
    source: mark === CLONE_MARK ? "clone" : mark === SAVED_MARK ? "saved" : "design",
    createdAt: row.createdAt.toISOString(),
    visibility: row.visibility,
    status: row.status,
    useCount: row.useCount,
  };
}

async function myVoiceRows(userId: string) {
  return db.select().from(workbenchElements)
    .where(and(eq(workbenchElements.userId, userId), eq(workbenchElements.kind, "voice"), sql`${workbenchElements.voice}->>'provider' = 'fish'`))
    .orderBy(desc(workbenchElements.createdAt))
    .limit(200);
}

/**
 * 我的声音. A readout voice with no element yet (designed in the card editor before 我的声音 existed, or a pasted
 * id) gets one here, so the two lists hold the same voices. A voice taken from the 声音广场 is someone else's: it
 * stays in the readout list and never becomes an element of mine (which I could then publish as my own).
 */
export async function listMyVoices(userId: string): Promise<MyVoice[]> {
  let rows = await myVoiceRows(userId);
  const [owner] = await db.select({ preferences: user.preferences }).from(user).where(eq(user.id, userId)).limit(1);
  const have = new Set([...rows.map((r) => r.voice?.voiceId), ...await takenVoiceIds(userId)]);
  const missing = readTtsCustomVoices(owner?.preferences ?? {}).filter((v) => !have.has(v.id));
  if (missing.length) {
    for (const v of missing) {
      await insertVoiceElement(userId, { voiceId: v.id, base: voiceElementName("", v.name || `声音${v.id.slice(0, 4)}`), description: `${SAVED_MARK} ${v.name}`.trim() })
        .catch((err) => console.warn("[MyVoices] backfill failed:", err instanceof Error ? err.message : err));
    }
    rows = await myVoiceRows(userId);
    // The readout list takes the short names the elements got, so both lists say the same.
    const names = new Map(rows.flatMap((r) => (r.voice ? [[r.voice.voiceId, r.name] as const] : [])));
    await editReadoutVoices(userId, (list) => list.map((v) => ({ ...v, name: names.get(v.id) ?? v.name })))
      .catch((err) => console.warn("[MyVoices] readout names update failed:", err instanceof Error ? err.message : err));
  }
  return rows.flatMap((r) => toMyVoice(r) ?? []);
}

/** An element for a voice, its name made unique with -2, -3… */
async function insertVoiceElement(userId: string, input: { voiceId: string; base: string; description: string }) {
  for (let n = 1; n <= 20; n++) {
    const name = n === 1 ? input.base : `${input.base.slice(0, 36)}-${n}`;
    try {
      const [row] = await db.insert(workbenchElements).values({
        userId, kind: "voice", name, description: input.description.slice(0, WORKBENCH_ELEMENT_DESCRIPTION_MAX),
        voice: { provider: "fish", voiceId: input.voiceId }, visibility: "private", status: "approved",
      }).returning();
      return row!;
    } catch (error) {
      if (!nameTaken(error)) throw error;
    }
  }
  throw new Error("no free name for the voice");
}

export class KeepVoiceError extends Error {
  constructor(public readonly code: "TOO_MANY_ELEMENTS" | "NAME_TAKEN" | "INVALID_NAME") { super(code); }
}

/** Renames a voice of mine: the element and its readout entry. Null when it is not mine. */
export async function renameMyVoice(userId: string, elementId: string, raw: unknown): Promise<MyVoice | null> {
  const name = typeof raw === "string" ? raw.replace(NAME_KEEP, "").slice(0, 40) : "";
  if (!name) throw new KeepVoiceError("INVALID_NAME");
  let row: typeof workbenchElements.$inferSelect | undefined;
  try {
    [row] = await db.update(workbenchElements).set({ name, updatedAt: new Date() })
      .where(and(eq(workbenchElements.id, elementId), eq(workbenchElements.userId, userId), eq(workbenchElements.kind, "voice"))).returning();
  } catch (error) {
    if (nameTaken(error)) throw new KeepVoiceError("NAME_TAKEN");
    throw error;
  }
  const voice = row ? toMyVoice(row) : null;
  if (voice) await editReadoutVoices(userId, (list) => list.map((v) => (v.id === voice.voiceId ? { ...v, name } : v)));
  return voice;
}

/** Removes a voice from 我的声音 and the readout list. Cards that already use it keep it (the fish voice stays). */
export async function deleteMyVoice(userId: string, elementId: string): Promise<boolean> {
  const [row] = await db.delete(workbenchElements)
    .where(and(eq(workbenchElements.id, elementId), eq(workbenchElements.userId, userId), eq(workbenchElements.kind, "voice"))).returning();
  const voiceId = row?.voice?.provider === "fish" ? row.voice.voiceId : null;
  if (voiceId) await editReadoutVoices(userId, (list) => list.filter((v) => v.id !== voiceId));
  return !!row;
}

/**
 * Keeps a fish voice as the person's: the element (its name made unique with -2, -3…) and the readout entry.
 * The same voice id kept twice returns the element it already has.
 */
export async function keepVoice(userId: string, input: { voiceId: string; name: unknown; description: string; source: VoiceSource }): Promise<MyVoice> {
  const [existing] = await db.select().from(workbenchElements)
    .where(and(eq(workbenchElements.userId, userId), sql`${workbenchElements.voice}->>'voiceId' = ${input.voiceId}`))
    .limit(1);
  if (existing && toMyVoice(existing)) return toMyVoice(existing)!;

  const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(workbenchElements).where(eq(workbenchElements.userId, userId));
  if ((count?.n ?? 0) >= WORKBENCH_ELEMENTS_PER_USER_MAX) throw new KeepVoiceError("TOO_MANY_ELEMENTS");

  const base = voiceElementName(input.name, input.description);
  const description = (input.source === "clone" ? `${CLONE_MARK} ${input.description}`.trim() : input.description)
    .slice(0, WORKBENCH_ELEMENT_DESCRIPTION_MAX);
  const row = await insertVoiceElement(userId, { voiceId: input.voiceId, base, description });
  await addReadoutVoice(userId, { id: input.voiceId, name: row.name }).catch((err) => {
    console.warn("[MyVoices] readout list update failed:", err instanceof Error ? err.message : err);
  });
  return toMyVoice(row)!;
}

/** Adds the voice to preferences.ttsCustomVoices (named), unless it is there or the list is full. */
async function addReadoutVoice(userId: string, voice: TtsCustomVoice): Promise<void> {
  await editReadoutVoices(userId, (list) => (list.some((v) => v.id === voice.id) || list.length >= TTS_VOICE_POOL_MAX ? list : [...list, voice]));
}

/** The fish voice ids of the 声音广场 voices this person has taken (others' public voice elements). */
async function takenVoiceIds(userId: string): Promise<string[]> {
  const rows = await db.select({ voiceId: sql<string | null>`${workbenchElements.voice}->>'voiceId'` }).from(workbenchElementUses)
    .innerJoin(workbenchElements, eq(workbenchElements.id, workbenchElementUses.elementId))
    .where(and(eq(workbenchElementUses.userId, userId), eq(workbenchElements.kind, "voice")));
  return rows.flatMap((r) => (r.voiceId ? [r.voiceId] : []));
}

/**
 * 声音广场 › 使用: someone else's public voice joins my readout voices (the card editor's voice list, the chat voice
 * panel, 配音), named as its author named it. "full" when my list already holds TTS_VOICE_POOL_MAX voices.
 */
export async function takeReadoutVoice(userId: string, voice: TtsCustomVoice): Promise<"added" | "had" | "full"> {
  let outcome: "added" | "had" | "full" = "added";
  await editReadoutVoices(userId, (list) => {
    if (list.some((v) => v.id === voice.id)) { outcome = "had"; return list; }
    if (list.length >= TTS_VOICE_POOL_MAX) { outcome = "full"; return list; }
    return [...list, voice];
  });
  return outcome;
}

/** 声音广场 › 不用了: the voice leaves my readout voices, unless I keep it as one of mine. */
export async function dropReadoutVoice(userId: string, voiceId: string): Promise<void> {
  const [own] = await db.select({ id: workbenchElements.id }).from(workbenchElements)
    .where(and(eq(workbenchElements.userId, userId), sql`${workbenchElements.voice}->>'voiceId' = ${voiceId}`)).limit(1);
  if (own) return;
  await editReadoutVoices(userId, (list) => list.filter((v) => v.id !== voiceId));
}

async function editReadoutVoices(userId: string, edit: (list: TtsCustomVoice[]) => TtsCustomVoice[]): Promise<void> {
  const [row] = await db.select({ preferences: user.preferences }).from(user).where(eq(user.id, userId)).limit(1);
  const current = readTtsCustomVoices(row?.preferences ?? {});
  const next = edit(current);
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  await db.update(user)
    .set({ preferences: sql`coalesce(${user.preferences}, '{}'::jsonb) || ${JSON.stringify({ ttsCustomVoices: next })}::jsonb` })
    .where(eq(user.id, userId));
}
