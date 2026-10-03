/**
 * Voice casting for readouts: who says each line, and in whose voice.
 *
 * A reply used to be read in ONE voice — whoever the reply as a whole was
 * judged to belong to — so a werewolf table of five read like one person
 * reading a script. Here the text is cut into narration and dialogue runs,
 * Jev says who speaks each dialogue run (the card's characters, anyone this
 * session has already heard, names that turn up in the text) along with the
 * emotion cue, and each run is read in that speaker's voice:
 *
 *   the author's voice for that character  >  the voice this session already
 *   gave them  >  a voice Jev picks from the card-language pool the first time
 *   they speak (unused voices first, matched on gender/age/manner).
 *
 * The pool is the player's own voice pool (Settings › Display, stored
 * server-side as preferences.ttsVoicePool) narrowed to the card language;
 * with nothing selected, or nothing in that language, it is every catalog
 * voice of the language. More speakers than selected voices share the
 * selection rather than stepping outside it. A pool edited mid-game doesn't
 * recast anyone: a speaker keeps the voice this session already gave them.
 *
 * Narration is read in the card's narrator voice, else the player's first
 * pool voice for the card language, else the player's own.
 * Cards that spawn their cast mid-game work the same way: a name the model
 * invents is a candidate the moment it appears.
 *
 * Owner decision 2026-09-28 ("ai决定"). Kill switch: TTS_CAST=off.
 */

import { createHash } from "node:crypto";
import type { JevAnswer, JevQuestion } from "@yumina/engine";
import { TTS_VOICES, isValidTtsVoice, resolveTtsVoiceAlias, ttsPoolForLang } from "@yumina/shared";
import { decide, decisionModelConfigured } from "../continuity/jev-client.js";
import type { PlayerSideKey, SideCallKeySource } from "../side-call-key.js";
import { env } from "../env.js";
import { TTS_EMOTIONS, EMOTION_MIN_CONFIDENCE, type TtsEmotion } from "./emotion.js";

export function castingEnabled(): boolean {
  return env.TTS_CAST !== "off" && decisionModelConfigured();
}

const CAST_TIMEOUT_MS = 700;
const MAX_DIALOGUE_RUNS = 16;
const MAX_CANDIDATES = 12;
const MAX_CAST = 64;
const NARRATOR = "narrator";

/** What each curated voice sounds like, for Jev's pick. */
const VOICE_PROFILES: Record<string, string> = {
  zhGentleFemale: "年轻女性，温柔轻柔", zhMatureFemale: "成熟女性，御姐，冷艳自信", zhSweetGirl: "少女，甜美稚气",
  zhLivelyFemale: "年轻女性，活泼开朗", zhLightMatureFemale: "二三十岁女性，知性温和", zhBrightFemale: "年轻女性，明亮干脆",
  zhYoungMale: "年轻男性，清朗少年气", zhNarratorMale: "中年男性，平稳", zhBroadcastMale: "男性，字正腔圆，正式",
  zhDeepMale: "中年男性，低沉浑厚，粗犷", zhSteadyMale: "成熟男性，沉稳冷静",
  enFemale: "年轻女性，温暖", enNarratorFemale: "成熟女性，叙事感", enSoftFemale: "少女，软萌",
  enYouthfulMale: "年轻男性，有活力", enDeepMale: "中年男性，低沉", enCalmMale: "成熟男性，平静",
  jaCalmFemale: "年轻女性，沉静", jaEnergeticFemale: "少女，元气", jaBrightGirl: "少女，明朗",
  jaCalmMale: "年轻男性，沉静", jaDeepMale: "中年男性，醇厚",
  esFemale: "年轻女性，悦耳", esGirl: "少女，活力", esNarratorMale: "中年男性，叙事感",
};

// ── Pure helpers (unit-tested) ──────────────────────────────────────

export interface Run { kind: "narration" | "dialogue"; text: string }

const QUOTE_PAIRS: Record<string, string> = { "「": "」", "『": "』", "“": "”", "\"": "\"", "«": "»" };

/** Cut text into narration / dialogue runs (quotes stay with their dialogue).
 *  `allDialogue`: the text is already dialogue only, one line per run. */
