/**
 * The voices an assistant can give a character, beyond the curated catalog
 * its tool description already lists: the creator's own (designed, cloned or
 * kept from the plaza) and the ones people shared on the voice plaza.
 *
 * The Studio assistant and an outside AI both knew only the 25 curated ids, so
 * "give her the voice I made" or "find her a voice on the plaza" had no
 * answer but "paste me the id".
 */
import { and, desc, eq, or, sql } from "drizzle-orm";
import { readTtsCustomVoices, ttsCustomVoiceLabel } from "@yumina/shared";
import { db } from "../../db/index.js";
import { user, workbenchElements } from "../../db/schema.js";
import { sharedElementSql } from "../workbench/elements.js";

/** The tool is defined with the other Studio tools: lib/studio-tools/tools.ts LIST_VOICES_TOOL. */
interface ListedVoice { id: string; name: string; sounds?: string; language?: string }

const tidy = (text: string | null | undefined) => (text ?? "").replace(/^[🎙📎]\s*/u, "").replace(/\s+/g, " ").trim().slice(0, 160);

export async function listVoicesForAssistant(userId: string, input: Record<string, unknown>): Promise<{ mine: ListedVoice[]; plaza: ListedVoice[]; note: string }> {
  const query = typeof input.query === "string" ? input.query.trim().slice(0, 40) : "";
  const like = `%${query.replace(/[%_\\]/g, "\\$&")}%`;
  const [owner] = await db.select({ preferences: user.preferences }).from(user).where(eq(user.id, userId)).limit(1);
  const own = await db.select({ name: workbenchElements.name, description: workbenchElements.description, voice: workbenchElements.voice })
    .from(workbenchElements)
    .where(and(eq(workbenchElements.userId, userId), eq(workbenchElements.kind, "voice")))
    .orderBy(desc(workbenchElements.updatedAt)).limit(60);
  const mine: ListedVoice[] = [];
  const seen = new Set<string>();
  for (const row of own) {
    if (row.voice?.provider !== "fish" || seen.has(row.voice.voiceId)) continue;
    seen.add(row.voice.voiceId);
    mine.push({ id: row.voice.voiceId, name: row.name, ...(tidy(row.description) ? { sounds: tidy(row.description) } : {}), ...(row.voice.lang ? { language: row.voice.lang } : {}) });
  }
  // Voices kept from the plaza (or pasted) live in the readout list alone.
  for (const kept of readTtsCustomVoices(owner?.preferences ?? {})) {
    if (seen.has(kept.id)) continue;
    seen.add(kept.id);
    mine.push({ id: kept.id, name: ttsCustomVoiceLabel(kept) });
  }
  const rows = await db.select({ snapshot: workbenchElements.approvedSnapshot, voice: workbenchElements.voice })
    .from(workbenchElements)
    .innerJoin(user, eq(user.id, workbenchElements.userId))
    .where(and(eq(workbenchElements.kind, "voice"), sharedElementSql("safe"), eq(user.isBanned, false),
      sql`${workbenchElements.voice}->>'provider' = 'fish'`,
      ...(query ? [or(sql`${workbenchElements.approvedSnapshot}->>'name' ILIKE ${like}`, sql`${workbenchElements.approvedSnapshot}->>'description' ILIKE ${like}`)!] : [])))
    .orderBy(desc(workbenchElements.useCount), desc(workbenchElements.createdAt)).limit(30);
  const plaza: ListedVoice[] = rows.flatMap((row) => {
    if (row.voice?.provider !== "fish" || !row.snapshot) return [];
    return [{ id: row.voice.voiceId, name: row.snapshot.name, ...(tidy(row.snapshot.description) ? { sounds: tidy(row.snapshot.description) } : {}), ...(row.voice.lang ? { language: row.voice.lang } : {}) }];
  });
  return {
    mine, plaza,
    note: plaza.length === 0 && query
      ? "No plaza voice matches those words. Try other words, or omit query for the most used."
      : "Put an id in write_entry.voice (a character) or update_settings.narratorVoice. The creator can hear any of them with the play button in the card's voice picker.",
  };
}
