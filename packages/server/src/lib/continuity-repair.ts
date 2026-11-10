import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { messages, playSessions, summaryceptionSnippets } from "../db/schema.js";

const memoryFields = ["sessionMemory", "sessionMemoryUpdatedAt", "sessionMemoryStatus", "sessionMemoryClaimedAt", "sessionMemoryError", "sessionMemoryRetryCount", "sessionMemorySourceHash", "sessionMemoryProcessedMessageId", "sessionMemoryStaleAt"] as const;
const storyFields = ["summary", "summaryUpdatedAt", "summaryStatus", "summaryError", "summarySourceHash", "summaryCoversUntilMessageId", "summaryTokenCount", "summaryClaimedAt"] as const;
const layeredFields = ["summaryceptionStatus", "summaryceptionError", "summaryceptionSourceHash", "summaryceptionCoversUntilMessageId", "summaryceptionTokenCount", "summaryceptionUpdatedAt"] as const;
type Session = typeof playSessions.$inferSelect;
type RepairFields = Partial<Pick<Session, typeof memoryFields[number] | typeof storyFields[number] | typeof layeredFields[number]>>;
export type ContinuityRepairBackup = {
  version: 1; sessionId: string; userId: string; token: string;
  before: RepairFields; after: RepairFields;
  historyDigest: string;
  flags: Array<{ id: string; compacted: boolean; summaryceptionCompacted: boolean }>;
  snippets: Array<typeof summaryceptionSnippets.$inferSelect>;
  preservedManual: string[];
};
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function history(tx: Tx, sessionId: string) {
  // Page large sessions. Fingerprint without exporting private dialogue.
  const digest = createHash("sha256");
  const flags: ContinuityRepairBackup["flags"] = [];
  for (let offset = 0;; offset += 200) {
    const rows = await tx.select({ id: messages.id, role: messages.role, content: messages.content,
      state: messages.stateSnapshot, compacted: messages.compacted, summaryceptionCompacted: messages.summaryceptionCompacted })
      .from(messages).where(eq(messages.sessionId, sessionId)).orderBy(asc(messages.createdAt), asc(messages.id)).limit(200).offset(offset);
    for (const row of rows) {
      digest.update(JSON.stringify([row.id, row.role, row.content, row.state]));
      flags.push({ id: row.id, compacted: row.compacted, summaryceptionCompacted: row.summaryceptionCompacted });
    }
    if (rows.length < 200) break;
  }
  return { flags, historyDigest: digest.digest("hex") };
}

/** Operator-selected repair, never a bulk migration or guess based on text.
 * Persist the recoverable backup before touching any derived data. Manual
 * records (unknown/generated provenance cleared by editing) stay untouched. */
