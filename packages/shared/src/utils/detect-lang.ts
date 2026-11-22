/**
 * Detect language of free-form user text.
 *
 * Order matters:
 *   1. Japanese kana (hiragana/katakana) present → "ja"
 *      Kana is Japanese-only, so even a small ratio is a hard signal.
 *      Must come before "zh" so kanji-heavy Japanese isn't misread as Chinese.
 *   2. Hangul → "ko"; Cyrillic → "ru" (each its own script, judged by ratio)
 *   3. CJK character ratio > 30% (without kana) → "zh"
 *   4. Spanish markers (ñ, ¿, ¡, or accented vowels + common function words) → "es"
 *   5. Indonesian function words outnumbering English ones → "id"
 *   6. fallback → "en"
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

export type DetectedLang = "zh" | "en" | "es" | "ja" | "ko" | "id" | "ru";

/**
 * Lowercase only: a capitalised "Ada" or "Dan" is a name, not 'there is'/'and'.
 * Words English shares (in, me, to, a) are left out; this list has to be
 * Indonesian and nothing else.
 */
const INDONESIAN_WORDS =
  /(?<![\p{L}])(?:yang|dan|tidak|nggak|enggak|gak|ngga|saya|aku|kamu|anda|kita|kami|mereka|ini|itu|untuk|dengan|dari|sudah|udah|belum|bisa|akan|juga|karena|tapi|tetapi|kalau|kalo|apa|bagaimana|gimana|kenapa|banget|sangat|lebih|seperti|atau|pada|oleh|ada|sih|dong|deh|aja|saja|lagi|harus|mau|ingin|tolong|terima|kasih|bagus|keren|semua|sama|baru|cerita|karakter|sekali|jadi|punya|dia)(?![\p{L}])/gu;
const ENGLISH_WORDS =
  /\b(?:the|an?|is|are|was|were|be|been|it|its|i|i'm|you|your|we|they|this|that|these|those|and|or|but|to|of|in|on|for|with|my|me|our|has|have|had|can|could|do|does|did|not|no|so|if|what|how|who|why|when|which|there|here|just|also|too|very|please|anyone|someone|thanks)\b/gi;

export function detectLang(text: string): DetectedLang {
  const stripped = stripNoise(text);
  const total = stripped.replace(/\s/g, "").length || 1;

  const kana = stripped.match(/[぀-ゟ゠-ヿ･-ﾟ]/g)?.length ?? 0;
  // Even 2% kana in a sizeable post is unambiguous Japanese — kana characters
  // don't appear in Chinese. Lower bound prevents false positives on a stray
  // katakana mark in mostly-Chinese text.
  if (kana >= 2 && kana / total > 0.02) return "ja";

  // Hangul and Cyrillic are each one language's script here, checked before han so a
  // Korean post with a hanja word is not read as Chinese. The bar is the
  // same 30% han uses, judged on letters only so quoted model names and
  // numbers do not dilute a short Korean or Russian comment below it.
  const letters = stripped.match(/\p{L}/gu)?.length || 1;
  const hangul = stripped.match(/\p{Script=Hangul}/gu)?.length ?? 0;
  if (hangul / letters > 0.3) return "ko";
  const cyrillic = stripped.match(/\p{Script=Cyrillic}/gu)?.length ?? 0;
  if (cyrillic / letters > 0.3) return "ru";

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

  // Indonesian shares the Latin script with English, so it is told by its
  // function words: two or more, and more of them than English ones.
  const idWords = stripped.match(INDONESIAN_WORDS)?.length ?? 0;
  const enWords = stripped.match(ENGLISH_WORDS)?.length ?? 0;
  if (idWords >= 2 && idWords > enWords) return "id";

  return "en";
}
