// The AI's first look at anything public in the workbench library (skills, elements), the same rules as the
// gallery and as cards (lib/image-post-review.ts decideMediaReview): two vision models on the cover (a third
// when they split on minors), the author's words read for youth and risky terms. Adult content goes up marked
// sensitive where the item has that mark (elements); a 做法 has none, so a sensitive one waits for a person.
// Without a cover (a voice, say) the words alone are judged, as a card's unseen media is only noted.

import sharp from "sharp";
import { and, eq } from "drizzle-orm";
import type { ImagePostAiReview, MediaReviewReason } from "@yumina/shared";
import { db } from "../../db/index.js";
import { userAssets } from "../../db/schema.js";
import { decideMediaReview, reviewPicture, textMentionsYouth, textNeedsHuman, untrustedContext } from "../image-post-review.js";
import { getObjectBuffer } from "../s3.js";

/** Every string anywhere in a value (a recipe's prompts, settings, inputs, nested or not). */
export function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) allStrings(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) allStrings(v, out);
  return out;
}

export interface LibraryReviewDeps { review?: typeof reviewPicture; load?: (ownerId: string, assetId: string) => Promise<Buffer> }

async function coverJpeg(ownerId: string, assetId: string): Promise<Buffer> {
  const [asset] = await db.select({ url: userAssets.url }).from(userAssets)
    .where(and(eq(userAssets.id, assetId), eq(userAssets.userId, ownerId))).limit(1);
  if (!asset) throw new Error("cover not found");
  return sharp((await getObjectBuffer(asset.url, { maxBytes: 30 * 1024 * 1024 })).buffer).rotate()
    .resize(1024, 1024, { fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 88 }).toBuffer();
}

/**
 * Review a cover and the author's words. `title` is the name/title; `words` every other string they wrote.
 * `canMarkSensitive`: the item can go up marked sensitive (shown only to adults in r18 mode).
 */
export async function reviewLibraryItem(ownerId: string, coverAssetId: string | null, title: string, words: string[], deps: LibraryReviewDeps = {},
  opts: { canMarkSensitive?: boolean } = {}):
  Promise<{ review: ImagePostAiReview; approve: boolean; isSensitive: boolean }> {
  let review: ImagePostAiReview;
  const at = new Date().toISOString();
  if (!coverAssetId) {
    // Nothing to look at: the words decide (they still send youth words and risky ones to the rules below).
    review = { verdict: "approve", sensitive: false, minorRisk: false, categories: [], reason: "", model: "words only", at };
  } else {
    try {
      const jpeg = await (deps.load ?? coverJpeg)(ownerId, coverAssetId);
      review = await (deps.review ?? reviewPicture)(jpeg, untrustedContext(title, words.join("\n").slice(0, 8000)), ownerId);
    } catch (error) {
      review = { verdict: "human", sensitive: false, minorRisk: false, categories: [], reason: "", model: null, at,
        error: error instanceof Error ? error.message.slice(0, 300) : String(error) };
    }
  }
  const wordsRisky = textNeedsHuman(title, ...words);
  if (wordsRisky) review = { ...review, categories: [...new Set([...review.categories, "keyword"])] };
  const decided = decideMediaReview(review, { wordsRisky, wordsYouth: textMentionsYouth(title, ...words) });
  const reasons: MediaReviewReason[] = [...decided.reasons];
  if (decided.isSensitive && !opts.canMarkSensitive) reasons.push("sensitive_unmarkable");
  review = { ...review, reasons, ...(coverAssetId && review.model ? { looked: "cover" as const } : {}) };
  return { review, approve: reasons.length === 0, isSensitive: decided.isSensitive };
}
