// A work's default title, from what made it: the prompt as the creator typed it, cut to its first clause.
// No LLM: a title is shown on every card, so it has to be instant and free. The creator can always rename.

export const WORK_TITLE_MAX = 24;

/** Openers that say nothing about the picture ("still this girl, …", "same character, …"). */
const BOILERPLATE = [
  /^(还是|依然是|继续|同一个|同样的|跟上一张一样的?|和刚才一样的?)(这个|那个)?(女孩|男孩|角色|人物|姑娘|少女|少年|她|他)?[，,、\s]*/u,
  /^(the\s+)?same\s+(girl|boy|character|person|woman|man)\b[,\s]*/iu,
  /^(still|again)\s+(this|the same)\s+\w+[,\s]*/iu,
  /^(a|an)\s+(picture|image|photo|illustration|drawing|render)\s+of\s+/iu,
  /^(draw|generate|make|create|画|生成|做)(一张|一个|一幅)?[:：,，\s]*/iu,
  /^(masterpiece|best quality|high quality|highly detailed|absurdres|8k|4k)[,\s]*/iu,
];

/** Strip markup a title should not show: @ marks, {slots}, [tags], (weights:1.2), quotes, extra spaces. */
function clean(text: string): string {
  return text
    .replace(/@([\p{L}\p{N}_\-·]+)/gu, "$1")
    .replace(/\{[a-z0-9_]+\}/gi, "")
    .replace(/\[[^\]]{0,40}\]/g, " ")
    .replace(/\(([^():]{1,60}):\d+(\.\d+)?\)/g, "$1")
    .replace(/["“”「」『』]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The first clause of a prompt as a short title, or "" when it holds nothing worth showing. */
export function shortWorkTitle(prompt: string | null | undefined): string {
  let text = clean(String(prompt ?? ""));
  for (let pass = 0; pass < 3; pass++) {
    const before = text;
    for (const re of BOILERPLATE) text = text.replace(re, "").trim();
    if (text === before) break;
  }
  // First sentence, then its first clause (a clause of only a word or two keeps the next one).
  const sentence = text.split(/[。！？!?\n]|\.\s/u)[0] ?? "";
  const clauses = sentence.split(/[，,;；:：、]/u).map((s) => s.trim()).filter(Boolean);
  let title = clauses[0] ?? "";
  for (const next of clauses.slice(1)) {
    if ([...title].length >= 6 || /\s/.test(title) && title.split(" ").length >= 3) break;
    title = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(title) ? title + next : `${title}, ${next}`;
  }
  title = title.replace(/^[\s,.\-–—:;]+|[\s,.\-–—:;]+$/g, "");
  const chars = [...title];
  if (chars.length > WORK_TITLE_MAX) {
    let cut = chars.slice(0, WORK_TITLE_MAX - 1).join("");
    // Prefer a word boundary in Latin text.
    const space = cut.lastIndexOf(" ");
    if (space >= 12 && !/[\p{Script=Han}]/u.test(cut)) cut = cut.slice(0, space);
    title = `${cut.trimEnd()}…`;
  }
  // A title must say something: a bare tag or a single letter is not one.
  return [...title].length >= 2 && !/^(probe|test|untitled|image|video|audio)$/i.test(title) ? title : "";
}

/** A finished job's default title: its typed prompt, a tool's words, or a live character's name. */
export function jobWorkTitle(job: { kind: string; params: Record<string, unknown> | null }): string {
  // A sealed 做法's words are not for a title: the work goes by the 做法's name.
  if (typeof job.params?.sealedSkillId === "string") return typeof job.params.sealedTitle === "string" ? job.params.sealedTitle : "";
  const p = job.params ?? {};
  const mentions = p.mentions as { prompt?: string } | undefined;
  const inputs = (p.inputs ?? {}) as Record<string, unknown>;
  const typed = mentions?.prompt ?? (typeof p.prompt === "string" ? p.prompt : undefined)
    ?? (typeof inputs.prompt === "string" ? inputs.prompt : undefined) ?? (typeof inputs.text === "string" ? inputs.text : undefined);
  const fromPrompt = shortWorkTitle(typed);
  if (fromPrompt) return fromPrompt;
  if (job.kind === "rig" && typeof p.name === "string") return shortWorkTitle(p.name);
  return "";
}
