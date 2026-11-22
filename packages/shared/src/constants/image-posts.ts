// Image gallery ("生图广场"): players publish one of their own generated
// pictures with the recipe that made it; others can reuse the recipe.

export const IMAGE_POST_TITLE_MAX = 80;
/** Pending posts one player may have waiting for review at once. */
export const IMAGE_POST_PENDING_MAX = 20;
export const IMAGE_POST_STATUSES = ["pending", "approved", "rejected"] as const;
export type ImagePostStatus = (typeof IMAGE_POST_STATUSES)[number];
export const IMAGE_POST_SORTS = ["new", "top"] as const;
export type ImagePostSort = (typeof IMAGE_POST_SORTS)[number];
/** Where the picture came from: the image page, or a story illustration in chat. */
export const IMAGE_POST_SOURCES = ["generation", "story"] as const;
export type ImagePostSource = (typeof IMAGE_POST_SOURCES)[number];

/** Why a player reports a post. */
export const IMAGE_POST_REPORT_REASONS = ["minor", "sexual_unmarked", "real_person", "violence", "hate", "spam", "other"] as const;
export type ImagePostReportReason = (typeof IMAGE_POST_REPORT_REASONS)[number];
/** Distinct reports that pull an approved post back into review. */
export const IMAGE_POST_REPORT_HIDE_AT = 3;

/** One model's answer in a media review (a third one only when two split on minors). */
export interface ImagePostAiAnswer {
  model: string;
  verdict?: "approve" | "human";
  sensitive?: boolean;
  minorRisk?: boolean;
  categories?: string[];
  reason?: string;
  error?: string;
  tiebreak?: boolean;
  /** Asked in place of a model that refused or failed (as cards use grok-4.7). */
  standIn?: boolean;
}

/** Why a media review waits for a person (the card review's rules, per media). */
export type MediaReviewReason = "ai_failed" | "minor_risk" | "real_person" | "harm" | "unseen" | "reported" | "paused" | "sensitive_unmarkable" | "edited_sensitive" | "unclear";

/** The AI's first look at a post, a 做法 or an element. Same rules as cards:
 *  adult content goes up marked sensitive (only adults in r18 mode see it);
 *  a person looks only at possible minors, real people in sexual content,
 *  hate or self-harm, what the AI couldn't see or answer, and reports. */
export interface ImagePostAiReview {
  verdict: "approve" | "human";
  sensitive: boolean;
  minorRisk: boolean;
  categories: string[];
  reason: string;
  model: string | null;
  at: string;
  /** Set when the AI couldn't answer; the post then waits for a person. */
  error?: string;
  /** Each model's own answer (from 2026-11-18). */
  answers?: ImagePostAiAnswer[];
  /** Why it waits for a person; empty or absent when the AI cleared it. */
  reasons?: MediaReviewReason[];
  /** What the AI looked at: the picture, a video's frames, or a cover. */
  looked?: "picture" | "frames" | "cover";
}

/** The card a story illustration came from, when that card is public. */
export interface ImagePostWorld {
  id: string;
  name: string;
  thumbnailUrl: string | null;
}

/** A model named in a recipe, kept only when anyone can use it (a platform
 *  model or a public community model). */
export interface ImagePostRecipeModel {
  id: string;
  name: string;
  kind: "lora" | "checkpoint";
  weight?: number;
}

/** The settings snapshot stored with a post. Never carries a reference
 *  image, a folder, or a model only its owner can use. */
export interface ImagePostRecipe {
  templateId: string;
  prompt: string;
  style: string | null;
  quality: string | null;
  aspectId: string | null;
  seed: number | null;
  /** image-smart (cloud) settings: model, aspect ratio, resolution. */
  cloud: { model?: string; aspectRatio?: string; resolution?: string } | null;
  advanced: {
    width?: number;
    height?: number;
    steps?: number;
    cfg?: number;
    sampler?: string;
    negativePrompt?: string;
    loras: { modelId: string; weight: number }[];
    checkpointModelId: string | null;
  } | null;
  models: ImagePostRecipeModel[];
  /** Private models the author used that the recipe had to leave out. */
  omittedModels: number;
}

export interface ImagePostAuthor {
  id: string;
  name: string;
  username: string | null;
  image: string | null;
}

export interface ImagePostItem {
  id: string;
  source: ImagePostSource;
  /** The image page's picture; null for a story illustration. */
  assetId: string | null;
  /** Same-origin path of the picture (/cdn/<asset> or /cdn/key/<key>). */
  imageUrl: string;
  title: string;
  /** A story illustration drawn before recipes were saved has an empty prompt:
   *  it can be looked at and played, not remade. */
  recipe: ImagePostRecipe;
  /** The card a story illustration came from, when it is public. */
  world: ImagePostWorld | null;
  width: number | null;
  height: number | null;
  status: ImagePostStatus;
  isSensitive: boolean;
  rejectReason: string | null;
  likeCount: number;
  liked: boolean;
  isMine: boolean;
  author: ImagePostAuthor;
  createdAt: string;
  approvedAt: string | null;
  /** Admin views only. */
  aiReview?: ImagePostAiReview | null;
  /** Admin views only: open reports. */
  reportCount?: number;
}
