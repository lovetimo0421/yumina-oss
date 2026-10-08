/** Authenticated native-provider accounting adapter. Never feed this browser
 * telemetry. Contains no transcript/audio/context, and leaves missing counts
 * genuinely unknown. Private pilot accounting is intentionally unchanged. */
export const VOICE_RATE_CARD = {
  version: "openai-native-2026-10-07-v1",
  models: { response: "gpt-realtime-2.1", transcription: "gpt-4o-transcribe" },
  markup: { numerator: 6, denominator: 5 },
  // Integer tenths of USD per million tokens (no binary decimal arithmetic).
  rates: {
    response: {
      inputText: 40,
      inputAudio: 320,
      cachedText: 4,
      cachedAudio: 4,
      outputText: 240,
      outputAudio: 640,
    },
    transcription: {
      inputText: 25,
      inputAudio: 25,
      cachedText: 0,
      cachedAudio: 0,
      outputText: 100,
      outputAudio: 0,
    },
  },
  sources: [
    "https://developers.openai.com/api/docs/models/gpt-realtime-2.1",
    "https://developers.openai.com/api/docs/models/gpt-4o-transcribe",
  ],
} as const;
export interface VoiceRateSnapshot {
  version: string;
  models: { response: string; transcription: string };
  markup: { numerator: number; denominator: number };
  rates: typeof VOICE_RATE_CARD.rates;
  sources: readonly string[];
  catalog: {
    response: { id: string; minPlan: "free"; markup: "1.20" };
    transcription: { id: string; minPlan: "free"; markup: "1.20" };
  };
}
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const count = (v: unknown): number | null =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 10_000_000
    ? v
    : null;
