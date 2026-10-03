/**
 * Continuity judge — answer application.
 *
 * Pure. Takes the plan and the decision model's answers and produces the
 * state effects, audio effects and scene image to apply, plus the memory to
 * carry to the next turn. Every rule that decides "did the judge have enough
 * confidence to act" lives here, so it is unit-testable without a model.
 */
import type { AudioEffect, Effect } from "../types/index.js";
import { KEEP, NONE, PLAYLIST } from "./questions.js";
import type { ContinuityDecision, ContinuityMemory, ContinuityPlan, ContinuityResult, JevAnswer } from "./types.js";

export const CONTINUITY_THRESHOLDS = {
  /** Direction mass (sum of probabilities on the winning side of 0) a numeric
   *  change needs before it is applied. Below it the variable stays put. */
  numberDirection: 0.8,
  /** Below this absolute weighted delta a number is treated as unchanged. */
  numberMinDelta: 0.5,
  /** P(true) at or above → true; at or below (1 − this) → false; otherwise keep. */
  boolean: 0.8,
  /** Confidence a string choice needs before it overwrites the value. */
  string: 0.8,
  /** BGM / image: the chosen option's probability. */
  poolPick: 0.5,
  /** BGM / image: how far the pick must lead "keep / none" (the model drifts
   *  ±0.04 between identical requests; without a margin it flip-flops). */
  poolMargin: 0.15,
  /** Turns that must pass before the judge switches BGM again. */
  poolCooldownTurns: 2,
  /** Scene images: P(true) an image's "author condition met" question needs.
   *  No cooldown and no "not the same image twice": the author's condition
   *  alone decides, so "send this after every reply" sends it every reply. */
  imageCondition: 0.7,
  /** P(true) a one-shot SFX needs. */
  sfx: 0.9,
  /** Turns before the same SFX may fire again. */
  sfxCooldownTurns: 3,
  /** Crossfade length (seconds) for judge-picked BGM. */
  bgmFadeSeconds: 2,
} as const;

function probs(a: JevAnswer | undefined): Record<string, number> {
  const p = a?.probabilities;
  if (!p || typeof p !== "object") return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(p)) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  return out;
}

function pickTop(p: Record<string, number>, fallback?: string): { key: string | undefined; prob: number } {
  let key: string | undefined = fallback;
  let prob = fallback ? p[fallback] ?? 0 : -1;
  for (const [k, v] of Object.entries(p)) if (v > prob) { key = k; prob = v; }
  return { key, prob: Math.max(prob, 0) };
}

const clamp = (n: number, min?: number, max?: number) => {
  let x = n;
  if (typeof min === "number") x = Math.max(min, x);
  if (typeof max === "number") x = Math.min(max, x);
  return x;
};