export function splitRuns(text: string, allDialogue: boolean): Run[] {
  if (allDialogue) {
    return text.split(/(?<=\n)/).filter((l) => l.length > 0).map((l) => ({ kind: l.trim() ? "dialogue" : "narration", text: l }));
  }
  const runs: Run[] = [];
  let buf = "";
  let close: string | null = null;
  const push = (kind: Run["kind"]) => {
    if (!buf) return;
    const last = runs[runs.length - 1];
    if (last && last.kind === kind) last.text += buf;
    else runs.push({ kind, text: buf });
    buf = "";
  };
  for (const ch of text) {
    if (close === null && ch in QUOTE_PAIRS) {
      push("narration");
      close = QUOTE_PAIRS[ch]!;
      buf = ch;
    } else if (close !== null && ch === close) {
      buf += ch;
      push("dialogue");
      close = null;
    } else {
      buf += ch;
    }
  }
  push(close !== null ? "dialogue" : "narration");
  return runs;
}

const NOT_NAMES = new Set(["他", "她", "我", "你", "它", "他们", "她们", "我们", "你们", "大家", "有人", "众人", "对方", "两人", "那人", "此人", "旁白", "声音", "所有人", "一个人"]);

const PRONOUN_START = new Set([..."他她我你它咱"]);
const ACTION_START = new Set([..."拍看站抬低冷笑大小轻说道喊问叹吼皱点摇放走转盯瞪咬握靠坐起把将一又也还便就突忽缓慢淡沉压挑扫眯眨深哼嗤急连猛终只却才正边对朝向在"]);

/** 角落里的卖花女突然开口 → 卖花女, 老猎户拍着桌子 → 老猎户, 铁匠冷笑一声 → 铁匠:
 *  after the last 的, the 2–4 character head that ends where the first
 *  action begins (or the whole clause when it is already that short). */
function leadingName(clauseText: string): string {
  const tail = clauseText.includes("的") ? clauseText.slice(clauseText.lastIndexOf("的") + 1) : clauseText;
  if (PRONOUN_START.has(tail[0] ?? "")) return "";
  for (let n = 2; n <= Math.min(4, tail.length - 1); n++) {
    if (ACTION_START.has(tail[n]!)) return tail.slice(0, n);
  }
  return tail.length <= 4 ? tail : "";
}

