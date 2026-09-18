import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { communityEvents, contentTranslations, forums, threads } from "../db/schema.js";
import { resolveImageCdn } from "./cdn-url.js";
import { detectLang } from "./detect-lang.js";
import { translateContent } from "./translate.js";

export const EVENT_STATUSES = ["draft", "live", "closed"] as const;
export const EVENT_SUBMISSION_TYPES = ["world", "social_post"] as const;
export const EVENT_SUBMISSION_STATUSES = ["pending", "needs_changes", "finished"] as const;
export const EVENT_REWARD_TYPES = ["mushies", "plan", "combo"] as const;

export type EventStatus = (typeof EVENT_STATUSES)[number];
export type EventSubmissionType = (typeof EVENT_SUBMISSION_TYPES)[number];
export type EventSubmissionStatus = (typeof EVENT_SUBMISSION_STATUSES)[number];
export type EventRewardType = (typeof EVENT_REWARD_TYPES)[number];

const ANNOUNCEMENTS_FORUM_SLUG = "announcements";

export function resolveEventBannerUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.startsWith("/")) return value;
  return resolveImageCdn(value);
}

export const resolveEventPosterUrl = resolveEventBannerUrl;

/**
 * Poster localization for `social_post` campaigns.
 *
 * A social share event is a single platform-wide campaign, but its poster is a
 * baked image with the copy rendered into it, so it cannot be localized by the
 * app's i18n layer like the rest of the event body. Instead we upload one poster
 * per language next to the base key using a naming convention, and swap the key
 * at read time based on the viewer's language.
 *
 * Convention: base key `…-poster.png` → localized `…-poster-<lang>.png`.
 * All five variants (zh, zh-Hant, en, ja, es) must be uploaded for an event
 * before it goes live; any new social event needs the same set of files.
 */
export const POSTER_LANGS = ["zh", "zh-Hant", "en", "ja", "es"] as const;
export type PosterLang = (typeof POSTER_LANGS)[number];

/**
 * Public title for the platform-wide social share campaign.
 *
 * Keep this server-side copy in sync with `social.fixed.title` in the app
 * locale files. The API must return a title in the requested language even
 * though the rest of this campaign's fixed body is rendered from client i18n.
 * This also protects clients that predate the client-side title override.
 */
const SOCIAL_EVENT_TITLES: Record<PosterLang, string> = {
  zh: "分享你的 YUMINA 时刻",
  "zh-Hant": "分享你的 YUMINA 時刻",
  en: "Share Your YUMINA Moment",
  ja: "あなたの YUMINA の瞬間をシェア",
  es: "Comparte tu momento YUMINA",
};

export function localizeSocialEventTitle(lang: PosterLang): string {
  return SOCIAL_EVENT_TITLES[lang];
}

export function resolvePublicEventTitle(input: {
  submissionType: string;
  sourceTitle: string;
  translatedTitle?: string | null;
  lang: PosterLang;
}): string {
  return input.submissionType === "social_post"
    ? localizeSocialEventTitle(input.lang)
    : input.translatedTitle ?? input.sourceTitle;
}

export function normalizePosterLang(lang?: string | null): PosterLang {
  const raw = lang?.trim().toLowerCase() ?? "";
  if (raw.startsWith("zh")) {
    // zh-Hant / zh-TW / zh-HK → Traditional; everything else zh-* → Simplified.
    return /(hant|tw|hk|mo)/.test(raw) ? "zh-Hant" : "zh";
  }
  if (raw.startsWith("en")) return "en";
  if (raw.startsWith("ja")) return "ja";
  if (raw.startsWith("es")) return "es";
  return "zh";
}

export function localizeSocialPosterKey(
  key: string | null | undefined,
  posterLang: PosterLang,
): string | null {
  if (!key) return null;
  // Only rewrite convention-named S3 keys; leave external URLs / other keys as-is.
  if (!/-poster\.png$/i.test(key)) return key;
  return key.replace(/-poster\.png$/i, `-poster-${posterLang}.png`);
}

