/** One explicit fallback for summary models that cannot fulfill a text-only
 * request. The caller retains provider selection, billing and attempt limits. */
export async function generateWithSummaryFallback(args: {
  model: string;
  fallbackModel: string;
  generate: (model: string, isFallback: boolean) => Promise<string>;
  onFallback?: (reason: string) => void;
}): Promise<{ text: string; model: string }> {
  try {
    return { text: await args.generate(args.model, false), model: args.model };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const refusal = /prohibited[_\s-]?content|content[_\s-]?filter|safety|moderat(?:ion|ed)|inappropriate content|flagged/i.test(message);
    const providerTerms = /^(?:The selected upstream provider rejected this request under its Terms of Service\.|OpenRouter error \(403\):[\s\S]*(?:provider tos|terms of service))/i.test(message);
    const reasoningRequired = /OpenRouter error \(400\):[\s\S]*Reasoning is mandatory[^\n]*cannot be disabled/i.test(message);
    if (args.model === args.fallbackModel || (!refusal && !providerTerms && !reasoningRequired)) throw error;
    args.onFallback?.(reasoningRequired ? "reasoning cannot be disabled" : providerTerms ? "provider terms" : "content filter");
    // This is deliberately outside another retry catch. A failing fallback
    // surfaces its own error, and the caller's attempt budget still applies.
    return { text: await args.generate(args.fallbackModel, true), model: args.fallbackModel };
  }
}
