// Recipes: what a Skill (做法) or a Work (作品) hands the workbench to make "the same". A recipe is settings
// only: a creator's files never travel in one (a file input is a {slot} the next person fills).

import { and, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  MEDIA_TOOL_IDS, WORKBENCH_SKILL_PROMPT_MAX, WORKBENCH_SKILL_SLOTS_MAX, WORKBENCH_SKILL_STEPS_MAX, WORKBENCH_SLOT_KINDS,
  WORKBENCH_STEP_MODES, mediaTool,
  type WorkbenchRecipe, type WorkbenchRecipeStep, type WorkbenchSkillMode, type WorkbenchSkillSlot,
} from "@yumina/shared";
import { workbenchSkills } from "../../db/schema.js";

const value = z.union([z.string().max(WORKBENCH_SKILL_PROMPT_MAX), z.number().finite(), z.boolean()]);
const record = z.record(z.string().min(1).max(40), value).refine((r) => Object.keys(r).length <= 30, "too many settings");

export const recipeStepSchema = z.object({
  mode: z.enum(WORKBENCH_STEP_MODES),
  templateId: z.string().min(1).max(60).optional(),
  model: z.string().min(1).max(120).optional(),
  toolId: z.enum(MEDIA_TOOL_IDS).optional(),
  prompt: z.string().max(WORKBENCH_SKILL_PROMPT_MAX).optional(),
  settings: record.optional(),
  inputs: record.optional(),
}).strict();

export const recipeSchema = z.object({ steps: z.array(recipeStepSchema).min(1).max(WORKBENCH_SKILL_STEPS_MAX) }).strict();

export const slotSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,23}$/),
  label: z.string().trim().min(1).max(40),
  kind: z.enum(WORKBENCH_SLOT_KINDS),
}).strict();
export const slotsSchema = z.array(slotSchema).max(WORKBENCH_SKILL_SLOTS_MAX);

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const PLACEHOLDER_RE = /\{([a-z][a-z0-9_]{0,23})\}/g;
/** "{previous}" in a chain: the step before's output. */
export const PREVIOUS = "previous";

/** A skill that makes a live character (its mode, or any step's). Where live characters are closed to a viewer
 *  (LIVE_CHARACTERS), such a skill is not listed, shown or handed out to them. */
export function skillMakesLive(skill: { mode: string; recipe: { steps?: { mode?: string }[] } | null | undefined }): boolean {
  return skill.mode === "live" || !!skill.recipe?.steps?.some((step) => step?.mode === "live");
}

/** SQL twin of skillMakesLive, for lists: the skill's mode is not live and no step's is. */
export const notLiveSkillSql = () => and(ne(workbenchSkills.mode, "live"),
  sql`NOT (${workbenchSkills.recipe}::text LIKE '%"mode": "live"%' OR ${workbenchSkills.recipe}::text LIKE '%"mode":"live"%')`)!;

export class RecipeError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

const strings = (step: WorkbenchRecipeStep) => [step.prompt ?? "", ...Object.values(step.settings ?? {}), ...Object.values(step.inputs ?? {})]
  .filter((v): v is string => typeof v === "string");

/**
 * The rules a recipe follows beyond its shape: one step unless it is a chain, the step's mode the skill's,
 * a tool step names a tool and only that tool's inputs (files only as placeholders), every placeholder a
 * declared slot, and no file anywhere (an asset id, @asset ref or /cdn/ link would hand out someone's file).
 */
