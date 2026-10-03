/**
 * Detects a finished reply that is a model policy refusal rather than story
 * text ("该请求要求生成…我无法满足…", "I need to stop and talk about this…").
 *
 * Pure and deliberately conservative: a false positive puts a "the model
 * refused" bar under a perfectly good story turn, which is worse than missing
 * a refusal. So a reply only counts when it speaks OUT of character — an
 * assistant-voice refusal ("我无法继续", "I can't continue") together with
 * policy / AI-meta vocabulary ("安全准则", "作为AI助手", "content policy") —
 * and either the whole reply is short, or the refusal opens the reply and the
 * rest is more policy talk. One narrower case needs no policy words: a short
 * reply that OPENS with the refusal and then offers other directions
 * ("这个我不能写。…上一条给的几个方向仍然有效"). Quoted dialogue is stripped before matching, so a
 * character saying 「我不能这样做」 inside a story never counts.
 *
 * The reply itself is kept and billed as-is; the flag only drives UI.
 */

export type RefusalLang = "zh" | "en";

export interface DetectRefusalOptions {
  /** Restrict matching to one language's phrase set. Default: both. */
  lang?: RefusalLang;
}

/** A reply at or under this many chars is judged as a whole. */
const SHORT_REPLY_MAX = 700;
/** Longer than this is always a story (or at least not a bare refusal). */
const LONG_REPLY_MAX = 4000;
/** For a long reply, the refusal must sit in this opening window. */
const OPENING_WINDOW = 400;
/** For a long reply, this share of paragraphs must be policy talk. */
const POLICY_PARAGRAPH_SHARE = 0.6;

