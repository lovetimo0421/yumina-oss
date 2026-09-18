export const KIMI_ANTI_REPETITION_MODEL = "moonshotai/kimi-k2-0905";

export function isKimiAntiRepetitionModel(modelId: string): boolean {
  return modelId === KIMI_ANTI_REPETITION_MODEL;
}

export function kimiRepetitionOverride(modelId: string, repetitionPenalty: number) {
  return isKimiAntiRepetitionModel(modelId) ? { repetitionPenalty } : {};
}
