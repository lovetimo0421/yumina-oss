// How age reaches a per-turn picture. Until the replacement age model lands,
// there is no per-character age judgment: everyone is drawn as an adult,
// youth tags are removed and youth is pushed into the negative.
//
// "Explicit" is the tagger's nsfw flag OR explicit tags in its own prompt, so
// a tagger that flags nsfw=false but still writes "nude" can't slip past.

/** Tags the checkpoint learned from sexualised art. Never drawn, at any age. */
const SEXUALISED_YOUTH_RE = /\b(loli|lolita|shota|shotacon|lolicon)\b/i;
/** Youth words: removed from every look. */
const YOUTH_RE = /\b(child|children|kid|young girl|young boy|little girl|little boy|toddler|aged down|petite child|elementary school|middle school|teen|teenage|teenager)\b/i;
const ADULT_RE = /\b(adult|mature)\b/i;
const COUNT_TAG_RE = /^(\d+|multiple\s+)?(girls?|boys?|others?)$/i;

/** Tags that make a picture sexual or suggestive. */
const EXPLICIT_TAG_RE = /\b(nsfw|explicit|nude|nudity|naked|nipples?|areolae?|breasts? out|pussy|penis|vaginal|anal|sex|cum|fellatio|handjob|footjob|paizuri|masturbat\w*|cowgirl position|missionary|doggystyle|spread legs|topless|bottomless|undressing|lingerie|underwear|panties|bra|see-through|cleavage|suggestive|seductive|erotic|groping|fingering|orgasm|ahegao|after sex)\b/i;

export const BASE_NEGATIVE =
  "lowres, worst quality, bad quality, bad anatomy, bad hands, extra fingers, missing fingers, extra arms, extra hands, extra legs, " +
  "deformed, blurry, jpeg artifacts, watermark, text, logo, signature, clothes writing, english text, print, letters, book title, " +
  "speech bubble, multiple views, split screen, collage, comic, panels, inset, border, frame, " +
  "loli, shota";
/** Keeps everyone on screen from drifting young. */
const ADULT_NEGATIVE = ", child, aged down, petite child";

function splitTags(tags: string): string[] {
  return (tags.includes(",") ? tags.split(",") : tags.split(/\s+/)).map((t) => t.trim().replace(/_/g, " ")).filter(Boolean);
}

/** Small models sometimes return "silver_hair red_eyes"; the text encoder reads
 *  comma-separated, space-worded tags best. Everyone is anchored as an adult;
 *  youth and sexualised youth tags are dropped. */
export function normalizeTags(tags: string): string {
  const list = splitTags(tags).filter((t) => !SEXUALISED_YOUTH_RE.test(t) && !YOUTH_RE.test(t));
  // Every look leads with its head count; castTags() relies on it.
  if (!list.some((t) => COUNT_TAG_RE.test(t))) {
    list.unshift(/\b(man|male|boy|husband|father|king|son)\b/i.test(list.join(" ")) ? "1boy" : "1girl");
  }
  if (!list.some((t) => ADULT_RE.test(t))) list.splice(1, 0, "adult");
  return list.join(", ");
}

/** Text authors put into a LoRA picture (trigger words, and the prompt they end up in)
 *  as the youth check reads it: lowercase, "_" and "-" as spaces, spacing collapsed. */
export function normalizeLoraText(text: string): string {
  return text.toLowerCase().replace(/[_-]/g, " ").replace(/\s+/g, " ").trim();
}

// Plural and variant forms the look filters don't need (taggers write single
// tags) but free author text does, and the usual CJK words (no word boundaries there).
const LORA_YOUTH_RE = /\b(?:child|children|kids?|toddlers?|(?:young|little) (?:girl|boy)s?|aged down|petite child|elementary school|middle school|preteens?|teens?|teenage|teenagers?|under ?age|lolis?|lolita|lolicon|shotas?|shotacon|schoolgirls?|schoolboys?)\b/;
const CJK_YOUTH_RE = /萝莉|蘿莉|正太|幼女|幼童|幼儿|幼兒|儿童|兒童|女童|男童|小女孩|小男孩|未成年|小学生|小學生|初中生|中学生|中學生|ロリ|ショタ|子供|子ども|こども|어린이|아동|로리|쇼타/;

/** True when LoRA-supplied text names a child or youth, in any of those forms. */
export function loraTextMentionsYouth(text: string): boolean {
  const normalized = normalizeLoraText(text);
  return LORA_YOUTH_RE.test(normalized) || CJK_YOUTH_RE.test(normalized);
}

/** A LoRA's trigger words, cleaned: any tag naming youth is dropped. The tag
 *  itself keeps its spelling ("deepseek_whale_girl" is one token to its LoRA);
 *  only the check reads it normalized. */
export function cleanTrigger(trigger: string): string {
  return trigger.split(/[,，]/).map((t) => t.replace(/\s+/g, " ").trim())
    .filter((t) => t && !loraTextMentionsYouth(t))
    .join(", ");
}

/** True when the text names a child or youth (or a sexualised-youth tag) anywhere. */
export function mentionsYouth(text: string): boolean {
  return SEXUALISED_YOUTH_RE.test(text) || YOUTH_RE.test(text);
}

/** True when the tagger flagged the moment or its own tags are sexual. */
export function isExplicitMoment(nsfw: boolean, ...tagLists: string[]): boolean {
  return nsfw || tagLists.some((tags) => splitTags(tags).some((t) => EXPLICIT_TAG_RE.test(t)));
}

/** An ordinary moment: the checkpoint drifts to nudity on its own. */
const SFW_NEGATIVE = ", nsfw, nude, nudity, nipples, pussy, penis, sex, cum, topless, bottomless";

/** `base` replaces BASE_NEGATIVE for checkpoints whose card asks for a short
 *  negative; loli/shota stay in it whatever it says. */
export function negativeFor(sfw = false, base = BASE_NEGATIVE): string {
  const guarded = /\bloli\b/.test(base) ? base : `${base}, loli, shota`;
  return guarded + ADULT_NEGATIVE + (sfw ? SFW_NEGATIVE : "");
}
