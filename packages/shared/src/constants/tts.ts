/**
 * Voice readout (TTS) — model, pricing and the curated voice catalog.
 *
 * Provider path: OpenRouter's `/api/v1/audio/speech` endpoint routing to
 * Fish Audio S2.1 Pro. The `voice` parameter accepts a fish.audio voice
 * marketplace reference id (32-hex), verified 2026-08-27 — so the curated
 * list below is just a starter set; any marketplace voice id works.
 *
 * Pricing: Fish bills per UTF-8 BYTE of input text (CJK ≈ 3 bytes/char),
 * verified against OpenRouter generation records — cost is computed locally
 * as byteLength × TTS_PRICE_USD_PER_UTF8_BYTE instead of waiting for the
 * (delayed) generation accounting endpoint.
 */

/** The only TTS model wired in v1. Keep as a constant so a later model picker
 *  can grow out of it without hunting string literals. */
export const TTS_MODEL = "fish-audio/s2.1-pro";

/** $15 per million UTF-8 bytes (OpenRouter pricing.prompt for the model). */
export const TTS_PRICE_USD_PER_UTF8_BYTE = 15 / 1_000_000;

/** The platform markup on the provider's charge — the same 1.2 every chat
 *  model carries in model_prices. Voice is billed per byte with no price row,
 *  so the multiplier lives here. */
export const TTS_MARKUP = 1.2;

/** Hard cap on synthesized text length (characters, post-cleanup). A 3000-char
 *  Chinese message is ~9000 bytes ≈ $0.135 — the ceiling on a single click. */
export const TTS_MAX_TEXT_CHARS = 3000;

/** What part of a message gets read aloud.
 *  - "full": the whole message (narration + dialogue), markup stripped.
 *  - "dialogue": only quoted spans (“…” "…" 「…」 『…』); falls back to full
 *    when a message contains no quotes. */
export type TtsReadingMode = "full" | "dialogue";

export interface TtsVoice {
  /** fish.audio marketplace reference id (32-hex). */
  id: string;
  /** i18n key suffix under settings `tts.voices.*`. */
  labelKey: string;
  /** Primary language of the reference audio. Any voice can speak any
   *  supported language (cross-lingual timbre transfer) — this is a hint for
   *  grouping and defaults, not a restriction. */
  lang: "zh" | "en" | "ja" | "es";
  gender: "female" | "male";
}

/** Curated voices — generic character archetypes only (no real-person clones,
 *  no branded characters). First batch verified synthesizing through
 *  OpenRouter on 2026-08-27; the 2026-08-28 additions were picked from the
 *  fish.audio marketplace by task_count and every id confirmed `trained` via
 *  `GET api.fish.audio/model/{id}`. `as const satisfies` keeps labelKey a
 *  literal union so the settings page can build typed i18n keys from it.
 *
 *  Marketplace voices can be deleted by their owners at any time — two of
 *  these were (2026-09-28, both narrators). When that happens, replace the
 *  id here and map the old one in RETIRED_TTS_VOICES so saved preferences and
 *  cards keep working. */
