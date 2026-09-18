/**
 * Detect language of free-form user text.
 *
 * Order matters:
 *   1. Japanese kana (hiragana/katakana) present → "ja"
 *      Kana is Japanese-only, so even a small ratio is a hard signal.
 *      Must come before "zh" so kanji-heavy Japanese isn't misread as Chinese.
 *   2. CJK character ratio > 30% (without kana) → "zh"
 *   3. Spanish markers (ñ, ¿, ¡, or accented vowels + common function words) → "es"
 *   4. fallback → "en"
 *
 * Spanish detection is conservative on purpose: a stray "á" in an English
 * post should not flip the lang. We require either a Spanish-only character
 * (ñ ¿ ¡) or accented vowels plus a function word match.
 */
function stripNoise(text: string): string {
  // Strip content that has no language signal but inflates char counts and
  // dilutes the CJK ratio: image/link markdown, fenced + inline code, bare
  // URLs, and HTML tags. Without this, a Chinese post with two attached
  // image markdowns falls below the 30% CJK threshold and gets mislabeled
  // as English.
  return text
    .replace(/!?\[[^\]]*]\([^)]+\)/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]+`/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/https?:\/\/\S+/g, "");
}

export function detectLang(text: string): "zh" | "en" | "es" | "ja" {
  const stripped = stripNoise(text);
  const total = stripped.replace(/\s/g, "").length || 1;

  const kana = stripped.match(/[぀-ゟ゠-ヿ･-ﾟ]/g)?.length ?? 0;
  // Even 2% kana in a sizeable post is unambiguous Japanese — kana characters
  // don't appear in Chinese. Lower bound prevents false positives on a stray
  // katakana mark in mostly-Chinese text.
  if (kana >= 2 && kana / total > 0.02) return "ja";

  const cjk = stripped.match(/[一-鿿㐀-䶿]/g)?.length ?? 0;
  if (cjk / total > 0.3) return "zh";
  // Below the ratio bar, look at how the han is arranged rather than how much
  // there is. A Chinese post about models and error strings — "本地ollama无法
  // 正常调用 connect时提示Failed to fetch model list: fetch failed" — is 27%
  // han with the rest quoted Latin verbatim, and filing it as English means
  // no English translation is ever made for it. An English post that mentions
  // a Chinese card title has one run of han inside English prose. So: two
  // separate runs of han is a Chinese writer; one run is a Chinese writer
  // unless English function words surround it; any han next to full-width
  // punctuation (English writers never type ，。！？) is a Chinese writer.
  // Audit of every en-filed source on 2026-09-06: 53 posts in the 5%-30% band,
  // every one of them Chinese; zero English posts with two han runs.
  const hanRuns = stripped.match(/[一-鿿㐀-䶿]{2,}/g)?.length ?? 0;
  const hasCjkPunct = /[，。！？：；、“”‘’（）【】《》]/.test(stripped);
  const hasEnglishProse =
    /\b(?:the|an?|is|are|was|were|be|been|it|its|i|i'm|you|your|we|they|this|that|these|those|and|or|but|to|of|in|on|for|with|my|me|our|has|have|had|can|could|do|does|did|not|no|so|if|what|how|who|why|when|which|there|here|just|also|too|very|please|anyone|someone|thanks)\b/i.test(
      stripped,
    );
  if (hanRuns >= 2) return "zh";
  if (hanRuns >= 1 && (hasCjkPunct || !hasEnglishProse)) return "zh";
  if (cjk >= 1 && hasCjkPunct) return "zh";

  const hasSpanishOnlyChar = /[ñÑ¿¡]/.test(stripped);
  const hasAccentedVowel = /[áéíóúÁÉÍÓÚ]/.test(stripped);
  // Function words that are Spanish and nothing else — "me", "no", "y" are
  // left out because English has them too, and this branch already requires
  // an accented vowel, so a stray "café" in English must not flip on "me".
  const hasSpanishWord =
    /\b(el|la|los|las|que|de|es|para|por|con|una|del|al|pero|porque|cuando|donde|también|más|mi|mis|tu|tus|sobre|muy|hay|está|están|tiene|tienen|puedo|puede|pueden|alguien|algo|nada|todo|todos|este|esta|esto|ese|esa|eso|como|cómo|qué|sí|ya|gracias|hola|bueno|buena|ahora|siempre|nunca|aquí|así)\b/i.test(
      stripped,
    );
  if (hasSpanishOnlyChar || (hasAccentedVowel && hasSpanishWord)) return "es";

  return "en";
}
