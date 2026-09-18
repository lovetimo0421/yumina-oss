export const APP_NAME = "Yumina";

export const MESSAGE_ROLES = ["user", "assistant", "system"] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export const ASSET_TYPES = ["image", "audio", "font", "txt", "other"] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

export { MAX_WORLD_NAME as MAX_WORLD_NAME_LENGTH } from "./limits.js";
export { MAX_WORLD_DESCRIPTION as MAX_WORLD_DESCRIPTION_LENGTH } from "./limits.js";
export { MAX_DISPLAY_NAME_LENGTH as MAX_USER_NAME_LENGTH } from "./limits.js";

export const LLM_PROVIDERS = ["openrouter", "anthropic", "openai", "ollama"] as const;
export type LLMProviderType = (typeof LLM_PROVIDERS)[number];

export const AUDIO_TRACK_TYPES = ["bgm", "sfx", "ambient"] as const;
export type AudioTrackType = (typeof AUDIO_TRACK_TYPES)[number];