/** Names the text itself attributes speech to: 「名字：」, 【名字】, 名字说…「. */
export function detectSpeakerNames(text: string): string[] {
  const found: string[] = [];
  const add = (raw: string | undefined) => {
    const name = (raw ?? "").trim().replace(/^[*_]+|[*_]+$/g, "");
    if (!name || name.length > 8 || NOT_NAMES.has(name) || /^\d+$/.test(name)) return;
    if (!found.includes(name)) found.push(name);
  };
  for (const m of text.matchAll(/(?:^|\n)\s*[*_]*([\p{Script=Han}\p{L}\d·]{1,8})[*_]*\s*[：:]/gu)) {
    // 铁匠冷笑一声：「…」 is a speech clause, not a 「Name:」 label.
    const label = m[1]!;
    add(/^\p{Script=Han}+$/u.test(label) && label.length > 4 ? leadingName(label) : label);
  }
  for (const m of text.matchAll(/【([^【】\n]{1,8})】/g)) add(m[1]);
  // 老猎户拍着桌子站起来：「…」 / 绣娘低着头，小声说：「…」 — the clause right
  // before a quote (commas included) usually opens with who is speaking; take
  // its 2–4 character head up to where the action starts. Chinese has no
  // spaces, so this is a heuristic: it only adds candidates, and Jev still
  // decides who said what.
  for (const m of text.matchAll(/(?:^|[\n。！？!?…」”』])\s*([\p{Script=Han}·\d，,、]{1,20}?)[：:，,]?\s*[「“『]/gu)) {
    add(leadingName(m[1]!.replace(/^[，,、]+/, "")));
  }
  for (const m of text.matchAll(/[”"」]\s*[,，]?\s*([A-Z][a-z]{1,15})\s+(?:said|says|asked|whispered|shouted|replied)/g)) add(m[1]);
  return found;
}

/** The language a card reads in: its declared language, else the text's script. */
export function cardLang(language: string | null | undefined, sample: string): string {
  const lang = (language ?? "").toLowerCase().slice(0, 2);
  if (["zh", "en", "ja", "es"].includes(lang)) return lang;
  return /[぀-ヿ]/.test(sample) ? "ja" : /[㐀-鿿]/.test(sample) ? "zh" : "en";
}

/** A custom (non-catalog) voice the player added: Jev knows nothing about it. */
const CUSTOM_VOICE_PROFILE = "玩家自己添加的声音";

/** Voices casting may hand out for this card: the player's selection in the
 *  card language, or (nothing selected / nothing in that language) every
 *  catalog voice of the language. */
export function poolFor(
  language: string | null | undefined,
  sample: string,
  selection: readonly string[] = [],
): Array<{ id: string; profile: string }> {
  const lang = cardLang(language, sample);
  const picked = ttsPoolForLang(selection, lang).map((id) => {
    const v = TTS_VOICES.find((x) => x.id === id);
    return { id, profile: v ? VOICE_PROFILES[v.labelKey] ?? v.gender : CUSTOM_VOICE_PROFILE };
  });
  if (picked.length > 0) return picked;
  return TTS_VOICES.filter((v) => v.lang === lang).map((v) => ({ id: v.id, profile: VOICE_PROFILES[v.labelKey] ?? v.gender }));
}

/** Which pool voices new speakers may get: unused ones while enough are left;
 *  otherwise the whole pool except the narrator's voice; and when that leaves
 *  nothing (a one-voice pool that also narrates), the pool itself. Speakers
 *  share inside the pool, never stepping outside it. */
export function castingChoices<T extends { id: string }>(
  pool: T[],
  used: ReadonlySet<string>,
  narratorVoice: string | undefined,
  needed: number,
): T[] {
  const unused = pool.filter((v) => !used.has(v.id));
  if (unused.length >= needed) return unused;
  const notNarrator = pool.filter((v) => v.id !== narratorVoice);
  return notNarrator.length > 0 ? notNarrator : pool;
}

/** Resolve assignment picks so two new speakers never land on one voice
 *  while an unused one is left; probabilities decide who gets first pick. */
export function resolveAssignments(
  picks: Array<{ name: string; probabilities: Record<string, number> }>,
  available: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  const taken = new Set<string>();
  const order = [...picks].sort((a, b) => Math.max(0, ...Object.values(b.probabilities)) - Math.max(0, ...Object.values(a.probabilities)));
  for (const p of order) {
    const ranked = Object.entries(p.probabilities).sort((a, b) => b[1] - a[1]).map(([k]) => k).filter((k) => available.includes(k));
    const choice = ranked.find((k) => !taken.has(k)) ?? ranked[0] ?? stablePick(p.name, available);
    if (choice) { out[p.name] = choice; taken.add(choice); }
  }
  return out;
}

export function stablePick(name: string, ids: string[]): string | undefined {
  if (ids.length === 0) return undefined;
  const h = createHash("sha256").update(name).digest();
  return ids[h.readUInt32BE(0) % ids.length];
}

function cueFor(a: JevAnswer | undefined): string {
  const choice = a?.choice as TtsEmotion | undefined;
  if (!choice || !(choice in TTS_EMOTIONS)) return "";
  const confidence = a?.confidence ?? a?.probabilities?.[choice] ?? 0;
  return confidence >= EMOTION_MIN_CONFIDENCE ? TTS_EMOTIONS[choice].cue : "";
}

/** Consecutive runs in one voice become one synth segment. */
export function mergeSegments(runs: Array<{ voice: string | undefined; plain: string; spoken: string }>) {
  const out: Array<{ voice: string | undefined; plain: string; spoken: string }> = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && last.voice === r.voice) { last.plain += r.plain; last.spoken += r.spoken; }
    else out.push({ ...r });
  }
  return out.filter((s) => s.plain.trim().length > 0);
}

// ── Planning ────────────────────────────────────────────────────────

export interface CastWorld {
  entries: Array<{ name: string; role?: string; enabled?: boolean; content?: string; voice?: string | null }>;
  narratorVoice?: string | null;
  language?: string | null;
}

export interface ReadoutPlan {
  segments: Array<{ voice: string | undefined; plain: string; spoken: string }>;
  cast: Record<string, string>;
  usage: Array<{ inputTokens: number; outputTokens: number; model: string; ms: number; keySource: SideCallKeySource }>;
}

const validVoice = (v: unknown): string | undefined =>
  typeof v === "string" && isValidTtsVoice(v) ? resolveTtsVoiceAlias(v) : undefined;

export async function planReadout(opts: {
  text: string;
  context?: string;
  allDialogue: boolean;
  world: CastWorld;
  playerVoice?: string;
  /** The player's voice pool, from their stored preferences (never the request). */
  playerPool?: readonly string[];
  cast: Record<string, string>;
  emotion: boolean;
  /** The player's own OpenRouter key (BYOK readouts); falls back to the platform's. */
  playerKey?: PlayerSideKey | null;
}): Promise<ReadoutPlan> {
  const usage: ReadoutPlan["usage"] = [];
  const scene = `${opts.context ?? ""}\n${opts.text}`;
  const selection = opts.playerPool ?? [];
  // The player's own voice for this card: their first pool voice in its language.
  const playerOwn = ttsPoolForLang(selection, cardLang(opts.world.language, scene))[0] ?? opts.playerVoice;
  const narratorVoice = validVoice(opts.world.narratorVoice) ?? playerOwn;
  const characters = opts.world.entries.filter((e) => e.role === "character" && e.enabled !== false && e.name.trim());
  const entryVoice = new Map(characters.map((e) => [e.name.trim(), validVoice(e.voice)]));
  const cast: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.cast)) { const id = validVoice(v); if (id && k.trim()) cast[k.trim()] = id; }

  const runs = splitRuns(opts.text, opts.allDialogue);
  const candidates: string[] = [];
  for (const n of [...characters.map((e) => e.name.trim()), ...Object.keys(cast), ...detectSpeakerNames(scene)]) {
    if (!candidates.includes(n) && candidates.length < MAX_CANDIDATES) candidates.push(n);
  }
  const describe = (name: string) => {
    const e = characters.find((c) => c.name.trim() === name);
    return e?.content ? `${name}。${e.content.replace(/\s+/g, " ").slice(0, 80)}` : `${name}（在这段文字里出现的人物）`;
  };

  const dialogueIdx = runs.map((r, i) => (r.kind === "dialogue" && r.text.trim() ? i : -1)).filter((i) => i >= 0).slice(0, MAX_DIALOGUE_RUNS);
  const questions: Record<string, JevQuestion> = {};
  const lines: Record<string, string> = {};
  const emotionCriteria = Object.fromEntries(Object.entries(TTS_EMOTIONS).map(([k, v]) => [k, v.criteria]));
  const speakerCriteria: Record<string, string> = { [NARRATOR]: "不是任何具体人物说出口的话（叙述、心声、旁白）" };
  candidates.forEach((n, i) => { speakerCriteria[`c${i}`] = describe(n); });
  for (const i of dialogueIdx) {
    lines[`第${i + 1}段`] = runs[i]!.text.trim();
    if (candidates.length > 1) {
      questions[`s${i}`] = { type: "choice", instructions: `第${i + 1}段台词是谁说的？看引号前后的叙述和说话内容判断。有引语就选说话的那个人物。`, criteria: speakerCriteria };
    }
    if (opts.emotion) {
      questions[`e${i}`] = { type: "choice", instructions: `第${i + 1}段台词应该用什么情绪念出来？结合场景判断说话人此刻的真实情绪，不要只看字面。`, criteria: emotionCriteria };
    }
  }

  let answers: Record<string, JevAnswer | undefined> = {};
  if (Object.keys(questions).length > 0) {
    try {
      const res = await decide({ state: { 场景: scene.trim().slice(-1500), 台词: lines }, questions, timeoutMs: CAST_TIMEOUT_MS, playerKey: opts.playerKey });
      answers = res.answers;
      usage.push({ ...res.usage, model: res.model, ms: res.ms, keySource: res.keySource });
    } catch (err) {
      console.warn("[TTS] casting skipped:", err instanceof Error ? err.message.slice(0, 160) : err);
    }
  }

  // Who speaks each dialogue run. One candidate = no question needed; an
  // unsure answer keeps the previous speaker (a character rarely hands the
  // floor over mid-reply without the text saying so).
  const speakerOf = new Map<number, string | null>();
  let previous: string | null = candidates.length === 1 ? candidates[0]! : null;
  for (const i of dialogueIdx) {
    let who: string | null = previous;
    if (candidates.length === 1) who = candidates[0]!;
    const a = answers[`s${i}`];
    if (a?.choice) {
      const conf = a.confidence ?? a.probabilities?.[a.choice] ?? 0;
      if (conf >= 0.5 || previous === null) who = a.choice === NARRATOR ? null : candidates[Number(a.choice.slice(1))] ?? previous;
    }
    speakerOf.set(i, who);
    if (who) previous = who;
  }

  // First line from someone with no voice yet: Jev casts them from the pool.
  // One character on stage (a 1:1 card): the voice the player picked is the
  // voice they meant for her — no recasting.
  const solo = candidates.length === 1 ? candidates[0]! : null;
  const needVoice = solo ? [] : [...new Set([...speakerOf.values()].filter((n): n is string => !!n && !entryVoice.get(n) && !cast[n]))];
  if (needVoice.length > 0) {
    const used = new Set<string>([...Object.values(cast), ...[...entryVoice.values()].filter((v): v is string => !!v), ...(narratorVoice ? [narratorVoice] : [])]);
    const available = castingChoices(poolFor(opts.world.language, scene, selection), used, narratorVoice, needVoice.length);
    const ids = available.map((v) => v.id);
    const picks: Array<{ name: string; probabilities: Record<string, number> }> = [];
    if (ids.length > 0) {
      const aq: Record<string, JevQuestion> = {};
      const criteria = Object.fromEntries(available.map((v) => [v.id, v.profile]));
      needVoice.forEach((name, k) => {
        aq[`a${k}`] = { type: "choice", instructions: `「${name}」最适合用哪种声音？按这个人物的性别、年龄和说话气质选。`, criteria };
      });
      const said = Object.fromEntries(needVoice.map((name) => [name, dialogueIdx.filter((i) => speakerOf.get(i) === name).map((i) => runs[i]!.text.trim()).join(" / ").slice(0, 300)]));
      try {
        const res = await decide({ state: { 场景: scene.trim().slice(-1200), 人物: Object.fromEntries(needVoice.map((n) => [n, describe(n)])), 各自的台词: said }, questions: aq, timeoutMs: CAST_TIMEOUT_MS, playerKey: opts.playerKey });
        usage.push({ ...res.usage, model: res.model, ms: res.ms, keySource: res.keySource });
        needVoice.forEach((name, k) => {
          const a = res.answers[`a${k}`];
          picks.push({ name, probabilities: a?.probabilities ?? (a?.choice ? { [a.choice]: 1 } : {}) });
        });
      } catch (err) {
        console.warn("[TTS] voice pick skipped:", err instanceof Error ? err.message.slice(0, 160) : err);
        needVoice.forEach((name) => picks.push({ name, probabilities: {} }));
      }
      Object.assign(cast, resolveAssignments(picks, ids));
    }
  }

  const voiceOf = (name: string | null) => {
    if (!name) return narratorVoice;
    if (name === solo) return entryVoice.get(name) ?? playerOwn ?? narratorVoice;
    return entryVoice.get(name) ?? cast[name] ?? narratorVoice;
  };
  const planned = runs.map((r, i) => {
    if (r.kind !== "dialogue" || !speakerOf.has(i)) return { voice: narratorVoice, plain: r.text, spoken: r.text };
    const cue = cueFor(answers[`e${i}`]);
    const lead = r.text.match(/^\s*/)![0];
    const body = r.text.slice(lead.length);
    const space = cue && /^[A-Za-z0-9"'“]/.test(body) ? " " : "";
    return { voice: voiceOf(speakerOf.get(i) ?? null), plain: r.text, spoken: cue ? lead + cue + space + body : r.text };
  });

  const trimmedCast = Object.fromEntries(Object.entries(cast).slice(-MAX_CAST));
  return { segments: mergeSegments(planned), cast: trimmedCast, usage };
}