export async function repairSessionContinuity(args: {
  sessionId: string; userId: string; apply: boolean;
  /** Explicit operator opt-in after reviewing/copying wanted authored notes. */
  resetAuthoredLayered?: boolean;
  saveBackup: (backup: ContinuityRepairBackup) => Promise<void>;
}): Promise<ContinuityRepairBackup> {
  return db.transaction(async tx => {
    const [row] = await tx.select().from(playSessions).where(and(eq(playSessions.id, args.sessionId), eq(playSessions.userId, args.userId))).for("update");
    if (!row) throw new Error("Session not found");
    const allSnippets = await tx.select().from(summaryceptionSnippets).where(eq(summaryceptionSnippets.sessionId, args.sessionId));
    const token = `repair:${randomUUID()}`;
    const before: RepairFields = {}, after: RepairFields = {};
    const preservedManual: string[] = [];
    const copy = (keys: readonly (keyof RepairFields)[]) => {
      for (const key of keys) Object.assign(before, { [key]: row[key] });
    };
    if (row.sessionMemory?.text && (!row.sessionMemorySourceHash || row.sessionMemorySourceHash.includes(":authored"))) preservedManual.push("memory");
    else {
      copy(memoryFields);
      Object.assign(after, { sessionMemory: null, sessionMemoryUpdatedAt: null, sessionMemoryStatus: "idle", sessionMemoryClaimedAt: null,
        sessionMemoryError: null, sessionMemoryRetryCount: 0, sessionMemorySourceHash: token, sessionMemoryProcessedMessageId: null, sessionMemoryStaleAt: null });
    }
    if (row.summary?.trim() && (!row.summarySourceHash || row.summarySourceHash.includes(":authored"))) preservedManual.push("story");
    else {
      copy(storyFields);
      Object.assign(after, { summary: null, summaryUpdatedAt: null, summaryStatus: "idle", summaryError: null,
        summarySourceHash: token, summaryCoversUntilMessageId: null, summaryTokenCount: null, summaryClaimedAt: null });
    }
    if (!args.resetAuthoredLayered && allSnippets.length && (!row.summaryceptionSourceHash || allSnippets.some(s => !s.sourceHash || s.sourceHash.startsWith("manual:") || (!s.promoted && s.updatedAt && s.createdAt && s.updatedAt > s.createdAt)))) preservedManual.push("layered");
    else {
      copy(layeredFields);
      Object.assign(after, { summaryceptionStatus: "idle", summaryceptionError: null, summaryceptionSourceHash: token,
        summaryceptionCoversUntilMessageId: null, summaryceptionTokenCount: null, summaryceptionUpdatedAt: null });
    }
    const backup: ContinuityRepairBackup = { version: 1, sessionId: args.sessionId, userId: args.userId, token,
      before, after, ...await history(tx, args.sessionId), snippets: preservedManual.includes("layered") ? [] : allSnippets, preservedManual };
    await args.saveBackup(backup);
    if (!args.apply) return backup;
    if (Object.keys(after).length) await tx.update(playSessions).set(after).where(eq(playSessions.id, args.sessionId));
    if (!preservedManual.includes("layered")) await tx.delete(summaryceptionSnippets).where(eq(summaryceptionSnippets.sessionId, args.sessionId));
    const flags = { ...(!preservedManual.includes("story") ? { compacted: false } : {}), ...(!preservedManual.includes("layered") ? { summaryceptionCompacted: false } : {}) };
    if (Object.keys(flags).length) await tx.update(messages).set(flags).where(eq(messages.sessionId, args.sessionId));
    return backup;
  });
}

/** Restore only before new dialogue, edits, or generation have changed the
 * repaired session. Never overwrite somebody's subsequent work. */
export async function restoreSessionContinuity(backup: ContinuityRepairBackup) {
  if (backup.version !== 1) throw new Error("Unsupported backup version");
  await db.transaction(async tx => {
    const [row] = await tx.select().from(playSessions).where(and(eq(playSessions.id, backup.sessionId), eq(playSessions.userId, backup.userId))).for("update");
    if (!row) throw new Error("Session not found");
    for (const [key, value] of Object.entries(backup.after)) {
      if (JSON.stringify(row[key as keyof Session]) !== JSON.stringify(value)) throw new Error("Session changed after repair; restore was not applied");
    }
    if ((await history(tx, backup.sessionId)).historyDigest !== backup.historyDigest) throw new Error("History changed after repair; restore was not applied");
    const restored = { ...backup.before };
    for (const key of Object.keys(restored)) {
      if (key.endsWith("At") && restored[key as keyof RepairFields]) Object.assign(restored, { [key]: new Date(restored[key as keyof RepairFields] as string | Date) });
    }
    // Old background leases cannot be revived by restoration.
    if ("sessionMemoryStatus" in restored) Object.assign(restored, { sessionMemoryStatus: "idle", sessionMemoryClaimedAt: null });
    if ("summaryStatus" in restored) Object.assign(restored, { summaryStatus: "idle", summaryClaimedAt: null });
    if ("summaryceptionStatus" in restored) restored.summaryceptionStatus = "idle";
    if (Object.keys(restored).length) await tx.update(playSessions).set(restored).where(eq(playSessions.id, backup.sessionId));
    if (!backup.preservedManual.includes("layered")) {
      await tx.delete(summaryceptionSnippets).where(eq(summaryceptionSnippets.sessionId, backup.sessionId));
      if (backup.snippets.length) await tx.insert(summaryceptionSnippets).values(backup.snippets.map(s => ({ ...s, createdAt: s.createdAt ? new Date(s.createdAt) : null, updatedAt: s.updatedAt ? new Date(s.updatedAt) : null })));
    }
    for (const flag of backup.flags) {
      const patch = { ...(!backup.preservedManual.includes("story") ? { compacted: flag.compacted } : {}), ...(!backup.preservedManual.includes("layered") ? { summaryceptionCompacted: flag.summaryceptionCompacted } : {}) };
      if (Object.keys(patch).length) await tx.update(messages).set(patch).where(and(eq(messages.id, flag.id), eq(messages.sessionId, backup.sessionId)));
    }
  });
}
