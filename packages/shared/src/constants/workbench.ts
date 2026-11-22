/**
 * The workbench's shared library (after Seko): Elements (主体库) a creator @mentions in any prompt, Skills (做法)
 * that are reusable recipes with slots, and Works (作品): published results with the recipe that made them,
 * so anyone can "做同款". Server: packages/server/src/routes/workbench.ts.
 */
import type { ImagePostItem } from "./image-posts.js";

// ── Elements ────────────────────────────────────────────────────────

export const WORKBENCH_ELEMENT_KINDS = ["character", "scene", "prop", "voice", "style"] as const;
export type WorkbenchElementKind = (typeof WORKBENCH_ELEMENT_KINDS)[number];
export const WORKBENCH_ELEMENT_NAME_MAX = 40;
export const WORKBENCH_ELEMENT_DESCRIPTION_MAX = 2000;
export const WORKBENCH_ELEMENT_ASSETS_MAX = 6;
/** How many elements one prompt may pull in. */
export const WORKBENCH_MENTIONS_MAX = 6;
/** Elements one creator may keep. */
export const WORKBENCH_ELEMENTS_PER_USER_MAX = 500;

/** A name a creator can @: letters (any script), digits, _ - and ·, no spaces. */
export const WORKBENCH_ELEMENT_NAME_RE = /^[\p{L}\p{N}_\-·]{1,40}$/u;
/** `@name` in a prompt; a name runs to the first character a name cannot have. */
export const WORKBENCH_MENTION_RE = /@([\p{L}\p{N}_\-·]{1,40})/gu;

/** The languages a voice can be heard in on the 广场, and the one its maker recommends (what it was made from). */
export const WORKBENCH_VOICE_LANGS = ["zh", "ja", "en", "es"] as const;
export type WorkbenchVoiceLang = (typeof WORKBENCH_VOICE_LANGS)[number];
export type WorkbenchVoice = { provider: "elevenlabs" | "fish"; voiceId: string; lang?: WorkbenchVoiceLang };

/** What was made for a character and kept as hers: pictures (asset ids) by section, and `clips` (videos of her
 *  speaking, 让她说一段话). Her voice is `voice`, her live characters are those made from her pictures (or linked
 *  by `rigId`). */
export const WORKBENCH_ARCHIVE_SECTIONS = ["outfits", "expressions", "clips"] as const;
/** The sections that hold pictures (the rest hold videos). */
export const WORKBENCH_PICTURE_SECTIONS = ["outfits", "expressions"] as const;
export type WorkbenchArchiveSection = (typeof WORKBENCH_ARCHIVE_SECTIONS)[number];
export type WorkbenchElementArchive = Partial<Record<WorkbenchArchiveSection, string[]>>;
/** Pictures one section keeps; the oldest drop out past it. */
export const WORKBENCH_ARCHIVE_MAX = 60;
export type WorkbenchVisibility = "private" | "public";

