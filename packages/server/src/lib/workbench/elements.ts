// 主体库: a creator's characters, scenes, props, voices and styles, @mentioned in any generation prompt.
// One expansion (expandElementMentions) serves every lane: smart images, the video lane, our own image
// models (QuickGenerate) and the media tools.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  WORKBENCH_MENTION_RE, WORKBENCH_MENTIONS_MAX,
  type WorkbenchElement, type WorkbenchElementKind, type WorkbenchMentions, type WorkbenchPublicElement,
} from "@yumina/shared";
import { db } from "../../db/index.js";
import { generationJobs, userAssets, workbenchElementUses, workbenchElements } from "../../db/schema.js";
import { resolveImageCdn } from "../cdn-url.js";

type ElementRow = typeof workbenchElements.$inferSelect;

export const cdnPath = (assetId: string | null | undefined) => (assetId ? `/cdn/${assetId}` : null);

export function elementToJson(row: ElementRow, viewerId: string): WorkbenchElement {
  return {
    id: row.id, kind: row.kind, name: row.name, description: row.description,
    coverAssetId: row.coverAssetId, coverUrl: cdnPath(row.coverAssetId),
    // Someone else's reference pictures are private, even on a public element.
    assetIds: row.userId === viewerId ? (row.assetIds ?? []) : [],
    voice: row.voice ?? null, rigId: row.userId === viewerId ? row.rigId : null,
    archive: row.userId === viewerId ? (row.archive ?? {}) : {},
    visibility: row.visibility, useCount: row.useCount, isMine: row.userId === viewerId,
    status: row.status, rejectReason: row.userId === viewerId ? row.rejectReason : null, isSensitive: row.isSensitive,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

/** What someone other than the owner sees of an element: the last approved review's name, description and
 *  cover. Null when no review has approved it yet. */
export function othersView(row: Pick<ElementRow, "approvedSnapshot">): { name: string; description: string; coverAssetId: string | null } | null {
  return row.approvedSnapshot ?? null;
}

/** SQL: a public element others may see (approved at least once), and not sensitive for a safe viewer. */
export const sharedElementSql = (level: "safe" | "r18") => level === "safe"
  ? sql`(${workbenchElements.visibility} = 'public' AND ${workbenchElements.approvedSnapshot} IS NOT NULL AND ${workbenchElements.isSensitive} = false)`
  : sql`(${workbenchElements.visibility} = 'public' AND ${workbenchElements.approvedSnapshot} IS NOT NULL)`;

/** Name, description and cover only: what a public element shows anyone who is not its owner. */
export function publicElementToJson(
  row: ElementRow, author: { name: string | null; username: string | null; image: string | null }, used: boolean, viewerId: string,
): WorkbenchPublicElement {
  // The owner sees what they wrote; everyone else the last approved content.
  const shown = row.userId === viewerId ? row : othersView(row) ?? { name: row.name, description: "", coverAssetId: null };
  return {
    id: row.id, kind: row.kind, name: shown.name, description: shown.description, coverUrl: cdnPath(shown.coverAssetId),
    useCount: row.useCount, isMine: row.userId === viewerId, used,
    author: { id: row.userId, name: author.name ?? "", username: author.username, image: resolveImageCdn(author.image) },
    voiceId: row.kind === "voice" && row.voice?.provider === "fish" ? row.voice.voiceId : null,
    voiceLang: row.kind === "voice" ? row.voice?.lang ?? null : null,
  };
}

/** Every id must be one of this person's own pictures (or, with `type`, videos). Returns the ones that are not. */
export async function foreignImageAssets(userId: string, ids: string[], type: "image" | "video" = "image"): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const rows = await db.select({ id: userAssets.id }).from(userAssets)
    .where(and(inArray(userAssets.id, unique), eq(userAssets.userId, userId), eq(userAssets.type, type)));
  const own = new Set(rows.map((r) => r.id));
  return unique.filter((id) => !own.has(id));
}

/** A live character the person owns: one of their own rig jobs (the root id the rig lane names it by). */
export async function ownsRig(userId: string, rigId: string): Promise<boolean> {
  const [row] = await db.select({ id: generationJobs.id }).from(generationJobs)
    .where(and(eq(generationJobs.id, rigId), eq(generationJobs.userId, userId), eq(generationJobs.kind, "rig"))).limit(1);
  return !!row;
}

/** The distinct @names in a prompt, in order, at most WORKBENCH_MENTIONS_MAX. */
export function mentionNames(prompt: string): string[] {
  const seen = new Map<string, string>();
  for (const m of prompt.matchAll(WORKBENCH_MENTION_RE)) {
    const name = m[1]!;
    if (!seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
    if (seen.size >= WORKBENCH_MENTIONS_MAX) break;
  }
  return [...seen.values()];
}

export interface MentionElement {
  id: string; name: string; kind: WorkbenchElementKind; description: string;
  /** reference pictures the creator may send (only their own elements carry any) */
  references: string[];
  voice: ElementRow["voice"];
}

/**
 * Pure: a prompt with its resolved elements → the text the model gets. Each `@name` becomes the name, and
 * the descriptions follow the prompt, one line each, so the model knows who and what the names are.
 */
export function applyMentions(prompt: string, elements: MentionElement[], opts: { maxReferences: number; describe?: boolean; maxChars?: number }): WorkbenchMentions | null {
  if (!elements.length) return null;
  const byName = new Map(elements.map((e) => [e.name.toLowerCase(), e]));
  const body = prompt.replace(WORKBENCH_MENTION_RE, (whole, name: string) => byName.get(name.toLowerCase())?.name ?? whole);
  const lines = opts.describe === false ? [] : elements.filter((e) => e.description.trim() && e.kind !== "voice").map((e) =>
    e.kind === "style" ? `Style (${e.name}): ${e.description.trim()}` : `${e.name}: ${e.description.trim()}`);
  // Each element's first picture (a character's portrait) before anyone's second, so two @names both get a face.
  const references: string[] = [];
  const max = Math.max(0, opts.maxReferences);
  for (let round = 0; references.length < max && elements.some((e) => e.references.length > round); round++) {
    for (const e of elements) {
      const id = e.references[round];
      if (id && !references.includes(id) && references.length < max) references.push(id);
    }
  }
  return {
    prompt,
    // Descriptions give way first when the lane caps the prompt's length.
    expandedPrompt: lines.length ? `${body.trim()}\n\n${lines.join("\n")}`.slice(0, Math.max(body.length, opts.maxChars ?? Infinity)) : body,
    elements: elements.map((e) => ({ id: e.id, name: e.name, kind: e.kind })),
    referenceAssetIds: references,
  };
}

/** The elements a prompt's @names reach for this person: their own first, then public ones they have used. */
export async function resolveMentions(userId: string, prompt: string): Promise<MentionElement[]> {
  const names = mentionNames(prompt);
  if (!names.length) return [];
  const lowered = names.map((n) => n.toLowerCase());
  const own = await db.select().from(workbenchElements)
    .where(and(eq(workbenchElements.userId, userId), inArray(sql`lower(${workbenchElements.name})`, lowered)));
  const ownNames = new Set(own.map((e) => e.name.toLowerCase()));
  const rest = lowered.filter((n) => !ownNames.has(n));
  // Someone else's element answers to its approved name, with its approved words (an edit waiting for review
  // changes nothing for those who took it in).
  const borrowed = rest.length ? await db.select({ element: workbenchElements }).from(workbenchElementUses)
    .innerJoin(workbenchElements, eq(workbenchElements.id, workbenchElementUses.elementId))
    .where(and(eq(workbenchElementUses.userId, userId), eq(workbenchElements.visibility, "public"),
      sql`${workbenchElements.approvedSnapshot} IS NOT NULL`,
      inArray(sql`lower(${workbenchElements.approvedSnapshot}->>'name')`, rest)))
    .orderBy(desc(workbenchElementUses.createdAt)) : [];
  // The newest-used public element wins a name two authors share.
  const picked = new Map<string, ElementRow>();
  for (const e of own) picked.set(e.name.toLowerCase(), e);
  for (const { element } of borrowed) {
    const seen = othersView(element)!;
    const key = seen.name.toLowerCase();
    if (!picked.has(key)) picked.set(key, { ...element, name: seen.name, description: seen.description, coverAssetId: seen.coverAssetId });
  }

  // Reference pictures still in the owner's library (a deleted one drops out).
  const refIds = own.flatMap((e) => elementPictures(e)).filter((id): id is string => !!id);
  const live = refIds.length ? new Set((await db.select({ id: userAssets.id }).from(userAssets)
    .where(and(inArray(userAssets.id, [...new Set(refIds)]), eq(userAssets.userId, userId), eq(userAssets.type, "image")))).map((r) => r.id)) : new Set<string>();

  return lowered.map((n) => picked.get(n)).filter((e): e is ElementRow => !!e).map((e) => ({
    id: e.id, name: e.name, kind: e.kind, description: e.description, voice: e.voice ?? null,
    // Someone else's public element lends its words only, never its pictures.
    references: e.userId === userId ? [...new Set(elementPictures(e))].filter((id): id is string => !!id && live.has(id)) : [],
  }));
}

/** An element's pictures, best reference first: its cover (a character's portrait), its other reference
 *  pictures, then what is kept as hers, newest outfit and newest expression in turn. */
export function elementPictures(e: Pick<ElementRow, "coverAssetId" | "assetIds" | "archive">): (string | null)[] {
  const outfits = e.archive?.outfits ?? [];
  const expressions = e.archive?.expressions ?? [];
  const kept: string[] = [];
  for (let i = 0; i < Math.max(outfits.length, expressions.length); i++) {
    if (outfits[i]) kept.push(outfits[i]!);
    if (expressions[i]) kept.push(expressions[i]!);
  }
  return [e.coverAssetId, ...(e.assetIds ?? []), ...kept];
}

/** Resolve and apply in one: null when the prompt names no element this person can reach. */
export async function expandElementMentions(userId: string, prompt: string, opts: { maxReferences: number; describe?: boolean; maxChars?: number }): Promise<WorkbenchMentions | null> {
  if (!prompt.includes("@")) return null;
  return applyMentions(prompt, await resolveMentions(userId, prompt), opts);
}

/** Count a use of each element once a job that used them exists. */
export async function countElementUses(elementIds: string[]): Promise<void> {
  const ids = [...new Set(elementIds)];
  if (!ids.length) return;
  await db.update(workbenchElements).set({ useCount: sql`${workbenchElements.useCount} + 1` }).where(inArray(workbenchElements.id, ids));
}

/** Record the mentions on the job, so its card can say "used @Frieren". */
export async function recordMentions(jobId: string, mentions: WorkbenchMentions): Promise<void> {
  await db.update(generationJobs).set({ params: sql`${generationJobs.params} || ${JSON.stringify({ mentions })}::jsonb` })
    .where(eq(generationJobs.id, jobId));
  await countElementUses(mentions.elements.map((e) => e.id)).catch(() => {});
}

/** How many more reference pictures a video request can take: the model's limit, less what it already
 *  carries, and none (or few) beside frames on models whose references are their own mode. */
export function videoReferenceRoom(
  spec: { maxReferences: number; referencesWithoutFrames?: boolean; referencesWithFirstFrame?: number; referenceVideo?: unknown },
  req: { referenceAssetIds?: string[]; firstFrameAssetId?: string; lastFrameAssetId?: string; referenceVideoAssetId?: string },
): number {
  const have = req.referenceAssetIds?.length ?? 0;
  let cap = spec.maxReferences;
  if (spec.referencesWithoutFrames) {
    if (req.lastFrameAssetId) cap = 0;
    else if (req.firstFrameAssetId) cap = Math.min(cap, spec.referencesWithFirstFrame ?? 0);
  }
  return Math.max(0, cap - have);
}
