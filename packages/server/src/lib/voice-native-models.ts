/** Billing-only native IDs. These models have no Yumina text-chat capability. */
export const NATIVE_VOICE_MODEL_IDS = [
  "gpt-realtime-2.1",
  "gpt-4o-transcribe",
] as const;
export type NativeVoiceModel = (typeof NATIVE_VOICE_MODEL_IDS)[number];
export function isNativeVoiceModel(model: string): model is NativeVoiceModel {
  // Reject the provider-prefixed spelling too; BYOK/allowNonPriced must not
  // turn a billing-only native model into an OpenRouter chat request.
  return NATIVE_VOICE_MODEL_IDS.some(
    (id) => model === id || model === `openai/${id}`,
  );
}
