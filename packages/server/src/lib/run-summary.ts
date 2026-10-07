import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { messages, playSessions } from "../db/schema.js";
import { resolveStation, type Worldbook } from "@yumina/engine";
import type { ChatMessage } from "./llm/types.js";
import { applyModelRedirect } from "./llm/model-redirects.js";
import { DEFAULT_STORY_SUMMARY_MODEL, generateStorySummaryText } from "./session-compaction.js";
import {
  formatMessagesForStoryCompaction,
  splitMessagesIntoCompactionChunks,
  type StoryMessageRow,
} from "./session-compaction-core.js";
import { buildSummaryLanguageInstruction, normalizeSessionSummaryLanguage } from "./summary-language.js";
import { attachRunSummary, type RunMemories, type RunRecord } from "./run-scopes.js";

/**
 * The run summarizer: when an archiving module closes (a dungeon attempt ends),
 * compress that run's transcript into the one block that will stand in for it
 * in every later prompt. Fire-and-forget — a turn must never wait on it, and
 * until it lands the fold shows a neutral "记忆整理中" stub.
 *
 * Persistence discipline: the result is attached with a read-modify-write of
 * play_sessions.run_memories under FOR UPDATE, matched by record identity
 * (bookId+runIndex+fromAt). If the record is gone — the player reverted the
 * run out of existence while we were summarizing — the summary is discarded.
 */

const MAX_RUN_SUMMARY_TOKENS = 700;

function buildRunSummaryPrompt(args: {
  worldName: string | null | undefined;
  moduleName: string;
  runIndex: number;
  transcript: string;
  languageInstruction: string;
  extraInstruction?: string;
}): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You write the ARCHIVED MEMORY of one finished dungeon run (副本攻略) from an interactive-fiction session.",
        "This memory will replace the run's full transcript in the AI's context forever, so keep exactly what the story still needs:",
        "- how the run ended (cleared / failed / fled) and what caused that outcome",
        "- concrete gains and losses: items, points, injuries, deaths, promises, debts",
        "- named characters met inside and how relations stand now",
        "- secrets or mechanics of this dungeon the protagonist LEARNED (not ones they never found)",
        "Do not invent details. Do not editorialize. Write 3-8 tight sentences of plain prose — no headings, no lists, no JSON.",
        args.extraInstruction ? `Card-specific instruction from the creator: ${args.extraInstruction}` : "",
        args.languageInstruction,
      ]
        .filter(Boolean)
        .join("\n"),
    },
    {
      role: "user",
      content: `World: ${args.worldName ?? "(unnamed)"}\nDungeon module: ${args.moduleName} — attempt #${args.runIndex}\n\nTranscript of the run:\n${args.transcript}`,
    },
  ];
}

async function loadRunRows(sessionId: string, record: RunRecord): Promise<StoryMessageRow[]> {
  const rows = await db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
      contentLen: messages.contentLen,
      contentCjkLen: messages.contentCjkLen,
    })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        gte(messages.createdAt, new Date(record.fromAt)),
        lte(messages.createdAt, new Date(record.toAt)),
      ),
    )
    .orderBy(asc(messages.createdAt));
  return rows as StoryMessageRow[];
}

async function persistRunSummary(sessionId: string, record: RunRecord, summary: string | null): Promise<void> {
  await db.transaction(async (tx) => {
    const locked = await tx.execute(
      // FOR UPDATE: the send-path transition hook writes this column too.
      sql`SELECT run_memories FROM play_sessions WHERE id = ${sessionId} FOR UPDATE`,
    );
    if (locked.rows.length === 0) return;
    const current = (locked.rows[0] as { run_memories: RunMemories | null }).run_memories;
    const next = attachRunSummary(current, record, summary);
    if (!next) return; // record reverted away mid-flight — discard
    await tx
      .update(playSessions)
      .set({ runMemories: next as unknown as Record<string, unknown> })
      .where(eq(playSessions.id, sessionId));
  });
}

async function summarizeRunNow(args: {
  sessionId: string;
  userId: string;
  worldName: string | null | undefined;
  book: Worldbook;
  record: RunRecord;
}): Promise<void> {
  const [session] = await db
    .select({ summaryModel: playSessions.summaryModel, summaryLanguage: playSessions.summaryLanguage })
    .from(playSessions)
    .where(eq(playSessions.id, args.sessionId))
    .limit(1);
  if (!session) return;

  const rows = await loadRunRows(args.sessionId, args.record);
  if (rows.length === 0) {
    // Nothing to summarize (span reverted away already) — mark failed so the
    // fold shows the plain sealed stub instead of "整理中" forever.
    await persistRunSummary(args.sessionId, args.record, null);
    return;
  }

  const model = applyModelRedirect((session.summaryModel || DEFAULT_STORY_SUMMARY_MODEL).trim());
  const language = normalizeSessionSummaryLanguage(session.summaryLanguage);
  const languageInstruction = buildSummaryLanguageInstruction(language, { keepEnglishHeadings: false });

  // One run is usually one chunk; a marathon attempt gets chunked and the
  // LAST chunk wins the detail budget (the ending is what the memory is for),
  // with earlier chunks squeezed into the same transcript budget by the
  // splitter's own token accounting.
  const chunks = splitMessagesIntoCompactionChunks(rows, undefined, model);
  const transcript = chunks.map((chunk) => formatMessagesForStoryCompaction(chunk)).join("\n");

  const summary = await generateStorySummaryText({
    userId: args.userId,
    sessionId: args.sessionId,
    model,
    prompt: buildRunSummaryPrompt({
      worldName: args.worldName,
      moduleName: args.book.name,
      runIndex: args.record.runIndex,
      transcript,
      languageInstruction,
      extraInstruction: resolveStation(args.book)?.archivePrompt,
    }),
    endpoint: "run-summary",
    maxTokens: MAX_RUN_SUMMARY_TOKENS,
  });

  await persistRunSummary(args.sessionId, args.record, summary);
}

/** Fire-and-forget entry point — never throws into the caller's turn. */
export function scheduleRunSummary(args: {
  sessionId: string;
  userId: string;
  worldName: string | null | undefined;
  book: Worldbook;
  record: RunRecord;
}): void {
  void summarizeRunNow(args).catch(async (err) => {
    console.error(
      `[RunSummary] ${args.sessionId} ${args.book.id}#${args.record.runIndex} failed:`,
      err instanceof Error ? err.message : err,
    );
    await persistRunSummary(args.sessionId, args.record, null).catch(() => {});
  });
}