/** An element as its owner sees it. */
export interface WorkbenchElement {
  id: string;
  kind: WorkbenchElementKind;
  name: string;
  description: string;
  coverAssetId: string | null;
  /** /cdn/<coverAssetId>, or null */
  coverUrl: string | null;
  /** Reference pictures (the owner's own assets). Never shown for someone else's element. */
  assetIds: string[];
  voice: WorkbenchVoice | null;
  rigId: string | null;
  /** Her outfits and expressions (the owner's only; empty for anyone else). */
  archive: WorkbenchElementArchive;
  visibility: WorkbenchVisibility;
  useCount: number;
  isMine: boolean;
  /** A public element is reviewed before others see it; others keep seeing the last approved content while an
   *  edit waits. "approved" for a private element. */
  status: "pending" | "approved" | "rejected";
  rejectReason: string | null;
  isSensitive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A public element as anyone else sees it: name, description, cover, never its private assets. */
export interface WorkbenchPublicElement {
  id: string;
  kind: WorkbenchElementKind;
  name: string;
  description: string;
  coverUrl: string | null;
  useCount: number;
  isMine: boolean;
  /** I have used it, so @name reaches it from my prompts. */
  used: boolean;
  author: { id: string; name: string; username: string | null; image: string | null };
  /** A voice's Fish voice id, to listen to it and use it (声音广场); null for every other kind. */
  voiceId?: string | null;
  /** The language its maker recommends for it; null when they did not say. */
  voiceLang?: WorkbenchVoiceLang | null;
  /** A voice's name and description machine-translated into the reader's language, when asked for (?ui=). */
  translatedName?: string | null;
  translatedDescription?: string | null;
}

/** What @mentions did to a prompt, stored on the job as params.mentions. */
export interface WorkbenchMentions {
  /** the prompt as typed */
  prompt: string;
  /** what the model was sent */
  expandedPrompt: string;
  elements: { id: string; name: string; kind: WorkbenchElementKind }[];
  /** reference pictures attached for the model (the creator's own) */
  referenceAssetIds: string[];
}

// ── Skills ──────────────────────────────────────────────────────────

export const WORKBENCH_SKILL_MODES = ["image", "video", "audio", "live", "tool", "chain"] as const;
export type WorkbenchSkillMode = (typeof WORKBENCH_SKILL_MODES)[number];
export const WORKBENCH_STEP_MODES = ["image", "video", "audio", "live", "tool"] as const;
export type WorkbenchStepMode = (typeof WORKBENCH_STEP_MODES)[number];
export const WORKBENCH_SKILL_TITLE_MAX = 40;
export const WORKBENCH_SKILL_DESCRIPTION_MAX = 120;
export const WORKBENCH_SKILL_SLOTS_MAX = 8;
export const WORKBENCH_SKILL_STEPS_MAX = 6;
export const WORKBENCH_SKILL_PROMPT_MAX = 4000;
export const WORKBENCH_SKILL_PENDING_MAX = 10;
/** text: typed words; image/video/audio: one of the user's files; element: an @element (its name goes into the prompt). */
export const WORKBENCH_SLOT_KINDS = ["text", "image", "video", "audio", "element"] as const;
export type WorkbenchSlotKind = (typeof WORKBENCH_SLOT_KINDS)[number];

export interface WorkbenchSkillSlot { key: string; label: string; kind: WorkbenchSlotKind }

/** One step of a recipe. Values are plain settings: a `{slot}` placeholder (in `prompt` or any string value)
 *  is filled from the skill's slots when it is used; asset ids never appear in a recipe. */
export interface WorkbenchRecipeStep {
  mode: WorkbenchStepMode;
  /** image/video: the generation template (e.g. "image-smart", "video") */
  templateId?: string;
  /** image/video: the model id */
  model?: string;
  /** tool / audio: a MEDIA_TOOLS id */
  toolId?: string;
  prompt?: string;
  /** model settings (aspectRatio, resolution, durationSeconds, style…) */
  settings?: Record<string, string | number | boolean>;
  /** tool inputs other than files; a file input names a slot ("{photo}") or "{previous}" (the step before's output) */
  inputs?: Record<string, string | number | boolean>;
}

/** A skill's recipe: one step for a single mode, 1-6 for a chain (image → remove-bg → live character). */
export interface WorkbenchRecipe { steps: WorkbenchRecipeStep[] }

export type WorkbenchSkillStatus = "pending" | "approved" | "rejected";

export interface WorkbenchSkill {
  id: string;
  title: string;
  description: string;
  coverAssetId: string | null;
  coverUrl: string | null;
  mode: WorkbenchSkillMode;
  recipe: WorkbenchRecipe;
  slots: WorkbenchSkillSlot[];
  /** The author keeps how it is made to themselves: `recipe` then only says what kind of step it has. */
  recipeHidden?: boolean;
  /** What it makes (a sealed recipe's step no longer says). */
  makes?: "image" | "video" | "audio";
  /** I kept it (收藏). */
  saved?: boolean;
  visibility: WorkbenchVisibility;
  status: WorkbenchSkillStatus;
  rejectReason: string | null;
  useCount: number;
  likeCount: number;
  liked: boolean;
  isMine: boolean;
  isOfficial: boolean;
  author: { id: string; name: string; username: string | null; image: string | null };
  createdAt: string;
}

// ── Works ───────────────────────────────────────────────────────────

export const WORKBENCH_WORK_KINDS = ["image", "video", "audio", "live"] as const;
export type WorkbenchWorkKind = (typeof WORKBENCH_WORK_KINDS)[number];

/** A work: an image post widened to any medium. `imageUrl` is the picture to show (the cover for a video,
 *  a sound or a live character); `mediaUrl` is the file itself. */
export interface WorkbenchWork extends ImagePostItem {
  /** The title machine-translated into the reader's language, when asked for (?ui=) and it is in another. */
  translatedTitle?: string | null;
  /** What its maker says about it, and the words to find it by (分享作品). */
  description?: string;
  tags?: string[];
  /** Its maker keeps the prompt: nothing to show, nothing to 做同款. */
  promptHidden?: boolean;
  /** When it went up (approved, else made). */
  at?: string | null;
  mediaKind: WorkbenchWorkKind;
  mediaUrl: string;
  rigId: string | null;
  /** The recipe "做同款" loads; null when the work can only be looked at. */
  workRecipe: WorkbenchRecipe | null;
}

// ── Home ────────────────────────────────────────────────────────────

/** The workbench's "Start here" cards, in order. Their pictures are the official account's library images named
 *  workbench-start-<id>.jpg (GET /api/workbench/start-cards), so each environment carries its own. */
export const WORKBENCH_START_CARD_KEYS = ["animate", "outfit", "bgm", "voice", "expressions", "canvas"] as const;
export type WorkbenchStartCardKey = (typeof WORKBENCH_START_CARD_KEYS)[number];
/** The official account (its username) whose library holds the start-card pictures. */
export const WORKBENCH_OFFICIAL_USERNAME = "yumina";
export const workbenchStartCardFilename = (key: WorkbenchStartCardKey) => `workbench-start-${key}.jpg`;
/** Each tool's before/after picture in the tool menu: the official account's library image named
 *  workbench-tool-<id>.jpg (GET /api/workbench/tool-covers), so each environment carries its own. */
export const workbenchToolCoverFilename = (toolId: string) => `workbench-tool-${toolId}.jpg`;
