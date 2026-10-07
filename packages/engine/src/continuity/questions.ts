/**
 * Continuity judge — plan builder.
 *
 * Turns a world + the finished turn into one typed-question request for a
 * decision model (Jev-style: choice / score / noul with probabilities). Pure:
 * no I/O, no model calls. The server sends `plan.state` + `plan.questions`
 * and hands the answers to `applyContinuityPlan`.
 *
 * Design rules (from the 2026-09-21 evaluation):
 *  - numbers are offered every integer delta in the author's window and the
 *    caller takes the probability-weighted mean, so the result is continuous
 *    and damped rather than a coin-flip between neighbours;
 *  - deltas that would leave [min, max] are not offered at all (a maxed
 *    devotion cannot "rise");
 *  - the author's behaviorRules text IS the question — no paraphrase;
 *  - only the judged variables, the player's line and the reply are sent.
 *    No lorebook, no system prompt: unrelated context degrades the model.
 */
import type { AudioEffect, GameState, SceneImage, Variable, WorldDefinition } from "../types/index.js";
import { isContinuityEnabled, isContinuityOwned, isVariableActive } from "../state/variable-activation.js";
import { getAiAudioTracks } from "../audio/ai-audio.js";
import type { ContinuityInput, ContinuityPlan, JevQuestion, PlanVariable } from "./types.js";

export const KEEP = "__keep";
export const NONE = "__none";
/** BGM answer: none of the cued tracks fit any more — hand the music back to
 *  the card's default playlist. Offered only when the world has one. */
export const PLAYLIST = "__playlist";

const PLAYER_MAX = 1500;
const REPLY_MAX = 6000;
const RULES_MAX = 700;
const NOTE_MAX = 200;
const MAX_SFX_QUESTIONS = 12;
/** Up to this many images get their own yes/no question; a bigger pool is
 *  asked as one choice (at most one image per reply) to bound the call. */
export const MAX_IMAGE_QUESTIONS = 12;

const trim = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

function isChinese(language: string | undefined): boolean {
  return typeof language === "string" && /^zh/i.test(language);
}

/** Question wording. Chinese instructions scored higher than English on
 *  Chinese cards in the evaluation, so the world's language picks the set. */
function wording(zh: boolean) {
  return zh
    ? {
        number: (name: string, rules: string) =>
          `只看这一回合。根据 \`player\` 的行动和 \`reply\` 里发生的事，变量「${name}」（当前值 \`variables.${name}\`）应该变化多少？0 表示不变。${rules ? `作者对这个变量的规则：${rules}` : ""}`,
        boolean: (name: string, rules: string) =>
          `在 \`reply\` 结束时，变量「${name}」（当前值 \`variables.${name}\`）应该是"是"吗？${rules ? `作者规则：${rules}` : ""}`,
        booleanYes: "是",
        booleanNo: "否",
        string: (name: string, rules: string) =>
          `在 \`reply\` 结束时，变量「${name}」应该是什么？如果这一回合没有让它变化，就选"保持当前值"（当前值 \`variables.${name}\`）。${rules ? `作者规则：${rules}` : ""}`,
        keepValue: "保持当前值，这回合没有变化",
        bgm: "`reply` 这段剧情接下来该配哪首曲子？选整段的主导氛围，不是最响的一瞬间。没有更合适的就保持当前曲目。",
        keepTrack: (note: string) => `保持当前曲目${note ? `（${note}）` : ""}`,
        playlist: "这些曲子都不对味了，交回默认播放列表",
        sfx: (name: string, note: string) => `\`reply\` 里有没有发生这件事：${note}（音效「${name}」的触发条件）？`,
        sfxYes: "发生了，这回合的剧情里明确出现",
        sfxNo: "没发生，或者只是提到、回忆、计划",
        image: (name: string, rule: string) =>
          `作者给图片「${name}」写的发送条件是：${rule}
严格按这条条件判断：这一回合（\`player\` 的行动和 \`reply\` 的内容）是否满足它、这回合回复后是否应该发送这张图？条件写"每次""任何情况""总是"就表示每一回合都满足；之前发过这张图不影响判断。`,
        imageYes: "发送：这一回合满足作者写的条件",
        imageNo: "不发送：这一回合不满足作者写的条件",
        imagePick: "每个选项是一张图和作者给它写的发送条件。严格按条件判断：这一回合（`player` 的行动和 `reply` 的内容）满足哪一张图的条件，就选哪一张；条件写\"每次\"\"任何情况\"\"总是\"表示每一回合都满足；之前发过不影响判断。一张都不满足才选\"不发送\"。",
        noImage: "不发送，这一回合不满足任何一张图的条件",
      }
    : {
        number: (name: string, rules: string) =>
          `This turn only. Given \`player\`'s action and what happens in \`reply\`, by how much should the variable "${name}" (current value \`variables.${name}\`) change? 0 means unchanged.${rules ? ` The author's rule for it: ${rules}` : ""}`,
        boolean: (name: string, rules: string) =>
          `At the END of \`reply\`, should the variable "${name}" (current value \`variables.${name}\`) be true?${rules ? ` Author's rule: ${rules}` : ""}`,
        booleanYes: "true",
        booleanNo: "false",
        string: (name: string, rules: string) =>
          `At the END of \`reply\`, what should the variable "${name}" be? If nothing this turn changes it, pick "keep current value" (current value \`variables.${name}\`).${rules ? ` Author's rule: ${rules}` : ""}`,
        keepValue: "keep current value, nothing changed this turn",
        bgm: "Which track should play under `reply`? Judge the passage's dominant mood, not its loudest moment. Keep the current track unless another fits clearly better.",
        keepTrack: (note: string) => `keep the current track${note ? ` (${note})` : ""}`,
        playlist: "none of these fit any more; hand the music back to the default playlist",
        sfx: (name: string, note: string) => `Does this happen in \`reply\`: ${note} (the trigger for the sound effect "${name}")?`,
        sfxYes: "yes, it clearly happens in this turn's story",
        sfxNo: "no, or it is only mentioned, remembered or planned",
        image: (name: string, rule: string) =>
          `The author's condition for sending the image "${name}" is: ${rule}
Judge strictly by that condition: does this turn (\`player\`'s action and what happens in \`reply\`) meet it, so the image should be sent after this reply? A condition that says "every reply", "always" or "in any situation" is met on every turn; having sent the image before does not matter.`,
        imageYes: "send it: this turn meets the author's condition",
        imageNo: "don't send it: this turn does not meet the author's condition",
        imagePick: "Each option is an image and the author's condition for sending it. Judge strictly by the conditions: pick the image whose condition this turn (`player`'s action and what happens in `reply`) meets. A condition that says \"every reply\", \"always\" or \"in any situation\" is met on every turn; having sent an image before does not matter. Pick \"don't send\" only when no condition is met.",
        noImage: "don't send any, this turn meets no image's condition",
      };
}

