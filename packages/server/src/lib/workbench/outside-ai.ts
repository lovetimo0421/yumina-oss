// The workbench library for outside AIs (MCP / agent API): read and add elements, read and use skills.
// Same rules as the workbench routes: an element names only the caller's own pictures; a skill is the
// caller's own or public and approved; a restricted account cannot add anything.

import { and, desc, eq, ilike, notInArray, or, sql } from "drizzle-orm";
import { WORKBENCH_ELEMENT_KINDS, WORKBENCH_ELEMENTS_PER_USER_MAX, WORKBENCH_SKILL_MODES } from "@yumina/shared";
import { db } from "../../db/index.js";
import { user, workbenchElements, workbenchSkills } from "../../db/schema.js";
import type { ToolDefinition } from "../llm/types.js";
import { listBlockedUsersForHiding } from "../blocks.js";
import { generationRestricted } from "../generation/restriction.js";
import { assetIdOf } from "../generation/media-tools.js";
import { liveCharactersForUser } from "../rig/jobs.js";
import { createElementSchema } from "./element-schema.js";
import { notLiveSkillSql, skillMakesLive } from "./recipes.js";
import { elementToJson, foreignImageAssets, publicElementToJson, sharedElementSql } from "./elements.js";
import { viewerContentLevel } from "../../routes/image-posts.js";

type Result = { ok: boolean; result?: unknown; error?: string };

export const LIST_ELEMENTS: ToolDefinition = {
  type: "function",
  function: {
    name: "list_elements",
    description: "The creator's element library (主体库): characters, scenes, props, voices and styles. Writing @name in any image, video or media-tool prompt pulls an element's description in (and, for the creator's own elements, its reference pictures). scope mine = theirs (default), used = public elements they took in, public = everyone's public ones. Free.",
    parameters: { type: "object", properties: {
      scope: { type: "string", enum: ["mine", "used", "public"] },
      kind: { type: "string", enum: [...WORKBENCH_ELEMENT_KINDS] },
      q: { type: "string", description: "Words in the name or description." },
    } },
  },
};

export const CREATE_ELEMENT: ToolDefinition = {
  type: "function",
  function: {
    name: "create_element",
    description: "Add an element to the creator's library so @name works in prompts. name: letters/digits/_-· and no spaces, unique per creator. description: who or what it is, as a prompt would say it (appearance, outfit, look); for a style, the style words. Pictures are the creator's own images as @asset refs (≤6; the first is the cover unless cover is given). Only when the creator asks for it.",
    parameters: { type: "object", properties: {
      kind: { type: "string", enum: [...WORKBENCH_ELEMENT_KINDS] },
      name: { type: "string" },
      description: { type: "string" },
      cover: { type: "string", description: "@asset:<id> of one of the creator's images." },
      assets: { type: "array", items: { type: "string" }, description: "@asset refs of reference images." },
      visibility: { type: "string", enum: ["private", "public"], description: "private (default) or public (others see name, description and cover)." },
    }, required: ["kind", "name"] },
  },
};

export const LIST_SKILLS: ToolDefinition = {
  type: "function",
  function: {
    name: "list_skills",
    description: "Reusable recipes (做法): the community's approved public skills (sort hot or new) or the creator's own (mine). Each has a mode, slots to fill and a use count. use_skill returns one's full recipe. Free.",
    parameters: { type: "object", properties: {
      sort: { type: "string", enum: ["hot", "new"] },
      mode: { type: "string", enum: [...WORKBENCH_SKILL_MODES] },
      mine: { type: "boolean" },
    } },
  },
};

