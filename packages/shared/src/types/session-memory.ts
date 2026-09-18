export type SessionMemoryStatus = "idle" | "updating" | "failed";
export type SessionSummaryStatus = "idle" | "updating" | "failed";
export type SessionSummaryMode = "threshold" | "overflow";
export type SessionSummaryImplementation = "localdev" | "summaryception";

/**
 * Session memory is a single free-form text block (markdown-ish). It used to be
 * six structured string arrays parsed from strict LLM JSON, but cheap updater
 * models routinely emitted broken JSON (truncation, unescaped quotes, CJK
 * dialogue), losing the turn's facts entirely. Text can't fail to parse — a
 * size-limited second response can be saved with a visible warning. Legacy array-shaped values are
 * converted on read (see normalizeSessionMemory in the server).
 */
export interface SessionMemory {
  text: string;
  /** Usable partial output; omissions may remain until a rebuild or manual edit. */
  warning?: "truncated";
}

export interface SessionMemoryUsageEntry {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedMushies: number;
  apiKeyTier: string;
  generationTimeMs: number | null;
  createdAt: string | null;
}

export interface SessionMemoryUsageSummary {
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedMushies: number;
  last: SessionMemoryUsageEntry | null;
}

export interface SessionMemoryPayload {
  memory: SessionMemory;
  hasMemory: boolean;
  /** Player-pinned notes: never rewritten by the updater, always injected. */
  pinned: string | null;
  model: string;
  included: boolean;
  language: SessionSummaryLanguage;
  status: SessionMemoryStatus;
  error: string | null;
  updatedAt: string | null;
  lastSourceHash: string | null;
  lastProcessedMessageId: string | null;
  usage: SessionMemoryUsageSummary;
  /** Eligible replies after the last successful checkpoint; null means legacy coverage needs repair. */
  pendingTurns?: number | null;
  autoPaused?: boolean;
  retryCount?: number;
}

export interface SessionSummaryPayload {
  /** Latest manual regeneration; polling reconnects after a reload. */
  job?: {
    id: string;
    status: "queued" | "running" | "completed" | "failed";
    phase: "episodes" | "merge";
    completed: number;
    total: number;
    error: string | null;
    updatedAt: number;
  } | null;
  summary: string;
  hasSummary: boolean;
  implementation: SessionSummaryImplementation;
  model: string;
  mode: SessionSummaryMode;
  included: boolean;
  localdevIncluded: boolean;
  language: SessionSummaryLanguage;
  summaryceptionIncluded: boolean;
  triggerTokens: number;
  recentTailTokens: number;
  status: SessionSummaryStatus;
  error: string | null;
  /** Automatic story-summary work is paused by a per-session safety budget. */
  autoCompactionPaused: boolean;
  /** The paused automatic summary can be explicitly resumed by the player. */
  autoCompactionCanResume: boolean;
  /** A user-authorized recovery attempt will run when compaction is next needed. */
  autoCompactionResumePending: boolean;
  updatedAt: string | null;
  coversUntilMessageId: string | null;
  tokenCount: number | null;
  lastSourceHash: string | null;
  rawChatProgress: SessionSummaryRawChatProgress | null;
  usage: SessionMemoryUsageSummary;
  summaryception: SessionSummaryceptionPayload;
}

export interface SessionSummaryceptionPayload {
  hasSummary: boolean;
  model: string;
  layerCount: number;
  snippetCount: number;
  tokenCount: number | null;
  status: SessionSummaryStatus;
  error: string | null;
  updatedAt: string | null;
  coversUntilMessageId: string | null;
  coversUntilOrdinal: number | null;
  usage: SessionMemoryUsageSummary;
  layers: SessionSummaryceptionLayerPayload[];
}

export interface SessionSummaryceptionLayerPayload {
  layerIndex: number;
  snippets: SessionSummaryceptionSnippetPayload[];
}

