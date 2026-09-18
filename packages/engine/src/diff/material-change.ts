import type { WorldDefinition } from "../types/index.js";
import { diffWorldSchemas } from "./world-diff.js";

/**
 * The four "material" content surfaces that, when changed on an ALREADY-PUBLISHED
 * world, must be held back from the live card and re-reviewed before going live:
 *
 *  - `entries`   — lorebook entries (what the AI is fed)
 *  - `frontend`  — rootComponent custom-UI files (the playable TSX surface)
 *  - `ageRating` — content maturity claim
 *  - `cover`     — thumbnail / cover image
 *
 * Everything else (variables, behaviors/rules, audio, settings, name,
 * description, tags, announcement, visibility, permissions) is non-material and
 * goes live instantly. This list is the single source of truth — keep it in
 * sync with the creator-facing warning copy and the admin diff summary.
 */
export type MaterialChangeReason = "entries" | "frontend" | "ageRating" | "cover";

export interface MaterialSnapshot {
  /**
   * Full WorldDefinition. Callers should pass schemas that have already been
   * run through `migrateWorldDefinition` so that version-upgrade restructuring
   * is not mistaken for a creator edit (a stored v18 schema vs an editor-loaded
   * v20 schema would otherwise diff on migration artifacts alone).
   */
  schema: WorldDefinition;
  /** Raw thumbnail value (S3 key or URL) — NOT the CDN-resolved form. */
  thumbnailUrl: string | null | undefined;
  /** Stored age rating ("all" | "sensitive"; legacy "r18"/"r18g" tolerated). */
  ageRating: string | null | undefined;
}

export interface MaterialChangeResult {
  changed: boolean;
  reasons: MaterialChangeReason[];
}

/** Collapse the rating to its binary safety class. Missing → "all" (the DB default). */
function ratingClass(v: string | null | undefined): "all" | "sensitive" {
  return v === "all" || v == null || v === "" ? "all" : "sensitive";
}

/** Cover compare is whitespace-agnostic; null and "" both mean "no cover". */
function coverKey(v: string | null | undefined): string {
  return (v ?? "").trim();
}

/**
 * Decide whether `proposed` differs from `approved` on any of the four material
 * surfaces. Order-independent and field-scoped (reuses {@link diffWorldSchemas},
 * which compares entries by id on name/content/keywords/enabled and the
 * rootComponent by per-file content — ignoring positions and the self-updating
 * rootComponent.updatedAt timestamp, so neither produces false positives).
 */
export function detectMaterialChange(
  approved: MaterialSnapshot,
  proposed: MaterialSnapshot,
): MaterialChangeResult {
  const reasons: MaterialChangeReason[] = [];

  const diff = diffWorldSchemas(approved.schema, proposed.schema);
  if (diff.changes.some((c) => c.kind === "entry")) reasons.push("entries");
  if (diff.changes.some((c) => c.kind === "customUI")) reasons.push("frontend");

  if (ratingClass(approved.ageRating) !== ratingClass(proposed.ageRating)) {
    reasons.push("ageRating");
  }
  if (coverKey(approved.thumbnailUrl) !== coverKey(proposed.thumbnailUrl)) {
    reasons.push("cover");
  }

  return { changed: reasons.length > 0, reasons };
}
