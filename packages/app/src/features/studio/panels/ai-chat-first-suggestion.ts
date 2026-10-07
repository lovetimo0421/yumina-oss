/** The first starter prompt fits the card it sits beside: an empty card is
 *  asked to be written, an imported one in another script to be translated,
 *  one already written to be looked over. */
export function firstSuggestionKey(
  entries: ReadonlyArray<{ role: string; content?: string; presetId?: string }>,
  language: string,
): "suggestLore" | "suggestTranslate" | "suggestReview" {
  // The built-in presets every card carries are not what the author wrote.
  const text = entries.filter(entry => entry.role !== "greeting" && !entry.presetId).map(entry => entry.content ?? "").join("\n");
  if (text.trim().length < 120) return "suggestLore";
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u9fff]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  const uiCjk = /^(zh|ja)/i.test(language);
  if (uiCjk ? cjk < latin / 20 : latin < cjk / 5) return "suggestTranslate";
  return "suggestReview";
}
