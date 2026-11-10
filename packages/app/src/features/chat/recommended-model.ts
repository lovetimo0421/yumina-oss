/** The model the author of the world a chat session plays recommends
 *  (settings.recommendedModel): the model picker marks it, never picks it. */
export function sessionRecommendedModel(session: { world?: { schema?: unknown } | null } | null | undefined): string | undefined {
  const value = (session?.world?.schema as { settings?: { recommendedModel?: unknown } } | undefined)?.settings?.recommendedModel;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