export interface SessionSummaryceptionSnippetPayload {
  id: string;
  layerIndex: number;
  snippetOrder: number;
  text: string;
  sourceStartMessageId: string | null;
  sourceEndMessageId: string | null;
  sourceStartOrdinal: number | null;
  sourceEndOrdinal: number | null;
  fromLayer: number | null;
  mergedCount: number | null;
  promoted: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface SessionSummaryRawChatProgress {
  mode: SessionSummaryMode;
  currentTokens: number;
  triggerTokens: number;
  recentTailTokens: number;
  remainingTokens: number;
  percent: number;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  canCompactNow: boolean;
  compactableTokens: number;
  compactableMessageCount: number;
  retainedTokens: number;
  retainedMessageCount: number;
}

/**
 * Machine-readable reason a forced "Compress Now" made no changes. The client
 * maps these to localized, number-aware copy — the server must NOT put
 * user-facing prose in charge of the UI. `noOpReason` (English) stays only as a
 * debug/log fallback for unknown codes.
 */
export type SummaryCompactionNoOpCode =
  | "fits-within-raw-tail" // whole transcript still fits the kept-raw tail; nothing older to compact
  | "batch-already-compacted" // the targeted Layered Summary batch is already compacted
  | "session-apis-unavailable"; // sandbox has no live session APIs

export interface SessionSummaryCompactionMetadata {
  compactedCount: number;
  compactedFromMessageId: string | null;
  compactedToMessageId: string | null;
  compactedFromOrdinal: number | null;
  compactedToOrdinal: number | null;
  compactedFromPreview: string | null;
  compactedToPreview: string | null;
  compactedUntilOneLine: string | null;
  compactedTokenEstimate: number;
  retainedCount: number;
  retainedTokenEstimate: number;
  noOpReason: string | null;
  noOpReasonCode: SummaryCompactionNoOpCode | null;
}

export interface SessionSummaryCompactionPayload {
  summary: SessionSummaryPayload;
  compaction: SessionSummaryCompactionMetadata;
}

/**
 * Output language for every background summarizer in the Session Memory
 * extension (session memory, story summary, layered snippets).
 *
 * `"auto"` (the default, and what a NULL column means) tells the summarizer to
 * write in whatever language the transcript itself is written in. Before this
 * existed the prompts were English-only with no language directive, so cheap
 * updater models summarized Chinese/Japanese stories into English — which
 * translated character and place names, and then drifted further every time
 * that English memory was read back into a Chinese story
 * (reported by 格鲁曼钢铁厂, 2026-08-21).
 */
export type SessionSummaryLanguage =
  | "auto"
  | "en"
  | "zh-Hans"
  | "zh-Hant"
  | "ja"
  | "ko"
  | "es"
  | "fr"
  | "de"
  | "pt"
  | "ru";

export const SESSION_SUMMARY_LANGUAGES = [
  "auto",
  "en",
  "zh-Hans",
  "zh-Hant",
  "ja",
  "ko",
  "es",
  "fr",
  "de",
  "pt",
  "ru",
] as const satisfies readonly SessionSummaryLanguage[];

/**
 * How each language is named to the summarizer model. English name + native
 * name: the English half is what small models reliably understand, the native
 * half disambiguates the two Chinese scripts (a bare "Chinese" gets Simplified
 * from most models regardless of which one was asked for).
 */
export const SESSION_SUMMARY_LANGUAGE_PROMPT_NAMES: Record<
  Exclude<SessionSummaryLanguage, "auto">,
  string
> = {
  en: "English",
  "zh-Hans": "Simplified Chinese (简体中文)",
  "zh-Hant": "Traditional Chinese (繁體中文)",
  ja: "Japanese (日本語)",
  ko: "Korean (한국어)",
  es: "Spanish (Español)",
  fr: "French (Français)",
  de: "German (Deutsch)",
  pt: "Portuguese (Português)",
  ru: "Russian (Русский)",
};

/** Endonym for each option — the picker labels itself, in every UI language. */
export const SESSION_SUMMARY_LANGUAGE_ENDONYMS: Record<
  Exclude<SessionSummaryLanguage, "auto">,
  string
> = {
  en: "English",
  "zh-Hans": "简体中文",
  "zh-Hant": "繁體中文",
  ja: "日本語",
  ko: "한국어",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  pt: "Português",
  ru: "Русский",
};

export function normalizeSessionSummaryLanguage(value: unknown): SessionSummaryLanguage {
  return (SESSION_SUMMARY_LANGUAGES as readonly string[]).includes(value as string)
    ? (value as SessionSummaryLanguage)
    : "auto";
}