/** First-person, assistant-voice refusals. */
const REFUSAL: Record<RefusalLang, RegExp[]> = {
  zh: [
    /我(?:无法|不能|不会|没办法|不可以|不便|必须拒绝|只能拒绝)(?:再)?(?:接着写|往下写|继续|满足|提供|生成|创作|撰写|编写|写|协助|帮助|参与|描写|推进|完成|输出|配合)/,
    /无法(?:满足|继续|提供|生成|创作|撰写|协助|配合|推进)(?:你的|您的|该|此|这个|这类|此类|这样的)?(?:请求|要求|内容|描写|创作)?/,
    /我(?:需要|必须|得|想)(?:先)?停(?:下来|一下|在这里)/,
    /我(?:不应该|不应当|不该)(?:继续|生成|提供|写|创作|参与|描写)?/,
    /(?:拒绝|不予)(?:生成|提供|继续|创作|执行)(?:该|此|这个|这类|此类)?(?:请求|内容)?/,
    // "我无法按照要求生成…" — a short qualifier between the modal and the verb (Gemini 3.7).
    /我(?:无法|不能|不会|没办法)(?:按照|按|根据|照)(?:你的|您的)?(?:要求|请求|设定)(?:来)?(?:继续|生成|创作|撰写|编写|写|描写|提供)/,
  ],
  en: [
    /\bI(?:\s+really)?\s+(?:can(?:'|’)?t|cannot|can not|won(?:'|’)t|will not|am not able to|(?:'|’)m not able to|am unable to|(?:'|’)m unable to|must decline to|have to decline to|shouldn(?:'|’)t|should not|(?:'|’)m not going to|am not going to)\s+(?:continue|create|write|generate|produce|help|assist|engage|provide|depict|describe|go on|keep going|proceed|fulfill|comply|participate|do that|take (?:this|the story))/i,
    /\bI\s+(?:need|have|want)\s+to\s+(?:stop|pause|step (?:back|out)|break character)/i,
    /\bI(?:'|’)m\s+(?:going to|gonna)\s+(?:stop|pause|step (?:back|out))/i,
    /\bI\s+(?:must|have to|need to)\s+(?:decline|refuse)/i,
    /\bI(?:'|’)m not comfortable\s+(?:continuing|writing|creating|generating|with)/i,
  ],
};

/**
 * Out-of-character vocabulary: talk about the AI, its rules, or the request
 * itself. Each pattern is one "kind" of signal; hits are counted by pattern.
 */
const META: Record<RefusalLang, RegExp[]> = {
  zh: [
    /作为(?:一个|一名)?(?:AI|ＡＩ|人工智能|语言模型|AI助手|人工智能助手|助手)/i,
    /(?:安全|内容|使用|社区|平台|系统)(?:准则|政策|规范|指南|条款|规定)/,
    /指导原则|伦理(?:准则|原则|底线)/,
    // Formal assistant register only — "你的要求" is too common in NPC speech.
    /(?:该|此类?|这类)(?:请求|要求)/,
    /(?:此类|这类|该类|这样的)(?:内容|描写|请求)/,
    /色情(?:内容|描写|细节|材料|作品|场景)?|情色描写/,
    /性(?:器官|行为|暗示|内容)(?:的)?(?:称谓|描写|细节|过程|内容)?/,
    /露骨(?:的)?(?:性|色情)?(?:内容|描写|细节)|性露骨|明确(?:的)?性/,
    /严格禁止|明确禁止|不被允许|违反(?:了)?(?:相关)?(?:规定|政策|准则|规范)/,
    /未成年(?:人)?(?:的)?(?:性|色情)/,
    /坦诚地?(?:和|与|跟)?(?:你|您)?(?:讨论|谈谈|聊聊|说)/,
    /(?:这个|这段|我们的)(?:对话|角色扮演|故事)(?:的)?(?:方向|走向|内容)/,
  ],
  en: [
    /\bas an? (?:AI|language model|AI assistant|assistant)\b/i,
    /\b(?:content|usage|safety|community) (?:policy|policies|guidelines|rules)\b/i,
    /\b(?:my|the) (?:guidelines|principles|values)\b|\bagainst (?:my|the) (?:guidelines|principles|policies|values)\b/i,
    /\b(?:sexually explicit|explicit sexual|graphic sexual|explicit content|pornographic|sexual content|(?:depictions? of|depicting) sexual acts)\b/i,
    /\b(?:minors?|underage)\b/i,
    /\b(?:this|your|that) (?:request|prompt)\b/i,
    /\b(?:step(?:ping)? out of|break(?:ing)?) (?:the )?(?:roleplay|character|story|fiction)\b/i,
    /\b(?:this|our|the) (?:conversation|roleplay|role-play)(?:'s)? (?:direction|is heading|has (?:gone|moved|drifted))/i,
    /\b(?:Anthropic|OpenAI|Google)(?:'s)? (?:policies|policy|guidelines)\b/i,
    /\b(?:I(?:'|’)d be happy to|I(?:'|’)m happy to|I can) (?:help|continue|write|offer)[^.!?\n]{0,80}\b(?:instead|different|another|other)\b/i,
  ],
};

/** "Here's what I can do instead" — counts as policy talk for long replies. */
const OFFER: Record<RefusalLang, RegExp[]> = {
  zh: [
    /如果(?:你|您)(?:愿意|想|希望|需要)/,
    /我(?:可以|很乐意|愿意)(?:帮|为|和|与|继续|提供|协助|换)/,
    /我们可以(?:换|尝试|改|把|继续)/,
    /(?:其他|别的|另一个)(?:方向|方式|情节|故事)/,
  ],
  en: [
    /\bif you(?:'|’)d like\b|\bif you want\b|\bif you(?:'|’)re open to\b/i,
    /\bI(?:'|’)d be happy to\b|\bI(?:'|’)m happy to\b|\bI can (?:help|offer|write|continue)\b/i,
    /\binstead\b|\balternative(?:ly)?\b|\ba different (?:direction|approach|scene)\b/i,
  ],
};

/** Paired quotes that hold in-character dialogue. */
const QUOTED = /“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"|＂[^＂\n]*＂/g;

function stripDialogue(text: string): string {
  return text.replace(QUOTED, " ");
}

function langs(options?: DetectRefusalOptions): RefusalLang[] {
  return options?.lang ? [options.lang] : ["zh", "en"];
}

function countHits(text: string, table: Record<RefusalLang, RegExp[]>, which: RefusalLang[]): number {
  let hits = 0;
  for (const lang of which) for (const re of table[lang]) if (re.test(text)) hits++;
  return hits;
}

function isRefusalBlock(text: string, which: RefusalLang[]): boolean {
  return countHits(text, REFUSAL, which) >= 1 && countHits(text, META, which) >= 1;
}

function isPolicyParagraph(paragraph: string, which: RefusalLang[]): boolean {
  return (
    countHits(paragraph, REFUSAL, which) > 0 ||
    countHits(paragraph, META, which) > 0 ||
    countHits(paragraph, OFFER, which) > 0
  );
}

/** A bare refusal ("这个我不能写") counts without policy words only when it opens the reply… */
const REFUSAL_LEAD = 120;
/** …and the reply goes on to offer the player other directions (GLM 5.3 style). */
const ALTERNATIVES: Record<RefusalLang, RegExp[]> = {
  zh: [/(?:其他|别的|另一个|换个|换一个)(?:方向|情节|故事|场景)|方向(?:仍然|依然|都)?有效|(?:选|挑)一个(?:方向)?|可以这样改/],
  en: [/\b(?:a different|another) (?:direction|scene|approach)\b|\binstead\b/i],
};

function isLeadingRefusalWithAlternatives(text: string, which: RefusalLang[]): boolean {
  return countHits(text.slice(0, REFUSAL_LEAD), REFUSAL, which) >= 1 && countHits(text, ALTERNATIVES, which) >= 1;
}

export function detectRefusal(text: string, options?: DetectRefusalOptions): boolean {
  const trimmed = (text ?? "").trim();
  if (!trimmed || trimmed.length > LONG_REPLY_MAX) return false;
  const which = langs(options);

  if (trimmed.length <= SHORT_REPLY_MAX) {
    const bare = stripDialogue(trimmed);
    return isRefusalBlock(bare, which) || isLeadingRefusalWithAlternatives(bare, which);
  }

  // Long reply: the refusal must open it, and the rest must also be policy
  // talk. A paragraph carrying quoted dialogue is story, never policy.
  if (!isRefusalBlock(stripDialogue(trimmed.slice(0, OPENING_WINDOW)), which)) return false;
  const paragraphs = trimmed.split(/\n\s*\n|\n/).map((p) => p.trim()).filter((p) => p.length > 0);
  if (paragraphs.length === 0) return false;
  let policy = 0;
  for (const paragraph of paragraphs) {
    const dialogueFree = stripDialogue(paragraph);
    if (dialogueFree.length < paragraph.length) continue; // had dialogue → story
    if (isPolicyParagraph(dialogueFree, which)) policy++;
  }
  return policy / paragraphs.length >= POLICY_PARAGRAPH_SHARE;
}