export const TTS_VOICES = [
  // ── Chinese ──
  { id: "faccba1a8ac54016bcfc02761285e67f", labelKey: "zhGentleFemale", lang: "zh", gender: "female" },
  { id: "c189c7cff21c400ba67592406202a3a0", labelKey: "zhMatureFemale", lang: "zh", gender: "female" },
  { id: "23e171c3bbaa4642badf9c98ca31835c", labelKey: "zhSweetGirl", lang: "zh", gender: "female" },
  { id: "5c353fdb312f4888836a9a5680099ef0", labelKey: "zhLivelyFemale", lang: "zh", gender: "female" },
  { id: "6ce7ea8ada884bf3889fa7c7fb206691", labelKey: "zhLightMatureFemale", lang: "zh", gender: "female" },
  { id: "bf6c479f5a384b8d857310030035824b", labelKey: "zhBrightFemale", lang: "zh", gender: "female" },
  { id: "1aa2054d429d4d7da253baac420c57dc", labelKey: "zhYoungMale", lang: "zh", gender: "male" },
  { id: "6fc59d2b56cf402eb572934114c8d8aa", labelKey: "zhNarratorMale", lang: "zh", gender: "male" },
  { id: "59cb5986671546eaa6ca8ae6f29f6d22", labelKey: "zhBroadcastMale", lang: "zh", gender: "male" },
  { id: "dd43b30d04d9446a94ebe41f301229b5", labelKey: "zhDeepMale", lang: "zh", gender: "male" },
  { id: "bbfff76fd7c74f35a04a33366574f2d6", labelKey: "zhSteadyMale", lang: "zh", gender: "male" },
  // ── English ──
  { id: "2a9605eeafe84974b5b20628d42c0060", labelKey: "enFemale", lang: "en", gender: "female" },
  { id: "933563129e564b19a115bedd57b7406a", labelKey: "enNarratorFemale", lang: "en", gender: "female" },
  { id: "98655a12fa944e26b274c535e5e03842", labelKey: "enSoftFemale", lang: "en", gender: "female" },
  { id: "7e5102e4f5ff4339bc8ad0692279436c", labelKey: "enYouthfulMale", lang: "en", gender: "male" },
  { id: "bf322df2096a46f18c579d0baa36f41d", labelKey: "enDeepMale", lang: "en", gender: "male" },
  { id: "536d3a5e000945adb7038665781a4aca", labelKey: "enCalmMale", lang: "en", gender: "male" },
  // ── Japanese ──
  { id: "0089dce5fefb4c6ba9b9f2f0debe1ddc", labelKey: "jaCalmFemale", lang: "ja", gender: "female" },
  { id: "5161d41404314212af1254556477c17d", labelKey: "jaEnergeticFemale", lang: "ja", gender: "female" },
  { id: "46745543e52548238593a3962be77e3a", labelKey: "jaBrightGirl", lang: "ja", gender: "female" },
  { id: "45c5d3723c9c42f598e4776dcfd5f02d", labelKey: "jaCalmMale", lang: "ja", gender: "male" },
  { id: "6daf5fa1876149899323e17f07245d2f", labelKey: "jaDeepMale", lang: "ja", gender: "male" },
  // ── Spanish ──
  { id: "bfed5c0810a347dbb62e8ccce7f59c48", labelKey: "esFemale", lang: "es", gender: "female" },
  { id: "35929683c49c4ec0bf779dc07d22620b", labelKey: "esGirl", lang: "es", gender: "female" },
  { id: "3f45a7fd7a614655a61eb7027b955783", labelKey: "esNarratorMale", lang: "es", gender: "male" },
] as const satisfies readonly TtsVoice[];

/** Sentinel for "let the platform pick by UI language". Stored as the empty
 *  string in preferences so absent and auto mean the same thing. */
export const TTS_VOICE_AUTO = "";

/** Pick the default voice for a UI language ("auto" voice resolution). */
export function defaultTtsVoiceForLang(lang: string | undefined): string {
  const l = (lang ?? "en").toLowerCase();
  if (l.startsWith("zh")) return "faccba1a8ac54016bcfc02761285e67f";
  if (l.startsWith("ja")) return "0089dce5fefb4c6ba9b9f2f0debe1ddc";
  if (l.startsWith("es")) return "bfed5c0810a347dbb62e8ccce7f59c48";
  return "2a9605eeafe84974b5b20628d42c0060";
}

/** A valid explicit voice value: a curated id or any 32-hex marketplace id. */
export function isValidTtsVoice(voice: string): boolean {
  return /^[a-f0-9]{32}$/.test(voice);
}

/** Curated voices whose fish.audio model was deleted upstream → the catalog
 *  voice that replaced them. Saved preferences and card `entry.voice` values
 *  still carry the old ids; synthesizing with one is a hard provider error. */
export const RETIRED_TTS_VOICES: Readonly<Record<string, string>> = {
  // zhNarratorMale — fish.audio 404 "Model not found", found 2026-09-28
  "6910bc3ba4284e31b49be252faf3601b": "6fc59d2b56cf402eb572934114c8d8aa",
  // esNarratorMale — same
  "35199d5438854f5d9157c500479ab684": "3f45a7fd7a614655a61eb7027b955783",
};

/** The id to actually synthesize with: retired curated ids map forward. */
export function resolveTtsVoiceAlias(voice: string): string {
  return RETIRED_TTS_VOICES[voice] ?? voice;
}

/**
 * Voice readout is opt-in: only `preferences.ttsEnabled === true` counts as
 * on. A missing key means off — everyone starts without it, and nothing ever
 * wrote the key until a player flipped a switch (the settings page and the
 * in-chat panel patch only the key they change), so a stored `true` is always
 * a player's own choice and is kept.
 */