export function checkRecipe(mode: WorkbenchSkillMode, recipe: WorkbenchRecipe, slots: WorkbenchSkillSlot[]): void {
  const fail = (code: string, why: string): never => { throw new RecipeError(code, why); };
  const keys = new Set(slots.map((s) => s.key));
  if (keys.size !== slots.length) fail("SLOT_DUPLICATE", "slot keys must be unique");
  if (keys.has(PREVIOUS)) fail("SLOT_RESERVED", `"${PREVIOUS}" is reserved`);
  if (mode === "chain" ? recipe.steps.length < 2 : recipe.steps.length !== 1) fail("RECIPE_STEPS", mode === "chain" ? "a chain has 2 or more steps" : "one step for this mode");
  recipe.steps.forEach((step, index) => {
    if (mode !== "chain" && step.mode !== mode) fail("RECIPE_MODE", `step ${index + 1} must be ${mode}`);
    if (step.mode === "tool" || step.mode === "audio") {
      const tool = step.toolId ? mediaTool(step.toolId) : undefined;
      if (!tool) fail("RECIPE_TOOL", `step ${index + 1} needs a toolId`);
      if (step.mode === "audio" && tool!.group !== "audio") fail("RECIPE_TOOL", `step ${index + 1}: ${tool!.id} is not an audio tool`);
      for (const [key, v] of Object.entries(step.inputs ?? {})) {
        const input = tool!.inputs.find((i) => i.key === key);
        if (!input) fail("RECIPE_INPUT", `${tool!.id} has no input "${key}"`);
        const isFile = ["image", "video", "audio", "mask"].includes(input!.kind);
        if (isFile && !(typeof v === "string" && /^\{[a-z][a-z0-9_]{0,23}\}$/.test(v))) fail("RECIPE_INPUT", `${key} must be a {slot}`);
      }
    } else if (step.toolId) fail("RECIPE_TOOL", `step ${index + 1} (${step.mode}) takes no toolId`);
    for (const s of strings(step)) {
      if (UUID_RE.test(s) || /@asset:|\/cdn\//i.test(s)) fail("RECIPE_HAS_FILE", "a recipe cannot carry a file; use a slot");
      for (const m of s.matchAll(PLACEHOLDER_RE)) {
        const key = m[1]!;
        if (key === PREVIOUS ? index === 0 : !keys.has(key)) fail("SLOT_UNKNOWN", `{${key}} is not a slot`);
      }
    }
  });
}

type Params = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
const plain = (o: unknown, keys: string[]) => {
  const out: Record<string, string | number | boolean> = {};
  if (!o || typeof o !== "object") return out;
  for (const k of keys) {
    const v = (o as Params)[k];
    if ((typeof v === "string" && v && !UUID_RE.test(v)) || (typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean") out[k] = v;
  }
  return out;
};

/**
 * A finished job as a recipe: what made it, minus the author's files. Mentioned elements become element
 * slots ({e1}…), a file the job read becomes a slot of its kind, so the result is reusable as is.
 */
export function recipeFromJob(job: { kind: string; templateId: string; params: Params | null }): { mode: WorkbenchSkillMode; recipe: WorkbenchRecipe; slots: WorkbenchSkillSlot[] } {
  // Made with someone's sealed 做法: how it was made is not this person's to hand on.
  if (typeof job.params?.sealedSkillId === "string") throw new RecipeError("RECIPE_SEALED", "made with a recipe its author keeps closed");
  const p = job.params ?? {};
  const slots: WorkbenchSkillSlot[] = [];
  // The prompt as the creator typed it, @names turned into element slots.
  const mentions = p.mentions as { prompt?: string; elements?: { name: string }[] } | undefined;
  let prompt = str(mentions?.prompt) ?? str(p.prompt) ?? "";
  (mentions?.elements ?? []).forEach((e, i) => {
    const key = `e${i + 1}`;
    const escaped = e.name.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
    const replaced = prompt.replace(new RegExp(`@${escaped}(?![\\p{L}\\p{N}_\\-·])`, "giu"), `{${key}}`);
    if (replaced !== prompt) { prompt = replaced; slots.push({ key, label: e.name.slice(0, 40), kind: "element" }); }
  });
  prompt = prompt.slice(0, WORKBENCH_SKILL_PROMPT_MAX);

  if (job.kind === "tool") {
    const tool = mediaTool(job.templateId);
    if (!tool) throw new RecipeError("RECIPE_TOOL", "unknown tool");
    const inputs: Record<string, string | number | boolean> = {};
    const given = (p.inputs ?? {}) as Params;
    for (const input of tool.inputs) {
      if (["image", "video", "audio", "mask"].includes(input.kind)) {
        if (input.kind === "mask") continue; // a mask is painted over each new picture
        if (given[input.key] === undefined) continue;
        slots.push({ key: input.key, label: input.key, kind: input.kind as "image" | "video" | "audio" });
        inputs[input.key] = `{${input.key}}`;
      } else if (input.key !== "prompt" && given[input.key] !== undefined && typeof given[input.key] !== "object") {
        inputs[input.key] = given[input.key] as string | number | boolean;
      }
    }
    const mode = tool.group === "audio" ? "audio" : "tool";
    return { mode, slots, recipe: { steps: [{ mode, toolId: tool.id, ...(given.prompt !== undefined ? { prompt } : {}), inputs }] } };
  }
  if (job.kind === "video") {
    const video = (p.video ?? {}) as Params;
    return { mode: "video", slots, recipe: { steps: [{ mode: "video", templateId: job.templateId, model: str(p.model) ?? str(video.model), prompt,
      settings: plain(video, ["aspectRatio", "resolution", "durationSeconds", "sound", "fast", "style", "steps", "cfg"]) }] } };
  }
  if (job.kind === "rig") {
    slots.push({ key: "picture", label: "picture", kind: "image" });
    return { mode: "live", slots, recipe: { steps: [{ mode: "live", inputs: { picture: "{picture}" } }] } };
  }
  // A picture: the smart lane's cloud settings, or our own models' recipe (never a private LoRA: settings only).
  const cloud = (p.cloud ?? null) as Params | null;
  const advanced = (p.advanced ?? null) as Params | null;
  return { mode: "image", slots, recipe: { steps: [{ mode: "image", templateId: job.templateId,
    ...(str(cloud?.model) ?? str(p.model) ? { model: str(cloud?.model) ?? str(p.model) } : {}), prompt,
    settings: { ...plain(cloud, ["aspectRatio", "resolution"]), ...plain(p, ["style", "quality", "aspectId"]),
      ...plain(advanced, ["width", "height", "steps", "cfg", "sampler", "negativePrompt"]) } }] } };
}
