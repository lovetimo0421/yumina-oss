/**
 * Open-source edition stub. Platform image generation is a hosted, credit-
 * metered feature. The Studio agent checks `isSmartGenerationEnabled()` before
 * offering it, so in the local build the tool is simply reported unavailable.
 */
export const isSmartGenerationEnabled = (): boolean => false;

export class SmartSubmissionError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "SmartSubmissionError";
    this.code = code;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function smartImageEstimates(): Promise<any> {
  return {};
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function submitSmartGeneration(_userId: string, _input: unknown): Promise<any> {
  throw new SmartSubmissionError("GENERATION_UNAVAILABLE", "Image generation is not available in this edition");
}
