// Types
export { chatImageCopy, type ChatImageAttachment } from "./types/chat-image.js";

export { AI_GENERATION_DEFAULTS, aiGenerationConfigSchema, resolveAiGenerationConfig } from './ai-generation.js';
export type { AiGenerationConfig } from './ai-generation.js';
export { resolveStoryMemory, SUGGESTED_STORY_MEMORY, MIN_STORY_MEMORY, MAX_STORY_MEMORY } from './story-memory.js';
export type { StoryMemoryInput, StoryMemoryResolution } from './story-memory.js';
export { resolveLorebookBudget } from './lorebook-budget.js';
export type { LorebookBudgetInput } from './lorebook-budget.js';
export type {
  User,
  UserProfile,
  UpdateProfileInput,
  ProfileWorldSort,
} from "./types/user.js";
export {
  PROFILE_WORLD_SORT_OPTIONS,
  normalizeProfileWorldSort,
} from "./types/user.js";
export type {
  World,
  WorldStatus,
  AgeRating,
  WorldVisibility,
  TargetAudience,
  AudiencePreference,
  CreateWorldInput,
  UpdateWorldInput,
  WorldVersion,
  WorldVersionWithSchema,
  MaterialChangeReason,
  PendingEditStatus,
  WorldPendingEditSummary,
} from "./types/world.js";
export {
  AUDIENCE_PREFERENCE_DEFAULT,
  normalizeAudiencePreference,
  normalizeAgeRating,
  AUDIENCE_TAG_MALE,
  AUDIENCE_TAG_FEMALE,
  OFFICIAL_WORLD_TAGS,
  PLAYED_TAG_FILTER_THRESHOLD,
  MAX_DYNAMIC_FILTER_TAGS,
  syncAudienceTags,
  clampWorldTags,
  MAX_WORLD_TAGS,
  MAX_VERSIONS_PER_WORLD,
  MAX_AUTO_VERSIONS_PER_WORLD,
  MAX_VERSION_NAME_LENGTH,
  MAX_VERSION_NOTE_LENGTH,
} from "./types/world.js";
export type {
  ApiResponse,
  ApiError,
  PaginatedResponse,
  HealthCheckResponse,
} from "./types/api.js";
export type { ApiKeyMetadata, PromptPostProcessing } from "./types/api-key.js";
export type {
  SessionMemory,
  SessionMemoryPayload,
  SessionMemoryStatus,
  SessionMemoryUsageEntry,
  SessionMemoryUsageSummary,
  SessionSummaryCompactionMetadata,
  SessionSummaryCompactionPayload,
  SessionSummaryImplementation,
  SessionSummaryLanguage,
  SessionSummaryMode,
  SessionSummaryPayload,
  SessionSummaryRawChatProgress,
  SessionSummaryceptionPayload,
  SessionSummaryStatus,
  SummaryCompactionNoOpCode,
} from "./types/session-memory.js";
export {
  SESSION_SUMMARY_LANGUAGES,
  SESSION_SUMMARY_LANGUAGE_ENDONYMS,
  SESSION_SUMMARY_LANGUAGE_PROMPT_NAMES,
  normalizeSessionSummaryLanguage,
} from "./types/session-memory.js";
export type {
  ExtensionCategory,
  ExtensionDefinition,
  ContributionPoint,
  ContributionDecl,
  ServerHookSeam,
  ServerHookDecl,
  ExtensionInstallStatus,
  ExtensionStats,
  ExtensionInstallState,
  ExtensionSummary,
  ExtensionDetail,
  ExtensionReviewPayload,
  ExtensionReviewWithUser,
  ExtensionRatingPayload,
} from "./types/extension.js";
export {
  EVENT_SUBMISSION_TYPES,
  SOCIAL_PLATFORMS,
  FINAL_DATA_MODES,
  METRIC_RESOLUTIONS,
  SOCIAL_ENTRY_STATUSES,
  SOCIAL_EVENT_PHASES,
  SOCIAL_MEMBERSHIP_PLAN_IDS,
  COMMITTED_REWARD_GRANT_STATUSES,
} from "./types/community-event.js";
export type {
  EventSubmissionType,
  SocialPlatform,
  FinalDataMode,
  MetricResolution,
  SocialEntryStatus,
  SocialEventPhase,
  SocialMembershipPlanId,
  SocialMetrics,
  SocialScoreWeights,
  SocialRewardTier,
  SocialEventRulesConfig,
  SocialEventTimeline,
  SocialSettlementState,
  SocialSettlementInput,
  CommittedRewardGrantStatus,
  SocialCommittedMushiesGrant,
  SocialPlatformSettlement,
  SocialSettlementSummary,
  WorldEventSubmissionInput,
  SocialEventSubmissionInput,
  CommunityEventSubmissionInput,
  SocialEventEntry,
  SocialEntryRevision,
  SocialMetricSnapshot,
} from "./types/community-event.js";
export {
  SESSION_MEMORY_EXTENSION_KEY,
  EXTENSION_REGISTRY,
  EXTENSION_KEYS,
  CURRENT_EXTENSION_API_VERSION,
  MIN_SUPPORTED_EXTENSION_API_VERSION,
  isExtensionApiCompatible,
  getExtensionDefinition,
  isKnownExtensionKey,
  getExtensionKeyForCapability,
  getVisibleExtensions,
} from "./types/extension.js";

