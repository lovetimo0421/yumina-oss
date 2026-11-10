import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeVoiceUsage,
  VOICE_RATE_CARD,
  validVoiceSnapshot,
  canonicalVoiceJson,
  type VoiceRateSnapshot,
} from "./voice-native-accounting.js";
const snapshot: VoiceRateSnapshot = {
  ...VOICE_RATE_CARD,
  catalog: {
    response: { id: "r", minPlan: "free", markup: "1.20" },
    transcription: { id: "t", minPlan: "free", markup: "1.20" },
  },
};
test("native modality/cache detail prices exactly and never persists private provider fields", () => {
  const e = {
    type: "response.done",
    privateTranscript: "never store these words",
    response: {
      id: "r",
      status: "cancelled",
      usage: {
        input_tokens: 30,
        output_tokens: 7,
        total_tokens: 37,
        input_token_details: {
          text_tokens: 10,
          audio_tokens: 20,
          cached_tokens: 8,
          cached_tokens_details: { text_tokens: 3, audio_tokens: 5 },
        },
        output_token_details: { text_tokens: 2, audio_tokens: 5 },
      },
    },
  };
  const n = normalizeVoiceUsage(e, "gpt-realtime-2.1", snapshot);
  assert.equal(n.providerCostUsd, "0.000879200000");
  assert.equal(n.accountingDetail.complete, true);
  assert.equal(JSON.stringify(n).includes("never store"), false);
  assert.equal(
    validVoiceSnapshot(JSON.parse(canonicalVoiceJson(snapshot))),
    true,
  );
  assert.equal(
    validVoiceSnapshot({
      ...snapshot,
      markup: { numerator: 120001, denominator: 100000 },
    }),
    false,
  );
  assert.equal(validVoiceSnapshot({ ...snapshot, rates: {} }), false);
  const wrong = structuredClone(e);
  wrong.response.usage.input_token_details.cached_tokens = 9;
  assert.equal(
    normalizeVoiceUsage(wrong, "gpt-realtime-2.1", snapshot).accountingDetail
      .complete,
    false,
  );
  const image = structuredClone(e) as typeof e & {
    response: { usage: { input_token_details: { image_tokens: number } } };
  };
  image.response.usage.input_token_details.image_tokens = 1;
  assert.equal(
    normalizeVoiceUsage(image, "gpt-realtime-2.1", snapshot).providerCostUsd,
    null,
  );
  assert.throws(
    () => normalizeVoiceUsage(e, "unpriced", snapshot),
    /VOICE_MODEL_MISMATCH/,
  );
});
test("present invalid zero detail and unsupported ASR cache cannot become free complete accounting", () => {
  const zero = {
    type: "response.done",
    response: {
      id: "zero-invalid",
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        input_token_details: { text_tokens: -1 },
      },
    },
  };
  assert.equal(
    normalizeVoiceUsage(zero, "gpt-realtime-2.1", snapshot).accountingDetail
      .complete,
    false,
  );
  const asr = {
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "asr",
    content_index: 0,
    usage: {
      type: "tokens",
      input_tokens: 1,
      output_tokens: 1,
      input_token_details: {
        text_tokens: 0,
        audio_tokens: 1,
        cached_tokens_details: { text_tokens: 1 },
      },
    },
  };
  assert.equal(
    normalizeVoiceUsage(asr, "gpt-4o-transcribe", snapshot).accountingDetail
      .complete,
    false,
  );
});

test("ASR preserves supplied output counts and rejects unsupported or contradictory text-only evidence", () => {
  const asr = {
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "asr-output",
    content_index: 0,
    usage: {
      type: "tokens",
      input_tokens: 1,
      output_tokens: 1,
      input_token_details: { text_tokens: 0, audio_tokens: 1 },
    },
  };
  for (const output of [
    undefined,
    { text_tokens: 1 },
    { text_tokens: 1, audio_tokens: 0 },
  ]) {
    const n = normalizeVoiceUsage(
      {
        ...asr,
        usage: {
          ...asr.usage,
          ...(output === undefined ? {} : { output_token_details: output }),
        },
      },
      "gpt-4o-transcribe",
      snapshot,
    );
    assert.equal(n.accountingDetail.complete, true);
    assert.equal(n.outputTextTokens, 1);
    assert.equal(n.outputAudioTokens, 0);
    assert.equal(n.providerCostUsd, "0.000012500000");
  }
  const invalid = [
    { detail: { text_tokens: 0, audio_tokens: 1 }, text: 0, audio: 1 },
    { detail: { text_tokens: 2, audio_tokens: 0 }, text: 2, audio: 0 },
    {
      detail: { text_tokens: 1, audio_tokens: 0, image_tokens: 1 },
      text: 1,
      audio: 0,
    },
    {
      detail: { text_tokens: 1, audio_tokens: 0, video_tokens: 1 },
      text: 1,
      audio: 0,
    },
    { detail: { audio_tokens: 1 }, text: null, audio: 1 },
    { detail: { text_tokens: -1, audio_tokens: 0 }, text: null, audio: 0 },
    { detail: null, text: null, audio: 0 },
  ];
  for (const { detail, text, audio } of invalid) {
    const n = normalizeVoiceUsage(
      { ...asr, usage: { ...asr.usage, output_token_details: detail } },
      "gpt-4o-transcribe",
      snapshot,
    );
    assert.equal(n.accountingDetail.complete, false, JSON.stringify(detail));
    assert.equal(n.inputTokens, 1);
    assert.equal(n.outputTokens, 1);
    assert.equal(n.outputTextTokens, text);
    assert.equal(n.outputAudioTokens, audio);
    assert.equal(n.providerCostUsd, null);
    assert.ok(n.accountingDetail.issues.length > 0);
  }
});
