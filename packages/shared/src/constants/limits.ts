// ── Profile ──────────────────────────────────────────────
export const MAX_DISPLAY_NAME_LENGTH = 20;
export const MAX_USERNAME_LENGTH = 20;
export const MIN_USERNAME_LENGTH = 3;
export const USERNAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_-]{2,19}$/;
export const MAX_BIO_LENGTH = 1000;
export const MAX_LOCATION_LENGTH = 30;
export const MAX_WEBSITE_LENGTH = 200;

// ── World / Bundle ───────────────────────────────────────
export const MAX_WORLD_NAME = 50;
export const MAX_WORLD_DESCRIPTION = 10_000;
export const MAX_WORLD_EXTENDED_DESCRIPTION = 10_000;
// 2000, not 500: a 500-char Chinese announcement grows past 500 once the
// translation pipeline renders it into es/en/ja, and those variants are written
// straight to the DB. At 500 the publish modal 400'd on 46 live cards whose
// announcement the author never typed. Every writer (client input, zod) reads
// this constant — never hard-code the number next to an input.
export const MAX_WORLD_ANNOUNCEMENT = 2000;
export const MAX_WORLD_APPROX_TIME = 100;
export const MAX_BUNDLE_NAME = 100;
export const MAX_BUNDLE_DESCRIPTION = 3000;
export const MAX_WORLD_UPDATE_TITLE = 200;
export const MAX_WORLD_UPDATE_CONTENT = 10_000;
export const MAX_VERSION_NAME = 100;
export const MAX_VERSION_NOTE = 500;
export const MAX_GALLERY_IMAGES = 20;

// ── Community ────────────────────────────────────────────
export const MAX_THREAD_TITLE = 200;
export const MAX_THREAD_CONTENT = 20_000;
export const MAX_POST_CONTENT = 10_000;
export const MAX_REVIEW_CONTENT = 5000;
export const MAX_REVIEW_REPLY = 2000;
export const MAX_PLAYTHROUGH_TITLE = 100;
export const MAX_PLAYTHROUGH_NOTE = 1000;
export const MAX_DM_CONTENT = 5000;
// How many messages a user may send to a new conversation partner before that
// partner has replied at least once (anti-spam reply gate).
export const DM_UNREPLIED_LIMIT = 3;
export const MAX_TIP_MESSAGE = 500;
export const MAX_REPORT_REASON = 1000;
export const MAX_REPORT_DETAILS = 5000;

// ── Profile wall ─────────────────────────────────────────
export const MAX_PROFILE_POST_LENGTH = 2000;
/** Most recent wall posts shown on a profile per page. */
export const PROFILE_POSTS_PAGE_SIZE = 10;

// ── Persona ──────────────────────────────────────────────
export const MAX_PERSONA_NAME = 50;
export const MAX_PERSONA_APPEARANCE = 2000;
export const MAX_PERSONA_PERSONALITY = 2000;
export const MAX_PERSONA_BACKSTORY = 5000;
/** Private, user-only note — never sent to the model. */
export const MAX_PERSONA_NOTE = 200;

// ── Misc ─────────────────────────────────────────────────
export const MAX_SESSION_NAME = 100;
export const MAX_CHECKPOINT_NAME = 100;
export const MAX_CHECKPOINT_SUMMARY = 2000;
export const MAX_POLL_QUESTION = 500;
export const MAX_POLL_OPTION = 200;
export const MAX_ACHIEVEMENT_NAME = 100;
export const MAX_ACHIEVEMENT_DESCRIPTION = 500;
export const MAX_FORUM_NAME = 100;
export const MAX_FORUM_DESCRIPTION = 500;
export const MAX_COMMUNITY_TAG_NAME = 50;
export const MAX_API_KEY_LABEL = 100;
export const MAX_FILENAME = 100;
export const MAX_FOLDER_NAME = 100;
export const MAX_INVITE_CODE_NOTE = 500;
export const MAX_STUDIO_CONVERSATION_TITLE = 200;
export const MAX_EVENT_TITLE = 200;
export const MAX_EVENT_INTRODUCTION = 10_000;
export const MAX_SOCIAL_HANDLE_LENGTH = 100;
export const MAX_SOCIAL_POST_URL_LENGTH = 2048;
export const MAX_SOCIAL_EVENT_PLATFORMS = 5;
export const MAX_SOCIAL_EVIDENCE_PER_SUBMISSION = 10;
export const EVENT_PROOF_MAX_BYTES = 20 * 1024 * 1024; // 20 MB
export const EVENT_PROOF_ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
] as const;

// ── Chat / Completions ───────────────────────────────────
export const MAX_USER_MESSAGE_CHARS = 15_000;
export const MAX_COMPLETION_MESSAGES = 50;
export const MAX_COMPLETION_TOTAL_CHARS = 50_000;

// ── Asset upload size limits ─────────────────────────────
export const MAX_ASSET_SIZE_IMAGE = 10 * 1024 * 1024; // 10 MB
export const MAX_ASSET_SIZE_AUDIO = 25 * 1024 * 1024; // 25 MB
export const MAX_ASSET_SIZE_FONT = 5 * 1024 * 1024;   // 5 MB
export const MAX_ASSET_SIZE_OTHER = 10 * 1024 * 1024;  // 10 MB

// ── Request body ─────────────────────────────────────────
export const MAX_REQUEST_BODY_BYTES = 5 * 1024 * 1024; // 5 MB

// ── Rate limit tiers ─────────────────────────────────────
export type RateLimitTier =
  | "ai-generation"
  | "media-generation"
  | "content-creation"
  | "community-replies"
  | "social-actions"
  | "direct-messages"
  | "publishing"
  | "profile-updates"
  | "search-browse"
  | "reports";

export interface RateLimitConfig {
  max: number;
  windowSeconds: number;
}

export const RATE_LIMITS: Record<RateLimitTier, RateLimitConfig> = {
  "media-generation": { max: 30, windowSeconds: 3600 },
  "ai-generation":    { max: 6,   windowSeconds: 60 },
  "content-creation": { max: 60,  windowSeconds: 3600 },
  "community-replies":{ max: 30,  windowSeconds: 3600 },
  "social-actions":   { max: 60,  windowSeconds: 60 },
  "direct-messages":  { max: 30,  windowSeconds: 60 },
  "publishing":       { max: 10,  windowSeconds: 3600 },
  "profile-updates":  { max: 10,  windowSeconds: 60 },
  "search-browse":    { max: 120, windowSeconds: 60 },
  "reports":          { max: 10,  windowSeconds: 3600 },
};

// Trusted (skip_review) creators' edits auto-publish without an admin in the
// loop, so the base publishing cap only throttles their own catalog updates
// — a whitelisted creator bulk-updating 60+ worlds would be stuck for hours.
// They keep a bounded window so a compromised trusted account still can't
// spam-publish unboundedly.
export const TRUSTED_PUBLISHING_RATE_LIMIT: RateLimitConfig = { max: 60, windowSeconds: 3600 };
