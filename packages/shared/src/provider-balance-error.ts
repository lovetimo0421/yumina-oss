/**
 * Provider wording identifies an upstream balance failure, never whose key was
 * used. Only the server's resolved provider can distinguish BYOK from Yumina.
 * A bare 429/quota/rate limit is not evidence of a credit balance failure.
 */
export function isProviderBalanceError(message: string): boolean {
  return /insufficient[\s_-]+(?:credits?|balance|quota)\b|used all (?:of )?your credits|run out of credits|(?:not enough|requires more) credits|credit balance (?:is )?too low|(?:Custom endpoint|OpenRouter|OpenAI|Anthropic|Google) error \(402\)/i.test(message);
}