// Validation schemas
export {
  updateProfileSchema,
  type UpdateProfileSchema,
  aiConfigSchema,
  type AiConfigSchema,
} from "./validation/user.js";
export {
  createWorldSchema,
  updateWorldSchema,
  adminUpdateWorldSchema,
  type CreateWorldSchema,
  type UpdateWorldSchema,
  type AdminUpdateWorldSchema,
} from "./validation/world.js";
export {
  eventSubmissionTypeSchema,
  socialPlatformSchema,
  finalDataModeSchema,
  metricResolutionSchema,
  socialMetricsSchema,
  socialEventRulesConfigSchema,
  socialEventTimelineSchema,
  createSocialEntrySchema,
  communityEventSubmissionInputSchema,
  type SocialMetricsSchema,
  type SocialEventRulesConfigSchema,
  type SocialEventTimelineSchema,
  type CreateSocialEntrySchema,
} from "./validation/community-event.js";

// Utils
export { getAgeFromBirthYear } from "./utils/age.js";
export {
  hasTranslatableProse,
  isTranslationPending,
  TRANSLATION_PENDING_WINDOW_MS,
} from "./utils/translatable-prose.js";
export {
  DEFAULT_WORLD_NAME_BASES,
  isDefaultWorldName,
} from "./utils/world-name.js";
export { hasPublishableCover } from "./utils/world-cover.js";
export {
  SOCIAL_EVENT_INITIAL_MUSHIES,
  SOCIAL_EVENT_VERIFIED_FINAL_FLOOR_MUSHIES,
  SOCIAL_EVENT_VERIFIED_FINAL_FLOOR_RULES_VERSION,
  SOCIAL_EVENT_MAX_PLATFORMS,
  SOCIAL_EVENT_MAX_MUSHIES,
  SOCIAL_EVENT_MEMBERSHIP_DURATION_DAYS,
  SOCIAL_EVENT_MAX_METRIC_VALUE,
  SOCIAL_EVENT_REWARD_TIERS,
  DEFAULT_SOCIAL_EVENT_RULES,
  calculatePlatformScore,
  tierForPlatformScore,
  calculateEventSettlement,
  calculateVerifiedSettlementFloorMushies,
  deriveEventPhase,
} from "./utils/community-event-rewards.js";

