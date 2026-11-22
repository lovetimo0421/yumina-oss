/**
 * Messages between runner.ts and worker.ts, and the shared "pattern clock" they both read.
 *
 * Clock layout (one SharedArrayBuffer per worker):
 *   Int32[0]   1 while a card pattern is being evaluated, else 0
 *   Int32[1]   length of that pattern's source in the key area
 *   Float64[1] Date.now() when the evaluation started (byte offset 8)
 *   Uint16[8…] the pattern's source, UTF-16, at most CLOCK_KEY_MAX units (byte offset 16)
 */
import type { MarkerPattern } from "../card-translate-literals.js";

export const CLOCK_RUNNING = 0;
export const CLOCK_KEY_LENGTH = 1;
export const CLOCK_KEY_MAX = 4096;
export const CLOCK_BYTES = 16 + CLOCK_KEY_MAX * 2;

export type PatternJobBody =
  | { op: "literals"; schema: Record<string, unknown>; skip: string[]; skipAll: boolean }
  | { op: "markers"; texts: Array<{ text: string; facing: boolean }>; patterns: MarkerPattern[] }
  | { op: "check"; src: string; out: string; patterns: MarkerPattern[]; opening: boolean }
  | { op: "restore"; src: string; out: string; patterns: MarkerPattern[]; keys: string[]; opening: boolean };
export type PatternJob = PatternJobBody & { id: number };

export type PatternOutcome = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string };

/** What the "check" job returns: patterns the translation matches less often than the source, and lost markers. */
export interface PatternCheck { lost: Array<{ src: string; sample?: string }>; markers: string[] }