export function applyContinuityPlan(
  plan: ContinuityPlan,
  answers: Record<string, JevAnswer | undefined>,
  turnCount: number,
  memory: ContinuityMemory,
  thresholds: typeof CONTINUITY_THRESHOLDS = CONTINUITY_THRESHOLDS,
): ContinuityResult {
  const effects: Effect[] = [];
  const audioEffects: AudioEffect[] = [];
  const decisions: ContinuityDecision[] = [];
  const next: ContinuityMemory = { ...memory, sfxTurns: { ...(memory.sfxTurns ?? {}) } };
  const imageIds: string[] = [];

  for (const v of plan.meta.vars) {
    const a = answers[v.key];
    if (!a) { decisions.push({ key: v.key, kind: v.kind, chosen: null, confidence: 0, applied: false, reason: "no-answer" }); continue; }
    if (v.kind === "number") {
      const p = probs(a);
      const deltas = v.deltas ?? {};
      let expected = 0, mass = 0, up = 0, down = 0;
      for (const [label, d] of Object.entries(deltas)) {
        const pr = p[label] ?? 0;
        expected += pr * d; mass += pr;
        if (d > 0) up += pr; else if (d < 0) down += pr;
      }
      if (mass > 0) expected /= mass;
      const direction = expected > 0 ? up : expected < 0 ? down : 0;
      const delta = Math.round(expected);
      const applied = Math.abs(expected) >= thresholds.numberMinDelta && direction >= thresholds.numberDirection && delta !== 0;
      if (applied) {
        const value = clamp((v.current as number) + delta, v.min, v.max);
        if (value !== v.current) effects.push({ variableId: v.id, operation: "set", value });
      }
      decisions.push({ key: v.key, kind: "number", chosen: delta, confidence: +direction.toFixed(3), applied, reason: applied ? undefined : "below-threshold" });
    } else if (v.kind === "boolean") {
      const p = typeof a.noul === "number" ? a.noul : 0.5;
      let target: boolean | null = null;
      if (p >= thresholds.boolean) target = true;
      else if (p <= 1 - thresholds.boolean) target = false;
      const applied = target !== null && target !== v.current;
      if (applied) effects.push({ variableId: v.id, operation: "set", value: target as boolean });
      decisions.push({ key: v.key, kind: "boolean", chosen: target, confidence: +Math.max(p, 1 - p).toFixed(3), applied, reason: applied ? undefined : target === null ? "below-threshold" : "unchanged" });
    } else {
      const p = probs(a);
      const { key, prob } = pickTop(p, typeof a.choice === "string" ? a.choice : undefined);
      const conf = typeof a.confidence === "number" ? a.confidence : prob;
      const valid = key !== undefined && key !== KEEP && (v.options ?? []).includes(key);
      const applied = valid && conf >= thresholds.string && key !== v.current;
      if (applied) effects.push({ variableId: v.id, operation: "set", value: key as string });
      decisions.push({ key: v.key, kind: "string", chosen: key ?? null, confidence: +conf.toFixed(3), applied, reason: applied ? undefined : key === KEEP ? "keep" : valid ? "below-threshold" : "unchanged" });
    }
  }

  if (plan.meta.bgm) {
    const { key, currentTrackId, trackIds, overRules, once } = plan.meta.bgm;
    const a = answers[key];
    const p = probs(a);
    const { key: pick, prob } = pickTop(p, typeof a?.choice === "string" ? a.choice : undefined);
    const keepProb = p[KEEP] ?? 0;
    const sinceSwitch = turnCount - (memory.lastBgmTurn ?? -Infinity);
    const isTrack = pick !== undefined && trackIds.includes(pick);
    const confident = prob >= thresholds.poolPick && prob - keepProb >= thresholds.poolMargin && sinceSwitch >= thresholds.poolCooldownTurns;
    // Hand-back: the judge's own track is sounding and nothing cued fits any
    // more. A tagged `stop` lets the player resume its default playlist.
    const handBack = pick === PLAYLIST && currentTrackId !== undefined && trackIds.includes(currentTrackId) && confident;
    const applied = handBack || (isTrack && pick !== currentTrackId && confident);
    if (handBack) {
      audioEffects.push({ trackId: currentTrackId as string, action: "stop", fadeDuration: thresholds.bgmFadeSeconds, source: "continuity" });
      next.lastBgmTurn = turnCount;
      next.lastBgmTrack = undefined;
    } else if (applied) {
      // The author's choices ride on the effect: whether this pick may take
      // the channel from an active rule, and whether it plays once (the
      // playlist resumes when it ends) or loops until the judge moves on.
      audioEffects.push({
        trackId: pick as string, action: "crossfade", fadeDuration: thresholds.bgmFadeSeconds, source: "continuity",
        ...(overRules ? { overRules: true } : {}),
        ...(once ? { loop: false } : {}),
      });
      next.lastBgmTurn = turnCount;
      next.lastBgmTrack = pick;
    }
    decisions.push({ key, kind: "bgm", chosen: pick ?? null, confidence: +prob.toFixed(3), applied, reason: applied ? undefined : !isTrack && pick !== PLAYLIST ? "keep" : pick === currentTrackId ? "same-track" : sinceSwitch < thresholds.poolCooldownTurns ? "cooldown" : "below-threshold" });
  }

  for (const s of plan.meta.sfx) {
    const a = answers[s.key];
    const p = typeof a?.noul === "number" ? a.noul : 0;
    const last = next.sfxTurns![s.trackId];
    const cooled = last === undefined || turnCount - last >= thresholds.sfxCooldownTurns;
    const applied = p >= thresholds.sfx && cooled;
    if (applied) {
      // One-shot over the music: the player ducks BGM while it sounds and
      // restores it on end, so the cue never leaves the music muted.
      audioEffects.push({ trackId: s.trackId, action: "play", source: "continuity", duckBgm: s.duck });
      next.sfxTurns![s.trackId] = turnCount;
    }
    decisions.push({ key: s.key, kind: "sfx", chosen: p >= thresholds.sfx, confidence: +p.toFixed(3), applied, reason: applied ? undefined : !cooled ? "cooldown" : "below-threshold" });
  }

  if (plan.meta.images?.mode === "each") {
    for (const { key, id } of plan.meta.images.entries) {
      const a = answers[key];
      const p = typeof a?.noul === "number" ? a.noul : 0;
      const applied = p >= thresholds.imageCondition;
      if (applied) imageIds.push(id);
      decisions.push({ key, kind: "image", chosen: id, confidence: +p.toFixed(3), applied, reason: applied ? undefined : a ? "condition-not-met" : "no-answer" });
    }
  } else if (plan.meta.images?.mode === "choice") {
    const { key, imageIds: pool } = plan.meta.images;
    const a = answers[key];
    const p = probs(a);
    const { key: pick, prob } = pickTop(p, typeof a?.choice === "string" ? a.choice : undefined);
    const noneProb = p[NONE] ?? 0;
    const isImage = pick !== undefined && pool.includes(pick);
    const applied = isImage && prob >= thresholds.poolPick && prob - noneProb >= thresholds.poolMargin;
    if (applied) imageIds.push(pick as string);
    decisions.push({ key, kind: "image", chosen: pick ?? null, confidence: +prob.toFixed(3), applied, reason: applied ? undefined : !isImage ? "none" : "below-threshold" });
  }
  if (imageIds.length > 0) {
    next.lastImageTurn = turnCount;
    next.lastImage = imageIds[imageIds.length - 1];
  }

  return { effects, audioEffects, imageIds, memory: next, decisions };
}