// Constants
export {
  APP_NAME,
  MESSAGE_ROLES,
  ASSET_TYPES,
  MAX_WORLD_NAME_LENGTH,
  MAX_WORLD_DESCRIPTION_LENGTH,
  MAX_USER_NAME_LENGTH,
} from "./constants/index.js";
export type { MessageRole, AssetType } from "./constants/index.js";
export {
  MAX_DISPLAY_NAME_LENGTH,
  MAX_USERNAME_LENGTH,
  MIN_USERNAME_LENGTH,
  USERNAME_REGEX,
  MAX_BIO_LENGTH,
  MAX_LOCATION_LENGTH,
  MAX_WEBSITE_LENGTH,
  MAX_WORLD_NAME,
  MAX_WORLD_DESCRIPTION,
  MAX_WORLD_EXTENDED_DESCRIPTION,
  MAX_WORLD_ANNOUNCEMENT,
  MAX_WORLD_APPROX_TIME,
  MAX_BUNDLE_NAME,
  MAX_BUNDLE_DESCRIPTION,
  MAX_WORLD_UPDATE_TITLE,
  MAX_WORLD_UPDATE_CONTENT,
  MAX_VERSION_NAME,
  MAX_VERSION_NOTE,
  MAX_GALLERY_IMAGES,
  MAX_THREAD_TITLE,
  MAX_THREAD_CONTENT,
  MAX_POST_CONTENT,
  MAX_REVIEW_CONTENT,
  MAX_REVIEW_REPLY,
  MAX_PLAYTHROUGH_TITLE,
  MAX_PLAYTHROUGH_NOTE,
  MAX_DM_CONTENT,
  DM_UNREPLIED_LIMIT,
  MAX_TIP_MESSAGE,
  MAX_REPORT_REASON,
  MAX_REPORT_DETAILS,
  MAX_PERSONA_NAME,
  MAX_PERSONA_APPEARANCE,
  MAX_PERSONA_PERSONALITY,
  MAX_PERSONA_BACKSTORY,
  MAX_PERSONA_NOTE,
  MAX_PROFILE_POST_LENGTH,
  PROFILE_POSTS_PAGE_SIZE,
  MAX_SESSION_NAME,
  MAX_CHECKPOINT_NAME,
  MAX_CHECKPOINT_SUMMARY,
  MAX_POLL_QUESTION,
  MAX_POLL_OPTION,
  MAX_ACHIEVEMENT_NAME,
  MAX_ACHIEVEMENT_DESCRIPTION,
  MAX_FORUM_NAME,
  MAX_FORUM_DESCRIPTION,
  MAX_COMMUNITY_TAG_NAME,
  MAX_API_KEY_LABEL,
  MAX_FILENAME,
  MAX_FOLDER_NAME,
  MAX_INVITE_CODE_NOTE,
  MAX_STUDIO_CONVERSATION_TITLE,
  MAX_EVENT_TITLE,
  MAX_EVENT_INTRODUCTION,
  MAX_SOCIAL_HANDLE_LENGTH,
  MAX_SOCIAL_POST_URL_LENGTH,
  MAX_SOCIAL_EVENT_PLATFORMS,
  MAX_SOCIAL_EVIDENCE_PER_SUBMISSION,
  EVENT_PROOF_MAX_BYTES,
  EVENT_PROOF_ALLOWED_MIME_TYPES,
  MAX_USER_MESSAGE_CHARS,
  MAX_COMPLETION_MESSAGES,
  MAX_COMPLETION_TOTAL_CHARS,
  MAX_REQUEST_BODY_BYTES,
  MAX_ASSET_SIZE_IMAGE,
  MAX_ASSET_SIZE_AUDIO,
  MAX_ASSET_SIZE_FONT,
  MAX_ASSET_SIZE_OTHER,
  RATE_LIMITS,
  TRUSTED_PUBLISHING_RATE_LIMIT,
} from "./constants/limits.js";
export type { RateLimitTier, RateLimitConfig } from "./constants/limits.js";
export {
  TAG_VOCABULARY,
  findTagEntry,
  canonicalizeTag,
  tagLabel,
} from "./constants/tags.js";
export type { TagEntry, TagLocale } from "./constants/tags.js";
export {
  YUMINA_MODELS,
  RETIRED_PLAY_MODEL_IDS,
  PLAY_MODELS,
  STUDIO_MODELS,
  PLAY_MODEL_IDS,
  STUDIO_MODEL_IDS,
  DEFAULT_MODEL,
  DEFAULT_PINNED_MODELS,
  MAX_PINNED_MODELS,
  DEFAULT_POOL,
  DEFAULT_MIX_MODE,
  STUDIO_RECOMMENDED_MODEL,
  PLAN_HIERARCHY,
  formatModelId,
  formatAvgCost,
} from "./constants/models.js";
export type {
  YuminaModel,
  PlayModel,
  StudioModel,
  CostTier,
  ModelScope,
  TimeBasedAvgCostMushies,
} from "./constants/models.js";
export * from "./game-npc.js";
export {classicTinDecisions} from "./game-classic-story.js";
export * from "./admin-analytics.js";
export { layoutAtlas } from './admin-atlas.js';
export * from "./types/model-fallback.js";
export * from "./constants/model-fallback-copy.js";
export * from "./free-credit-policy.js";
export * from "./acquisition.js";
export * from "./qualified-referrals.js";

