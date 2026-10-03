import type { AudioEffect, Effect } from "../types/index.js";

/** A question in the decision model's typed-question protocol (Jev / Laya). */
export type JevQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } };

/** One answer as the decision model returns it. Fields depend on the type. */
export interface JevAnswer {
  type?: "choice" | "score" | "noul";
  choice?: string;
  probabilities?: Record<string, number>;
  confidence?: number;
  noul?: number;
  score?: number;
}

/** What the judge remembers between turns (lives in GameState.metadata.continuity). */
export interface ContinuityMemory {
  lastBgmTurn?: number;
  lastBgmTrack?: string;
  lastImageTurn?: number;
  lastImage?: string;
  /** trackId → turn the SFX last fired. */
  sfxTurns?: Record<string, number>;
}

/** Everything the plan builder needs from the turn. */
export interface ContinuityInput {
  /** The player's message this turn (trimmed by the builder). */
  playerText: string;
  /** The model's reply, after directive parsing (trimmed by the builder). */
  replyText: string;
  turnCount: number;
  memory: ContinuityMemory;
  /** The reply already carries its own `[image: …]` — skip the image question. */
  hasImageDirective: boolean;
  /** The reply already carries its own `[audio: …]` — skip music/SFX questions. */
  hasAudioDirective: boolean;
}

export interface PlanVariable {
  key: string;
  id: string;
  kind: "number" | "boolean" | "string";
  current: number | boolean | string;
  /** number: label → delta */
  deltas?: Record<string, number>;
  min?: number;
  max?: number;
  /** string: allowed values */
  options?: string[];
}

export interface ContinuityPlan {
  /** The `state` object sent to the decision model. */
  state: Record<string, unknown>;
  questions: Record<string, JevQuestion>;
  meta: {
    vars: PlanVariable[];
    bgm?: { key: string; currentTrackId?: string; trackIds: string[]; overRules: boolean; once: boolean };
    sfx: Array<{ key: string; trackId: string; duck: boolean }>;
    /** Scene images. Each image's `scene` text is the author's CONDITION for
     *  sending it. Small pools ask one yes/no question per image ("each");
     *  pools larger than the question cap ask one choice over all ("choice"). */
    images?:
      | { mode: "each"; entries: Array<{ key: string; id: string }> }
      | { mode: "choice"; key: string; imageIds: string[] };
  };
}

export interface ContinuityDecision {
  key: string;
  kind: "number" | "boolean" | "string" | "bgm" | "sfx" | "image";
  chosen: string | number | boolean | null;
  confidence: number;
  applied: boolean;
  reason?: string;
}

export interface ContinuityResult {
  effects: Effect[];
  audioEffects: AudioEffect[];
  /** Scene images whose author condition this reply met, in pool order. */
  imageIds: string[];
  memory: ContinuityMemory;
  decisions: ContinuityDecision[];
}