function ruleText(v: Variable): string {
  return trim((v.behaviorRules || v.updateHints || "").trim(), RULES_MAX);
}

function deltaLabel(d: number): string {
  return d > 0 ? `+${d}` : String(d);
}

function currentBgmTrackId(state: GameState): string | undefined {
  const active = state.metadata?.activeAudio;
  if (!Array.isArray(active)) return undefined;
  for (const effect of active as AudioEffect[]) {
    if (effect && (effect.action === "play" || effect.action === "crossfade") && typeof effect.trackId === "string") return effect.trackId;
  }
  return undefined;
}

function imageInScope(img: SceneImage, activeGreetingId: string | null | undefined): boolean {
  if (!img.greetingIds || img.greetingIds.length === 0) return true;
  return typeof activeGreetingId === "string" && img.greetingIds.includes(activeGreetingId);
}

/**
 * Build the judge's request for this turn, or `null` when there is nothing
 * to ask (no owned variables, no pools, or the reply already handled it).
 */
export function buildContinuityPlan(world: WorldDefinition, state: GameState, input: ContinuityInput): ContinuityPlan | null {
  if (!isContinuityEnabled(world)) return null;
  const zh = isChinese(world.language);
  const w = wording(zh);
  const questions: Record<string, JevQuestion> = {};
  const variables: Record<string, unknown> = {};
  const vars: PlanVariable[] = [];

  for (const v of world.variables) {
    if (!isContinuityOwned(world, v)) continue;
    if (!isVariableActive(v, state, world.worldbooks)) continue;
    const key = `var__${v.id}`;
    const rules = ruleText(v);
    const raw = state.variables[v.id] ?? v.defaultValue;
    if (v.type === "number") {
      const current = typeof raw === "number" && Number.isFinite(raw) ? raw : Number(raw) || 0;
      const down = Math.max(0, Math.floor(v.deltaDown ?? 0));
      const up = Math.max(0, Math.floor(v.deltaUp ?? 0));
      const deltas: Record<string, number> = {};
      const criteria: Record<string, string> = {};
      for (let d = -down; d <= up; d++) {
        const next = current + d;
        if (typeof v.min === "number" && next < v.min) continue;
        if (typeof v.max === "number" && next > v.max) continue;
        const label = deltaLabel(d);
        deltas[label] = d;
        criteria[label] = d === 0 ? (zh ? "不变" : "unchanged") : zh ? `变化 ${label}` : `change by ${label}`;
      }
      // Pinned at a bound with no room to move: nothing to ask.
      if (Object.keys(deltas).length < 2) continue;
      questions[key] = { type: "choice", instructions: w.number(v.name, rules), criteria };
      variables[v.name] = current;
      vars.push({ key, id: v.id, kind: "number", current, deltas, min: v.min, max: v.max });
    } else if (v.type === "boolean") {
      const current = raw === true || raw === "true";
      questions[key] = { type: "noul", instructions: w.boolean(v.name, rules), criteria: { true: w.booleanYes, false: w.booleanNo } };
      variables[v.name] = current;
      vars.push({ key, id: v.id, kind: "boolean", current });
    } else if (v.type === "string") {
      const options = (v.options ?? []).map((o) => o.trim()).filter(Boolean);
      const current = typeof raw === "string" ? raw : String(raw ?? "");
      const criteria: Record<string, string> = {};
      for (const o of options) criteria[o] = o;
      criteria[KEEP] = w.keepValue;
      questions[key] = { type: "choice", instructions: w.string(v.name, rules), criteria };
      variables[v.name] = current;
      vars.push({ key, id: v.id, kind: "string", current, options });
    }
  }

  const meta: ContinuityPlan["meta"] = { vars, sfx: [] };
  const cfg = world.continuity ?? {};

  // Music, SFX and image pools need no switch: an entry joins by carrying a
  // cue. `continuity.bgm/sfx/images: false` remain as opt-outs.
  if (cfg.bgm !== false && !input.hasAudioDirective) {
    const pool = getAiAudioTracks(world.audioTracks ?? []).filter((t) => t.type === "bgm" && t.aiNote?.trim());
    if (pool.length > 0) {
      const key = "bgm";
      const currentTrackId = currentBgmTrackId(state);
      const current = pool.find((t) => t.id === currentTrackId);
      const criteria: Record<string, string> = {};
      for (const t of pool) criteria[t.id] = trim(t.aiNote!.trim(), NOTE_MAX);
      criteria[KEEP] = w.keepTrack(current ? trim(current.aiNote!.trim(), NOTE_MAX) : "");
      // The judge may also step aside: only meaningful while one of its own
      // picks is sounding and the card has a playlist to fall back to.
      const hasPlaylist = (world.bgmPlaylist?.tracks?.length ?? 0) > 0;
      if (hasPlaylist && current) criteria[PLAYLIST] = w.playlist;
      questions[key] = { type: "choice", instructions: w.bgm, criteria };
      meta.bgm = { key, currentTrackId, trackIds: pool.map((t) => t.id), overRules: cfg.music?.overRules === true, once: cfg.music?.once === true };
    }
  }

  if (cfg.sfx !== false && !input.hasAudioDirective) {
    const pool = getAiAudioTracks(world.audioTracks ?? []).filter((t) => t.type === "sfx" && t.aiNote?.trim()).slice(0, MAX_SFX_QUESTIONS);
    for (const t of pool) {
      const key = `sfx__${t.id}`;
      questions[key] = { type: "noul", instructions: w.sfx(t.name, trim(t.aiNote!.trim(), NOTE_MAX)), criteria: { true: w.sfxYes, false: w.sfxNo } };
      meta.sfx.push({ key, trackId: t.id, duck: cfg.music?.duck !== false });
    }
  }

  if (cfg.images !== false && !input.hasImageDirective) {
    const pool = (world.sceneImages ?? []).filter((img) => img.allowAiControl !== false && img.url.trim() && img.scene.trim() && imageInScope(img, state.activeGreetingId));
    // The author's one line is the image's sending CONDITION, not a scene
    // label: each image is asked on its own ("is the author's condition met
    // this turn?"), so "every reply" means every reply and the same image may
    // come back whenever its condition holds again.
    if (pool.length > 0 && pool.length <= MAX_IMAGE_QUESTIONS) {
      const entries: Array<{ key: string; id: string }> = [];
      for (const img of pool) {
        const key = `image__${img.id}`;
        const name = img.name?.trim() || img.id;
        questions[key] = { type: "noul", instructions: w.image(name, trim(img.scene.trim(), RULES_MAX)), criteria: { true: w.imageYes, false: w.imageNo } };
        entries.push({ key, id: img.id });
      }
      meta.images = { mode: "each", entries };
    } else if (pool.length > MAX_IMAGE_QUESTIONS) {
      const key = "image";
      const criteria: Record<string, string> = {};
      for (const img of pool) criteria[img.id] = trim(img.scene.trim(), NOTE_MAX);
      criteria[NONE] = w.noImage;
      questions[key] = { type: "choice", instructions: w.imagePick, criteria };
      meta.images = { mode: "choice", key, imageIds: pool.map((img) => img.id) };
    }
  }

  if (Object.keys(questions).length === 0) return null;

  const planState: Record<string, unknown> = {
    player: trim(input.playerText.trim(), PLAYER_MAX),
    reply: trim(input.replyText.trim(), REPLY_MAX),
  };
  if (vars.length > 0) planState.variables = variables;
  return { state: planState, questions, meta };
}