function buildAnnouncementThreadTitle(title: string): string {
  return `Event: ${title}`;
}

function buildAnnouncementThreadContent(
  eventId: string,
  introduction: string,
  bannerImageUrl?: string | null,
  rewardDescription?: string | null,
): string {
  const parts: string[] = [];
  const coverUrl = resolveEventBannerUrl(bannerImageUrl);
  if (coverUrl) {
    parts.push(`![Event cover](${coverUrl})`, "");
  }
  parts.push(introduction.trim());
  const rewards = rewardDescription?.trim();
  if (rewards) {
    parts.push("", "## Rewards", "", rewards);
  }
  parts.push("", `[Join Event](/app/community/events/${eventId})`);
  return parts.join("\n");
}

export async function syncEventAnnouncementThread(input: {
  eventId: string;
  title: string;
  introduction: string;
  rewardDescription?: string | null;
  bannerImageUrl?: string | null;
  adminUserId: string;
  announcementThreadId?: string | null;
}): Promise<string> {
  const [announcementForum] = await db
    .select({ id: forums.id })
    .from(forums)
    .where(eq(forums.slug, ANNOUNCEMENTS_FORUM_SLUG))
    .limit(1);

  if (!announcementForum) {
    throw new Error("ANNOUNCEMENTS_FORUM_NOT_FOUND");
  }

  const threadTitle = buildAnnouncementThreadTitle(input.title);
  const threadContent = buildAnnouncementThreadContent(
    input.eventId,
    input.introduction,
    input.bannerImageUrl,
    input.rewardDescription,
  );
  const lang = detectLang(`${threadTitle}\n${threadContent}`);

  if (input.announcementThreadId) {
    const [updated] = await db
      .update(threads)
      .set({
        forumId: announcementForum.id,
        title: threadTitle,
        content: threadContent,
        lang,
        updatedAt: new Date(),
      })
      .where(eq(threads.id, input.announcementThreadId))
      .returning();

    if (updated) {
      // No up-front delete: translateOne detects the changed source hash,
      // regenerates, and overwrites only on success. Deleting first meant a
      // failed regeneration left the announcement permanently untranslated,
      // since nothing retries.
      translateContent(updated.id, "thread", lang, threadContent, input.adminUserId, threadTitle).catch(() => {});
      return updated.id;
    }
  }

  const [created] = await db
    .insert(threads)
    .values({
      forumId: announcementForum.id,
      authorId: input.adminUserId,
      title: threadTitle,
      content: threadContent,
      lang,
      ageRating: "all",
      lastReplyAt: new Date(),
    })
    .returning();

  if (!created) {
    throw new Error("EVENT_ANNOUNCEMENT_CREATE_FAILED");
  }

  translateContent(created.id, "thread", lang, threadContent, input.adminUserId, threadTitle).catch(() => {});
  await db
    .update(communityEvents)
    .set({ announcementThreadId: created.id, updatedAt: new Date() })
    .where(eq(communityEvents.id, input.eventId));

  return created.id;
}

export async function removeEventAnnouncementThread(input: {
  eventId: string;
  announcementThreadId?: string | null;
}) {
  if (!input.announcementThreadId) {
    await db
      .update(communityEvents)
      .set({ announcementThreadId: null, updatedAt: new Date() })
      .where(eq(communityEvents.id, input.eventId));
    return;
  }

  await db
    .delete(contentTranslations)
    .where(
      and(
        eq(contentTranslations.sourceId, input.announcementThreadId),
        eq(contentTranslations.sourceType, "thread"),
      ),
    );

  await db.delete(threads).where(eq(threads.id, input.announcementThreadId));
  await db
    .update(communityEvents)
    .set({ announcementThreadId: null, updatedAt: new Date() })
    .where(eq(communityEvents.id, input.eventId));
}