const id = (v: unknown): string => {
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(v))
    throw Error("INVALID_VOICE_EVENT_ID");
  return v;
};
export function canonicalVoiceJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
}
export function validVoiceSnapshot(v: unknown): v is VoiceRateSnapshot {
  const o = object(v),
    c = object(o.catalog);
  if (Buffer.byteLength(JSON.stringify(o), "utf8") > 4096) return false;
  for (const k of ["version", "models", "markup", "rates", "sources"] as const)
    if (canonicalVoiceJson(o[k]) !== canonicalVoiceJson(VOICE_RATE_CARD[k]))
      return false;
  return (
    Object.keys(o).sort().join() ===
      "catalog,markup,models,rates,sources,version" &&
    Object.keys(c).sort().join() === "response,transcription" &&
    [c.response, c.transcription].every((v) => {
      const r = object(v);
      return (
        Object.keys(r).sort().join() === "id,markup,minPlan" &&
        typeof r.id === "string" &&
        r.id.length > 0 &&
        r.id.length <= 200 &&
        r.minPlan === "free" &&
        r.markup === "1.20"
      );
    })
  );
}
export interface VoiceCounts {
  inputTokens: number | null;
  outputTokens: number | null;
  inputTextTokens: number | null;
  inputAudioTokens: number | null;
  cachedTextTokens: number | null;
  cachedAudioTokens: number | null;
  outputTextTokens: number | null;
  outputAudioTokens: number | null;
}
export interface VoiceAccountingDetail {
  snapshot: VoiceRateSnapshot;
  complete: boolean;
  issues: string[];
  reported: { totalTokens: number | null; cachedTokens: number | null };
}
export function validVoiceAccountingDetail(
  value: unknown,
): value is VoiceAccountingDetail {
  const d = object(value),
    reported = object(d.reported);
  const allowedIssues = [
    "missing-or-invalid-count",
    "invalid-count-detail",
    "total-mismatch",
    "unsupported-transcription-detail",
    "missing-cache-detail",
    "unsupported-image-usage",
    "modality-mismatch",
  ];
  return (
    Object.keys(d).sort().join() === "complete,issues,reported,snapshot" &&
    validVoiceSnapshot(d.snapshot) &&
    typeof d.complete === "boolean" &&
    Array.isArray(d.issues) &&
    d.issues.length <= allowedIssues.length &&
    d.issues.every((v) => typeof v === "string" && allowedIssues.includes(v)) &&
    (d.complete ? d.issues.length === 0 : d.issues.length > 0) &&
    Object.keys(reported).sort().join() === "cachedTokens,totalTokens" &&
    Object.values(reported).every((v) => v === null || count(v) !== null) &&
    Buffer.byteLength(canonicalVoiceJson(d), "utf8") <= 8192
  );
}
export interface NativeVoiceUsage extends VoiceCounts {
  kind: "response" | "transcription";
  providerEventId: string;
  model: string;
  rateCardVersion: string;
  accountingDetail: VoiceAccountingDetail;
  providerCostUsd: string | null;
}
export function normalizeVoiceUsage(
  value: unknown,
  model: string,
  snapshot: VoiceRateSnapshot,
): NativeVoiceUsage {
  if (!validVoiceSnapshot(snapshot)) throw Error("VOICE_PRICING_UNAVAILABLE");
  const e = object(value),
    asr = e.type === "conversation.item.input_audio_transcription.completed";
  if (e.type !== "response.done" && !asr)
    throw Error("INVALID_VOICE_EVENT_TYPE");
  const kind = asr ? "transcription" : "response",
    r = object(e.response);
  if (
    model !== snapshot.models[kind] ||
    (r.model !== undefined && r.model !== model) ||
    (e.model !== undefined && e.model !== model)
  )
    throw Error("VOICE_MODEL_MISMATCH");
  const index = count(e.content_index);
  if (asr && (index === null || index > 99999999))
    throw Error("INVALID_VOICE_EVENT_ID");
  const providerEventId = asr ? `${id(e.item_id)}:${index}` : id(r.id);
  const u = object(asr ? e.usage : r.usage),
    i = object(u.input_token_details),
    o = object(u.output_token_details),
    c = object(i.cached_tokens_details);
  const inputTokens = count(u.input_tokens),
    outputTokens = count(u.output_tokens);
  const allZero = inputTokens === 0 && outputTokens === 0;
  const suppliedAsrOutput = asr && u.output_token_details !== undefined;
  const counts: VoiceCounts = {
    inputTokens,
    outputTokens,
    inputTextTokens: count(i.text_tokens) ?? (allZero ? 0 : null),
    inputAudioTokens: count(i.audio_tokens) ?? (allZero ? 0 : null),
    cachedTextTokens: asr ? 0 : (count(c.text_tokens) ?? (allZero ? 0 : null)),
    cachedAudioTokens: asr
      ? 0
      : (count(c.audio_tokens) ?? (allZero ? 0 : null)),
    // ASR's documented output is text when the optional detail is absent.
    // Supplied detail is evidence, so preserve it rather than overwrite it
    // with the total or pretend contradictory audio was reported as zero.
    outputTextTokens:
      asr && !suppliedAsrOutput
        ? outputTokens
        : (count(o.text_tokens) ?? (!asr && allZero ? 0 : null)),
    outputAudioTokens: asr
      ? o.audio_tokens === undefined
        ? 0
        : count(o.audio_tokens)
      : (count(o.audio_tokens) ?? (allZero ? 0 : null)),
  };
  const issues: string[] = [];
  if (
    [
      u.input_tokens,
      u.output_tokens,
      u.total_tokens,
      i.text_tokens,
      i.audio_tokens,
      i.cached_tokens,
      c.text_tokens,
      c.audio_tokens,
      o.text_tokens,
      o.audio_tokens,
    ].some((v) => v !== undefined && count(v) === null)
  )
    issues.push("invalid-count-detail");
  if (Object.values(counts).some((n) => n === null))
    issues.push("missing-or-invalid-count");
  if (
    u.total_tokens !== undefined &&
    count(u.total_tokens) !==
      (inputTokens === null || outputTokens === null
        ? null
        : inputTokens + outputTokens)
  )
    issues.push("total-mismatch");
  if (
    asr &&
    (u.type !== "tokens" ||
      (i.cached_tokens !== undefined && i.cached_tokens !== 0) ||
      (c.text_tokens !== undefined && c.text_tokens !== 0) ||
      (c.audio_tokens !== undefined && c.audio_tokens !== 0) ||
      (suppliedAsrOutput &&
        (u.output_token_details === null ||
          typeof u.output_token_details !== "object" ||
          Array.isArray(u.output_token_details) ||
          Object.keys(o).some(
            (key) => key !== "text_tokens" && key !== "audio_tokens",
          ) ||
          count(o.text_tokens) !== outputTokens ||
          (o.audio_tokens !== undefined && o.audio_tokens !== 0))))
  )
    issues.push("unsupported-transcription-detail");
  if (!asr && count(i.cached_tokens) === null && !allZero)
    issues.push("missing-cache-detail");
  if (
    [i.image_tokens, o.image_tokens, c.image_tokens].some(
      (n) => n !== undefined && n !== 0,
    )
  )
    issues.push("unsupported-image-usage");
  if (Object.values(counts).every((n) => n !== null)) {
    const n = counts as Record<keyof VoiceCounts, number>;
    if (
      n.inputTokens !== n.inputTextTokens + n.inputAudioTokens ||
      n.outputTokens !== n.outputTextTokens + n.outputAudioTokens ||
      n.cachedTextTokens > n.inputTextTokens ||
      n.cachedAudioTokens > n.inputAudioTokens ||
      (!asr &&
        (count(i.cached_tokens) ?? 0) !==
          n.cachedTextTokens + n.cachedAudioTokens)
    )
      issues.push("modality-mismatch");
  }
  const complete = issues.length === 0;
  let providerCostUsd: string | null = null;
  if (complete) {
    const n = counts as Record<keyof VoiceCounts, number>,
      rates = snapshot.rates[kind];
    const pico =
      (BigInt(n.inputTextTokens - n.cachedTextTokens) *
        BigInt(rates.inputText) +
        BigInt(n.inputAudioTokens - n.cachedAudioTokens) *
          BigInt(rates.inputAudio) +
        BigInt(n.cachedTextTokens) * BigInt(rates.cachedText) +
        BigInt(n.cachedAudioTokens) * BigInt(rates.cachedAudio) +
        BigInt(n.outputTextTokens) * BigInt(rates.outputText) +
        BigInt(n.outputAudioTokens) * BigInt(rates.outputAudio)) *
      100000n;
    providerCostUsd = `${pico / 1000000000000n}.${(pico % 1000000000000n).toString().padStart(12, "0")}`;
  }
  return {
    ...counts,
    kind,
    providerEventId,
    model,
    rateCardVersion: snapshot.version,
    providerCostUsd,
    accountingDetail: {
      snapshot,
      complete,
      issues,
      reported: {
        totalTokens: count(u.total_tokens),
        cachedTokens: count(i.cached_tokens),
      },
    },
  };
}
