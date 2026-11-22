import { z } from 'zod';

/**
 * A player's "regex" (正则): find text in the story and replace it. Most rules are plain text ("vanguard" →
 * nothing); a rule can also be a real regular expression, written by hand or imported from SillyTavern.
 * Rules never change what is saved: they apply when a message is shown, when the story is sent to the AI,
 * or both, so switching one off restores everything.
 */
export const REGEX_RULES_MAX = 100;
export const REGEX_FIND_MAX = 500;
export const REGEX_REPLACE_MAX = 2000;

export const regexRuleSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().max(80).optional(),
  /** Plain text to find, or the regex source when isRegex. */
  find: z.string().min(1).max(REGEX_FIND_MAX),
  replace: z.string().max(REGEX_REPLACE_MAX),
  isRegex: z.boolean(),
  /** Regex flags (g is always added). Plain-text rules use "i" here for "ignore case". */
  flags: z.string().regex(/^[imsu]*$/).max(4).optional(),
  /** Whose messages: the AI's replies, the player's own, or both. */
  ai: z.boolean(),
  user: z.boolean(),
  /** Where: on screen only, in what the AI is sent, or both. */
  display: z.boolean(),
  prompt: z.boolean(),
  /** Only messages this many back from the newest (0 = newest) or further / at most this far. */
  minDepth: z.number().int().min(0).max(10_000).nullable().optional(),
  maxDepth: z.number().int().min(0).max(10_000).nullable().optional(),
  enabled: z.boolean(),
});
export type RegexRule = z.infer<typeof regexRuleSchema>;
export const regexRulesSchema = z.array(regexRuleSchema).max(REGEX_RULES_MAX);

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The rule as a RegExp, or null when the pattern does not compile. */
export function compileRegexRule(rule: Pick<RegexRule, 'find' | 'isRegex' | 'flags'>): RegExp | null {
  const flags = 'g' + [...new Set((rule.flags ?? '').replace(/[^imsu]/g, ''))].join('');
  try {
    return new RegExp(rule.isRegex ? rule.find : escapeRegExp(rule.find), flags);
  } catch {
    return null;
  }
}

/** A plain-text rule's replacement is taken literally ($ means $); a regex rule's may use $1, $& and {{match}}. */
function replacementFor(rule: Pick<RegexRule, 'replace' | 'isRegex'>): string {
  return rule.isRegex ? rule.replace.replace(/\{\{match\}\}/gi, '$$&') : rule.replace.replace(/\$/g, '$$$$');
}

export type RegexTarget = { role: 'user' | 'assistant' | string; where: 'display' | 'prompt'; depth?: number };

/** Rules that apply to this message, in order. */
export function rulesFor(rules: readonly RegexRule[] | null | undefined, target: RegexTarget): RegexRule[] {
  if (!rules?.length) return [];
  return rules.filter((rule) => {
    if (!rule.enabled) return false;
    if (target.where === 'display' ? !rule.display : !rule.prompt) return false;
    if (target.role === 'assistant' ? !rule.ai : target.role === 'user' ? !rule.user : true) return false;
    if (typeof target.depth === 'number') {
      if (rule.minDepth != null && target.depth < rule.minDepth) return false;
      if (rule.maxDepth != null && target.depth > rule.maxDepth) return false;
    }
    return true;
  });
}

/** Apply the rules that match this message. A rule that does not compile is skipped. */
export function applyRegexRules(text: string, rules: readonly RegexRule[] | null | undefined, target: RegexTarget): string {
  let out = text;
  for (const rule of rulesFor(rules, target)) {
    const re = compileRegexRule(rule);
    if (!re) continue;
    out = out.replace(re, replacementFor(rule));
  }
  return out;
}

/** Make a plain-text rule (the default kind, and what "never show this again" creates). */
export function makeTextRule(find: string, replace = '', id = randomId()): RegexRule {
  return { id, find: find.slice(0, REGEX_FIND_MAX), replace, isRegex: false, ai: true, user: false, display: true, prompt: true, enabled: true };
}

function randomId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * SillyTavern regex scripts → rules. Accepts one exported script, a list of them, or anything holding them under
 * `regex` / `regex_scripts` / `extensions.regex_scripts` (a settings export or a character card's data).
 * Returns the rules it could read and the names of the ones it could not.
 */
export function parseSillyTavernRegex(input: unknown): { rules: RegexRule[]; skipped: string[] } {
  const scripts: unknown[] = [];
  const collect = (value: unknown, depth = 0): void => {
    if (depth > 4 || !value) return;
    if (Array.isArray(value)) { for (const item of value) collect(item, depth + 1); return; }
    if (typeof value !== 'object') return;
    const obj = value as Record<string, unknown>;
    if (typeof obj.findRegex === 'string') { scripts.push(obj); return; }
    for (const key of ['regex', 'regex_scripts', 'extensions', 'data']) collect(obj[key], depth + 1);
  };
  collect(input);
  const rules: RegexRule[] = [];
  const skipped: string[] = [];
  for (const raw of scripts.slice(0, REGEX_RULES_MAX)) {
    const s = raw as Record<string, unknown>;
    const name = typeof s.scriptName === 'string' ? s.scriptName.slice(0, 80) : undefined;
    const literal = /^\/([\s\S]*)\/([a-z]*)$/.exec(String(s.findRegex));
    const find = literal ? literal[1]! : String(s.findRegex);
    const flags = (literal ? literal[2]! : '').replace(/[^imsu]/g, '');
    const placement = Array.isArray(s.placement) ? (s.placement as unknown[]).map(Number) : [2];
    const rule: RegexRule = {
      id: typeof s.id === 'string' && s.id.length <= 64 ? s.id : randomId(),
      ...(name ? { name } : {}),
      find,
      replace: typeof s.replaceString === 'string' ? s.replaceString.slice(0, REGEX_REPLACE_MAX) : '',
      isRegex: true,
      ...(flags ? { flags } : {}),
      // ST placement: 1 = the player's input, 2 = the AI's output.
      user: placement.includes(1),
      ai: placement.includes(2),
      // markdownOnly = on screen only; promptOnly = sent to the AI only; neither changed the message itself,
      // which here means both.
      display: s.promptOnly !== true,
      prompt: s.markdownOnly !== true,
      minDepth: typeof s.minDepth === 'number' && s.minDepth >= 0 ? s.minDepth : null,
      maxDepth: typeof s.maxDepth === 'number' && s.maxDepth >= 0 ? s.maxDepth : null,
      enabled: s.disabled !== true,
    };
    const ok = regexRuleSchema.safeParse(rule).success && (rule.ai || rule.user) && compileRegexRule(rule) !== null;
    if (ok) rules.push(rule); else skipped.push(name ?? find.slice(0, 40));
  }
  return { rules, skipped };
}