export function isTtsOptedIn(preferences: unknown): boolean {
  if (!preferences || typeof preferences !== "object") return false;
  return (preferences as Record<string, unknown>).ttsEnabled === true;
}

/** Most voices a player's pool keeps (the curated catalog plus a few custom ids). */
export const TTS_VOICE_POOL_MAX = 40;

/** A stored pool → valid, de-duplicated voice ids (retired ids mapped forward). */
export function sanitizeTtsVoicePool(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const id = v.trim().toLowerCase();
    if (!isValidTtsVoice(id)) continue;
    const resolved = resolveTtsVoiceAlias(id);
    if (!out.includes(resolved)) out.push(resolved);
    if (out.length >= TTS_VOICE_POOL_MAX) break;
  }
  return out;
}

/**
 * The player's voice pool (`preferences.ttsVoicePool`): the voices AI casting
 * may hand to characters. Empty = every voice. Before the pool existed the
 * player picked ONE voice (`ttsVoice`); that choice reads as a pool of one
 * until the player edits the pool.
 */
export function readTtsVoicePool(preferences: unknown): string[] {
  const prefs = (preferences && typeof preferences === "object" ? preferences : {}) as Record<string, unknown>;
  if (Array.isArray(prefs.ttsVoicePool)) return sanitizeTtsVoicePool(prefs.ttsVoicePool);
  return typeof prefs.ttsVoice === "string" ? sanitizeTtsVoicePool([prefs.ttsVoice]) : [];
}

/** The catalog language of a voice, or null for a custom (non-catalog) id. */
export function ttsVoiceLang(id: string): TtsVoice["lang"] | null {
  return TTS_VOICES.find((v) => v.id === id)?.lang ?? null;
}

/**
 * The pool voices that can read a given language: catalog voices of that
 * language, plus custom ids (their language is unknown, and the player added
 * them on purpose). Order follows the pool.
 */
export function ttsPoolForLang(pool: readonly string[], lang: string): string[] {
  return pool.filter((id) => {
    const l = ttsVoiceLang(id);
    return l === null || l === lang;
  });
}

/** A custom (non-catalog) fish.audio voice the player saved, with the name
 *  they gave it. Kept apart from the pool so unticking a custom voice only
 *  takes it out of casting — before this list existed the Custom group was
 *  derived from the pool, so unticking made the voice vanish outright. */
export interface TtsCustomVoice {
  id: string;
  /** "" = unnamed (shown as the id's first 8 characters). */
  name: string;
}

export const TTS_CUSTOM_VOICE_NAME_MAX = 40;

/** A stored custom-voice list → valid, de-duplicated entries, catalog ids
 *  dropped (they already have names), names trimmed. */
export function sanitizeTtsCustomVoices(raw: unknown): TtsCustomVoice[] {
  if (!Array.isArray(raw)) return [];
  const out: TtsCustomVoice[] = [];
  for (const entry of raw) {
    const rawId = typeof entry === "string" ? entry : (entry as { id?: unknown } | null)?.id;
    if (typeof rawId !== "string") continue;
    const id = resolveTtsVoiceAlias(rawId.trim().toLowerCase());
    if (!isValidTtsVoice(id) || TTS_VOICES.some((v) => v.id === id) || out.some((v) => v.id === id)) continue;
    const rawName = typeof entry === "object" && entry ? (entry as { name?: unknown }).name : "";
    const name = typeof rawName === "string" ? rawName.replace(/\s+/g, " ").trim().slice(0, TTS_CUSTOM_VOICE_NAME_MAX) : "";
    out.push({ id, name });
    if (out.length >= TTS_VOICE_POOL_MAX) break;
  }
  return out;
}

/** The player's saved custom voices (`preferences.ttsCustomVoices`), plus any
 *  custom id still sitting in the pool from before the list existed. */
export function readTtsCustomVoices(preferences: unknown): TtsCustomVoice[] {
  const prefs = (preferences && typeof preferences === "object" ? preferences : {}) as Record<string, unknown>;
  return sanitizeTtsCustomVoices([
    ...(Array.isArray(prefs.ttsCustomVoices) ? prefs.ttsCustomVoices : []),
    ...readTtsVoicePool(preferences),
  ]);
}

/** What to call a custom voice: its name, else the id's first 8 characters. */
export function ttsCustomVoiceLabel(voice: TtsCustomVoice): string {
  return voice.name || `${voice.id.slice(0, 8)}…`;
}
