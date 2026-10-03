import { z } from "zod";
import { MAX_WORLD_TAGS } from "../types/world.js";
import {
  MAX_WORLD_NAME,
  MAX_WORLD_DESCRIPTION,
  MAX_WORLD_ANNOUNCEMENT,
  MAX_WORLD_APPROX_TIME,
  MAX_GALLERY_IMAGES,
  MAX_COMMUNITY_TAG_NAME,
} from "../constants/limits.js";

export const createWorldSchema = z.object({
  name: z.string().min(1).max(MAX_WORLD_NAME),
  description: z.string().max(MAX_WORLD_DESCRIPTION).optional().default(""),
  schema: z.record(z.unknown()).optional().default({}),
  tags: z.array(z.string().max(MAX_COMMUNITY_TAG_NAME)).max(MAX_WORLD_TAGS).optional(),
  approxTime: z.string().max(MAX_WORLD_APPROX_TIME).nullable().optional(),
  language: z.string().max(10).nullable().optional(),
  languageGroupId: z.string().uuid().nullable().optional(),
  variantLabel: z.string().max(100).nullable().optional(),
});

export const updateWorldSchema = z.object({
  name: z.string().min(1).max(MAX_WORLD_NAME).optional(),
  description: z.string().max(MAX_WORLD_DESCRIPTION).optional(),
  schema: z.record(z.unknown()).optional(),
  thumbnailUrl: z.string().url().nullable().optional(),
  // isPublished + status removed (2026-06-01): publish/unpublish state is owned
  // SOLELY by POST /api/worlds/:id/status (the review queue) and admin moderation.
  // Accepting them on the author metadata PATCH let a forged request self-publish
  // (and fan the published state out to all variant siblings) past review.
  isNsfw: z.boolean().optional(),
  allowEdit: z.boolean().optional(),
  allowCustomApi: z.boolean().optional(),
  allowReviews: z.boolean().optional(),
  allowSessionSharing: z.boolean().optional(),
  allowCommunityCitations: z.boolean().optional(),
  blurCover: z.boolean().nullable().optional(),
  ageRating: z
    .enum(["all", "sensitive", "r18", "r18g"])
    .transform((v) => (v === "all" ? "all" : "sensitive"))
    .optional(),
  targetAudience: z.enum(["male", "female", "all"]).optional(),
  visibility: z.enum(["public", "followers"]).optional(),
  tags: z.array(z.string().max(MAX_COMMUNITY_TAG_NAME)).max(MAX_WORLD_TAGS).optional(),
  galleryImages: z.array(z.string()).max(MAX_GALLERY_IMAGES).optional(),
  announcement: z.string().max(MAX_WORLD_ANNOUNCEMENT).nullable().optional(),
  approxTime: z.string().max(MAX_WORLD_APPROX_TIME).nullable().optional(),
  language: z.string().max(10).nullable().optional(),
  languageGroupId: z.string().uuid().nullable().optional(),
  variantLabel: z.string().max(100).nullable().optional(),
  // multilanguageOverview (Hub Translation) retired 2026-06-01 — superseded by
  // per-language variants. No longer accepted on write; the server also strips
  // it defensively from stale clients.
});

// Admin-only world state update. Unlike updateWorldSchema (author-facing, and
// owner-gated on the route), this is applied by admins to ANY world regardless
// of ownership, and can set `status` directly — including forcing publish /
// unpublish / rejected outside the normal review queue. Scope is intentionally
// the moderation/metadata surface only: it never touches name/description/schema.
export const adminUpdateWorldSchema = z.object({
  tags: z.array(z.string().max(MAX_COMMUNITY_TAG_NAME)).max(MAX_WORLD_TAGS).optional(),
  // isNsfw is intentionally NOT here — it is derived from ageRating on the
  // server (isNsfw = ageRating !== "all"), mirroring the author publish flow.
  ageRating: z
    .enum(["all", "sensitive", "r18", "r18g"])
    .transform((v) => (v === "all" ? "all" : "sensitive"))
    .optional(),
  targetAudience: z.enum(["male", "female", "all"]).optional(),
  visibility: z.enum(["public", "followers"]).optional(),
  status: z.enum(["draft", "published", "unpublished", "rejected"]).optional(),
  allowEdit: z.boolean().optional(),
  allowCustomApi: z.boolean().optional(),
  allowReviews: z.boolean().optional(),
  allowSessionSharing: z.boolean().optional(),
  allowCommunityCitations: z.boolean().optional(),
  blurCover: z.boolean().nullable().optional(),
});

export type CreateWorldSchema = z.infer<typeof createWorldSchema>;
export type UpdateWorldSchema = z.infer<typeof updateWorldSchema>;
export type AdminUpdateWorldSchema = z.infer<typeof adminUpdateWorldSchema>;

/** Admin composition only: image uploads and arbitrary source URLs are excluded. */
export const adminWorldArtworkCropSchema = z.object({
  x: z.number().finite().min(-45).max(45),
  y: z.number().finite().min(-45).max(45),
  zoom: z.number().finite().min(0.25).max(1),
  fit: z.literal("cover"),
}).strict();

export const adminWorldArtworkUpdateSchema = z.object({
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  coverCrop: adminWorldArtworkCropSchema.optional(),
  landscapeCoverCrop: adminWorldArtworkCropSchema.optional(),
  landscapeSource: z.literal("portrait").optional(),
}).strict().refine(value => !!(value.coverCrop || value.landscapeCoverCrop), {
  message: "Confirm at least one artwork crop",
}).refine(value => !value.landscapeSource || !!value.landscapeCoverCrop, {
  message: "Reusing portrait artwork requires a landscape crop",
});

export type AdminWorldArtworkUpdate = z.infer<typeof adminWorldArtworkUpdateSchema>;
export interface AdminWorldArtwork {
  thumbnailUrl: string | null;
  landscapeCoverUrl: string | null;
  // Existing cards may have legacy crop values; clients normalize for display.
  coverCrop: unknown | null;
  galleryCoverCrop: unknown | null;
  landscapeCoverCrop: unknown | null;
  revision: string;
}