export const USE_SKILL: ToolDefinition = {
  type: "function",
  function: {
    name: "use_skill",
    description: "A skill's recipe (steps with model, prompt template and settings; {slot} placeholders to fill from its slots; a tool step names a run_media_tool tool), counted as a use. Run the steps yourself with generate_image / run_media_tool, filling the slots with what the creator gave.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
};

/** Set by routes/workbench.ts: starts the review of a new public element (no route import from here). */
export const onElementCreated = { run: (_elementId: string) => {} };

export const WORKBENCH_LIBRARY_OPS = [LIST_ELEMENTS, CREATE_ELEMENT, LIST_SKILLS, USE_SKILL];

const ELEMENTS_PER_HOUR = 30;
const created = new Map<string, number[]>();
function takeCreate(userId: string): boolean {
  const now = Date.now();
  const recent = (created.get(userId) ?? []).filter((t) => now - t < 3600_000);
  if (recent.length >= ELEMENTS_PER_HOUR) { created.set(userId, recent); return false; }
  recent.push(now);
  created.set(userId, recent);
  return true;
}

async function hidden(userId: string): Promise<string[]> {
  const b = await listBlockedUsersForHiding(userId);
  return [...new Set([...b.hideActivityUserIds, ...b.hiddenByCreatorIds, ...b.hideWorldCreatorIds])];
}

export async function runListElements(userId: string, input: Record<string, unknown>): Promise<Result> {
  const kind = (WORKBENCH_ELEMENT_KINDS as readonly string[]).includes(String(input.kind)) ? input.kind as typeof WORKBENCH_ELEMENT_KINDS[number] : null;
  const q = typeof input.q === "string" ? input.q.trim().slice(0, 40).replace(/[%_\\]/g, "\\$&") : "";
  const filters = [...(kind ? [eq(workbenchElements.kind, kind)] : []),
    ...(q ? [or(ilike(workbenchElements.name, `%${q}%`), ilike(workbenchElements.description, `%${q}%`))!] : [])];
  const scope = input.scope === "public" || input.scope === "used" ? input.scope : "mine";
  if (scope === "mine") {
    const rows = await db.select().from(workbenchElements).where(and(eq(workbenchElements.userId, userId), ...filters))
      .orderBy(desc(workbenchElements.updatedAt)).limit(100);
    return { ok: true, result: { elements: rows.map((r) => {
      const e = elementToJson(r, userId);
      return { ...e, mention: `@${e.name}`, assets: e.assetIds.map((id) => `@asset:${id}`) };
    }) } };
  }
  const [hide, level] = await Promise.all([hidden(userId), viewerContentLevel(userId, undefined)]);
  const used = sql<boolean>`EXISTS (SELECT 1 FROM workbench_element_uses u WHERE u.element_id = ${workbenchElements.id} AND u.user_id = ${userId})`;
  const rows = await db.select({ element: workbenchElements, name: user.name, username: user.username, image: user.image, used }).from(workbenchElements)
    .innerJoin(user, eq(user.id, workbenchElements.userId))
    .where(and(sharedElementSql(level), eq(user.isBanned, false), ...(kind ? [eq(workbenchElements.kind, kind)] : []),
      ...(q ? [sql`(${workbenchElements.approvedSnapshot}->>'name' ILIKE ${"%" + q + "%"} OR ${workbenchElements.approvedSnapshot}->>'description' ILIKE ${"%" + q + "%"})`] : []),
      ...(hide.length ? [notInArray(workbenchElements.userId, hide)] : []), ...(scope === "used" ? [used] : [])))
    .orderBy(desc(workbenchElements.useCount)).limit(50);
  return { ok: true, result: { elements: rows.map((r) => ({ ...publicElementToJson(r.element, r, !!r.used, userId),
    note: r.used || r.element.userId === userId ? undefined : "The creator takes it in from the workbench before @name reaches it." })) } };
}

export async function runCreateElement(userId: string, input: Record<string, unknown>): Promise<Result> {
  if (await generationRestricted(userId)) return { ok: false, error: "This account is restricted." };
  const assets = (Array.isArray(input.assets) ? input.assets : []).map(assetIdOf);
  if (assets.some((a) => !a)) return { ok: false, error: "assets must be @asset refs of the creator's images." };
  const cover = input.cover === undefined ? undefined : assetIdOf(input.cover);
  if (input.cover !== undefined && !cover) return { ok: false, error: "cover must be an @asset ref." };
  const parsed = createElementSchema.safeParse({ kind: input.kind, name: input.name, description: input.description ?? "",
    ...(assets.length ? { assetIds: assets } : {}), ...(cover ? { coverAssetId: cover } : {}),
    ...(input.visibility ? { visibility: input.visibility } : {}) });
  if (!parsed.success) return { ok: false, error: `${parsed.error.issues[0]?.path.join(".")}: ${parsed.error.issues[0]?.message}` };
  const foreign = await foreignImageAssets(userId, [...(parsed.data.assetIds ?? []), ...(parsed.data.coverAssetId ? [parsed.data.coverAssetId] : [])]);
  if (foreign.length) return { ok: false, error: `Not the creator's images: ${foreign.map((id) => `@asset:${id}`).join(", ")}` };
  const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(workbenchElements).where(eq(workbenchElements.userId, userId));
  if ((count?.n ?? 0) >= WORKBENCH_ELEMENTS_PER_USER_MAX) return { ok: false, error: "The creator's element library is full." };
  if (!takeCreate(userId)) return { ok: false, error: `Element limit: ${ELEMENTS_PER_HOUR} an hour.` };
  try {
    const [row] = await db.insert(workbenchElements).values({
      userId, kind: parsed.data.kind, name: parsed.data.name, description: parsed.data.description,
      coverAssetId: parsed.data.coverAssetId ?? parsed.data.assetIds?.[0] ?? null, assetIds: parsed.data.assetIds ?? [],
      visibility: parsed.data.visibility ?? "private",
      // Public: reviewed before anyone else sees it (the workbench route starts the review).
      status: parsed.data.visibility === "public" ? "pending" : "approved",
    }).returning();
    if (row!.status === "pending") onElementCreated.run(row!.id);
    return { ok: true, result: { element: elementToJson(row!, userId), mention: `@${row!.name}` } };
  } catch (error) {
    const code = (error as { code?: string; cause?: { code?: string } })?.code ?? (error as { cause?: { code?: string } })?.cause?.code;
    if (code === "23505") return { ok: false, error: `The creator already has an element named ${parsed.data.name}.` };
    throw error;
  }
}

export async function runListSkills(userId: string, input: Record<string, unknown>): Promise<Result> {
  const mode = (WORKBENCH_SKILL_MODES as readonly string[]).includes(String(input.mode)) ? input.mode as typeof WORKBENCH_SKILL_MODES[number] : null;
  const mine = input.mine === true;
  const [hide, liveOpen] = await Promise.all([mine ? [] : hidden(userId), liveCharactersForUser(userId).catch(() => false)]);
  const hot = sql`(${workbenchSkills.useCount} + 3 * ${workbenchSkills.likeCount} + 1) / power(extract(epoch from (now() - ${workbenchSkills.createdAt})) / 3600 + 2, 1.5)`;
  const rows = await db.select({ skill: workbenchSkills, author: user.name }).from(workbenchSkills)
    .innerJoin(user, eq(user.id, workbenchSkills.userId))
    .where(and(...(mode ? [eq(workbenchSkills.mode, mode)] : []), ...(mine ? [eq(workbenchSkills.userId, userId)]
      : [eq(workbenchSkills.visibility, "public"), eq(workbenchSkills.status, "approved"), eq(user.isBanned, false),
        // Live characters closed to this creator (LIVE_CHARACTERS): others' live skills are not listed, as in the workbench.
        ...(liveOpen ? [] : [notLiveSkillSql()]),
        ...(hide.length ? [notInArray(workbenchSkills.userId, hide)] : [])])))
    .orderBy(input.sort === "new" || mine ? desc(workbenchSkills.createdAt) : desc(hot)).limit(40);
  return { ok: true, result: { skills: rows.map(({ skill: s, author }) => ({
    id: s.id, title: s.title, description: s.description, mode: s.mode, slots: s.slots, useCount: s.useCount, likeCount: s.likeCount,
    official: s.isOfficial, author: author ?? "",
  })) } };
}

export async function runUseSkill(userId: string, input: Record<string, unknown>): Promise<Result> {
  const id = typeof input.id === "string" ? input.id : "";
  const [row] = await db.select({ skill: workbenchSkills, isBanned: user.isBanned }).from(workbenchSkills)
    .innerJoin(user, eq(user.id, workbenchSkills.userId)).where(eq(workbenchSkills.id, id)).limit(1);
  const visible = row && (row.skill.userId === userId
    || (row.skill.visibility === "public" && row.skill.status === "approved" && !row.isBanned && !(await hidden(userId)).includes(row.skill.userId)
      && (!skillMakesLive(row.skill) || await liveCharactersForUser(userId).catch(() => false))));
  if (!visible) return { ok: false, error: "No such skill." };
  await db.update(workbenchSkills).set({ useCount: sql`${workbenchSkills.useCount} + 1` }).where(eq(workbenchSkills.id, id));
  return { ok: true, result: { id, title: row.skill.title, mode: row.skill.mode, slots: row.skill.slots, recipe: row.skill.recipe,
    note: "Fill each {slot} with what the creator gave ({previous} is the step before's output), then run the steps in order." } };
}