export * from './game-source-story.js';
export * from './game-source-plant.js';
export * from "./model-cost-stats.js";

export {
  GENERATION_TEMPLATES,
  ENABLED_GENERATION_TEMPLATES,
  SMART_IMAGE_MODEL,
  SMART_IMAGE_MODELS,
  SMART_IMAGE_MODEL_IDS,
  getSmartImageModel,
  getSmartImageCapabilities,
  resolveSmartImageAspect,
  resolveSmartImageResolution,
  SMART_IMAGE_ASPECTS,
  SMART_IMAGE_RESOLUTIONS,
  SMART_IMAGE_4K_COST_FACTOR,
  getEnabledGenerationTemplate,
  getGenerationTemplate,
  MAX_ACTIVE_GENERATION_JOBS,
  MAX_GENERATION_PROMPT_LENGTH,
  IMAGE_SAMPLERS,
  IMAGE_ASPECTS,
  ADVANCED_LIMITS,
  VIDEO_DURATIONS,
  VIDEO_ADVANCED_LIMITS,
  LORA_PRICE_MUSHIES,
  CUSTOM_CHECKPOINT_PRICE_MUSHIES,
  MAX_MODEL_FILE_BYTES,
  computeImagePrice,
  computeVideoPrice,
  PLATFORM_STYLES,
  getPlatformStyle,
  DENOISE_MIN,
  DENOISE_MAX,
  DENOISE_DEFAULT,
  closestAspect,
  MAX_GENERATION_PRESETS,
  GENERATION_ERROR_CODES,
  classifyWorkerError,
} from "./constants/generation.js";
export type {
  GenerationKind,
  SmartImageParams,
  SmartImageAspect,
  SmartImageResolution,
  GenerationTemplateInfo,
  GenerationJobStatus,
  ImageSampler,
  VideoDuration,
  PlatformStyleInfo,
  GenerationErrorCode,
} from "./constants/generation.js";

export { blendModelPopularity, type ModelPopularitySnapshot } from "./types/model-popularity.js";
export { DISCOVERY_INTEREST_IDS, DISCOVERY_INTEREST_GROUPS, DISCOVERY_INTEREST_TAGS,
  discoveryInterestsForTags, discoveryStarterStrength, type DiscoveryInterestId } from "./constants/discovery-interests.js";
export { MODEL_POPULARITY_SEED } from "./constants/model-popularity-seed.js";
export type { StateValidationAudit, StateGuardSettings } from "./types/state-validation.js";
export { parseStateGuardModel, stateGuardModelSelection, DEFAULT_STATE_GUARD_MODEL, FREE_STATE_GUARD_MODEL } from "./types/state-guard-model.js";
export { MUSIC_MODELS, MUSIC_MAX_PROMPT_CHARS, MUSIC_MARKUP, isMusicLength } from "./constants/music.js";
export type { MusicLength, MusicModel } from "./constants/music.js";
export { MAX_IMAGE_BATCH_ITEMS } from "./types/image-batch.js";
export { CHAT_IMAGE_MIME_TYPES, MAX_CHAT_IMAGES, MAX_CHAT_IMAGE_BYTES, MAX_CHAT_IMAGE_TOTAL_BYTES } from "./types/chat-images.js";
export type { ChatImageInput, ImageMessageContent, ImageCompletionMessage } from "./types/chat-images.js";
export type { ImageBatchTarget, ImageBatchProposalItem, ImageBatchProposal,
  ImageBatchItemStatus, ImageBatchItem, ImageBatchSnapshot } from "./types/image-batch.js";

export { IMAGE_MODEL_CAPABILITIES } from "./constants/image-models.js";
export { personaEntriesSchema, formatPersonaEntries, MAX_PERSONA_ENTRIES, MAX_PERSONA_ENTRY_TITLE, MAX_PERSONA_ENTRY_CONTENT, MAX_PERSONA_ENTRIES_TOTAL } from "./types/persona-entries.js";
export type { PersonaEntry } from "./types/persona-entries.js";
export * from "./invite-race.js";
export { KREW_ABOUT_HTML, KREW_PAGE_CSS } from "./krew-public-page.js";
