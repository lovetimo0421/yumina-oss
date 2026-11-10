import type { VideoModelSpec } from "../video-models.js";

/**
 * Kuaishou Kling on Kling's own API, through Router (kling/*).
 *
 * Comfy bills Kling per output second by model, mode and sound (rate card
 * 2026-10-09, 211 credits = $1); "std" is 720p and "pro" 1080p. Per second:
 *   kling-v3-omni   720p 17.72 (sound 23.63) · 1080p 23.63 (sound 29.54)
 *   kling-video-o1  720p 17.72 · 1080p 23.63 (no sound)
 *   kling-v3        720p 17.72 (sound 26.59) · 1080p 23.63 (sound 35.45)
 *   kling-3.0-turbo 720p 23.63 · 1080p 29.54 (sound always on)
 *   kling-v2-6      14.77 (sound 29.54), pro only
 *   kling-v2-5-turbo 73.85 a 5 s run, 147.7 a 10 s run, pro only
 * Aspect ratio and images (frames, references) do not change the rate, so the
 * mushie rates below are those credits ÷ 211 × 1000, rounded up. Every line is
 * Kling's own unit price (29.54 credits = $0.14 a unit), and the finished task
 * reports its units: 2026-10-09 runs billed v3 720p 3 s 1.8 units ($0.252, we
 * charge 252), v3-omni 720p 3 s with sound and a reference 2.4 ($0.336 / 336),
 * O1 720p 5 s 3 ($0.42 / 420), 3.0 Turbo 720p 3 s 2.4 ($0.336 / 336), v2.6 and
 * v2.5 Turbo 1080p 5 s 2.5 ($0.35 / 350).
 * Router's mode enum is std/pro only (mode "4k" is a 422), so the 4K tier
 * (88.62/s) is not offered. Waits are end-to-end smoke runs on 2026-10-09,
 * scaled to 5 s; Kling's queue varies a lot (3 s omni clips took 57–192 s).
 */
export const KLING_VIDEO_MODELS: readonly VideoModelSpec[] = [
  {
    // Text, a first frame (+ last frame), or up to 7 reference images, on the
    // omni-video route. End frame with references is refused by Kling, so
    // references are their own mode. An end frame alone is refused too (Router
    // 400 invalid_input on the result, unbilled): the spec has no way to say
    // "last needs first", so that request fails and is refunded.
    id: "kling-3-omni", name: "Kling 3.0 Omni", provider: "comfy-router", family: "kling", routerModel: "kling/kling-v3-omni",
    aspects: ["16:9", "9:16", "1:1"],
    resolutions: ["720p", "1080p"], defaultResolution: "720p",
    durations: { min: 3, max: 15 }, defaultDuration: 5,
    // Kling refuses an end frame alone, and references with an end frame; a
    // first frame may bring up to 6 references (7 pictures in all).
    frames: { first: true, last: true, both: true, lastNeedsFirst: true }, maxReferences: 7,
    referencesWithoutFrames: true, referencesWithFirstFrame: 6, aspectFromFrame: true,
    sound: true, watermark: true, textToVideo: true, tuning: false, loras: false, styles: false, selfHosted: false,
    etaSeconds: 200,
    perSecond: { "720p": 84, "1080p": 112 }, perSecondSound: { "720p": 112, "1080p": 140 },
  },
  {
    id: "kling-3", name: "Kling 3.0", provider: "comfy-router", family: "kling", routerModel: "kling/kling-v3",
    aspects: ["16:9", "9:16", "1:1"],
    resolutions: ["720p", "1080p"], defaultResolution: "720p",
    durations: { min: 3, max: 15 }, defaultDuration: 5,
    // Router serves Kling 3.0 as text-to-video only (no image route).
    frames: { first: false, last: false, both: false }, maxReferences: 0,
    sound: true, watermark: true, textToVideo: true, tuning: false, loras: false, styles: false, selfHosted: false,
    etaSeconds: 190,
    perSecond: { "720p": 84, "1080p": 112 }, perSecondSound: { "720p": 127, "1080p": 169 },
  },
  {
    id: "kling-3-turbo", name: "Kling 3.0 Turbo", provider: "comfy-router", family: "kling", routerModel: "kling/kling-3.0-turbo",
    aspects: ["16:9", "9:16", "1:1"],
    resolutions: ["720p", "1080p"], defaultResolution: "720p",
    durations: { min: 3, max: 15 }, defaultDuration: 5,
    frames: { first: false, last: false, both: false }, maxReferences: 0,
    sound: true, soundAlways: true, watermark: true, textToVideo: true, tuning: false, loras: false, styles: false, selfHosted: false,
    etaSeconds: 185,
    perSecond: { "720p": 112, "1080p": 140 },
  },
  {
    // Kling O1: 5 or 10 s, no sound, no 4K.
    id: "kling-o1", name: "Kling O1", provider: "comfy-router", family: "kling", routerModel: "kling/kling-video-o1",
    aspects: ["16:9", "9:16", "1:1"],
    resolutions: ["720p", "1080p"], defaultResolution: "720p",
    durations: [5, 10], defaultDuration: 5,
    // Kling refuses an end frame alone, and references with an end frame; a
    // first frame may bring up to 6 references (7 pictures in all).
    frames: { first: true, last: true, both: true, lastNeedsFirst: true }, maxReferences: 7,
    referencesWithoutFrames: true, referencesWithFirstFrame: 6, aspectFromFrame: true,
    sound: false, watermark: true, textToVideo: true, tuning: false, loras: false, styles: false, selfHosted: false,
    etaSeconds: 60,
    perSecond: { "720p": 84, "1080p": 112 },
  },
  {
    id: "kling-2.6", name: "Kling 2.6", provider: "comfy-router", family: "kling", routerModel: "kling/kling-v2-6",
    aspects: ["16:9", "9:16", "1:1"],
    resolutions: ["1080p"], defaultResolution: "1080p",
    durations: [5, 10], defaultDuration: 5,
    frames: { first: false, last: false, both: false }, maxReferences: 0,
    sound: true, watermark: true, textToVideo: true, tuning: false, loras: false, styles: false, selfHosted: false,
    etaSeconds: 130,
    perSecond: { "1080p": 70 }, perSecondSound: { "1080p": 140 },
  },
  {
    id: "kling-2.5-turbo", name: "Kling 2.5 Turbo", provider: "comfy-router", family: "kling", routerModel: "kling/kling-v2-5-turbo",
    aspects: ["16:9", "9:16", "1:1"],
    resolutions: ["1080p"], defaultResolution: "1080p",
    durations: [5, 10], defaultDuration: 5,
    frames: { first: false, last: false, both: false }, maxReferences: 0,
    sound: false, watermark: true, textToVideo: true, tuning: false, loras: false, styles: false, selfHosted: false,
    etaSeconds: 160,
    perClip: { "1080p": { 5: 350, 10: 700 } },
  },
];
