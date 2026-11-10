import type { VideoModelSpec } from "../video-models.js";

/**
 * The smaller partner families through Router: Lightricks LTX, Moonvalley
 * Marey, Runway, BFL FLUX Video, Pruna P-Video and MiniMax's H3 Max Turbo.
 * Prices are Comfy's rate card (211 credits = $1, read 2026-10-09) turned into
 * mushies ($1 = 1000) and rounded up.
 */
export const MORE_VIDEO_MODELS: readonly VideoModelSpec[] = [
  {
    id: "ltx-2.5-fast", name: "LTX-2.5 Fast", provider: "comfy-router", family: "ltx", routerModel: "ltx/ltx-2-5-fast",
    aspects: ["16:9", "9:16"],
    resolutions: ["720p", "1080p", "1440p", "4K"], defaultResolution: "1080p",
    // LTX takes 2–20 s, but over 10 s only at 720p/1080p; a spec cannot tie the
    // length to the resolution, so the menu stops at 10 s for every size.
    durations: [2, 3, 4, 5, 6, 8, 10], defaultDuration: 5,
    frames: { first: false, last: false, both: false }, maxReferences: 0,
    sound: true, watermark: false, textToVideo: true, tuning: false, loras: false, styles: false, selfHosted: false,
    // Rate card 2026-10-09, credits a second whatever the sound: 27.16 (720p),
    // 39.22 (1080p), 57.33 (1440p), 90.52 (4K) = 128.7 / 185.9 / 271.7 / 429.0
    // mushies, rounded up. Both shapes are the same pixel count. A 2 s 720p
    // clip with sound took 67 s end to end (2026-10-09).
    etaSeconds: 90, perSecond: { "720p": 129, "1080p": 186, "1440p": 272, "4K": 430 },
  },
  {
    id: "ltx-2.5-pro", name: "LTX-2.5 Pro", provider: "comfy-router", family: "ltx", routerModel: "ltx/ltx-2-5-pro",
    aspects: ["16:9", "9:16"],
    resolutions: ["720p", "1080p"], defaultResolution: "1080p",
    durations: [2, 3, 4, 5, 6, 8, 10], defaultDuration: 5,
    frames: { first: false, last: false, both: false }, maxReferences: 0,
    sound: true, watermark: false, textToVideo: true, tuning: false, loras: false, styles: false, selfHosted: false,
    // Rate card 2026-10-09: 36.21 (720p) and 51.29 (1080p) credits a second =
    // 171.6 / 243.1 mushies, rounded up. A 2 s 720p 9:16 clip with sound took
    // 34 s end to end (2026-10-09).
    etaSeconds: 60, perSecond: { "720p": 172, "1080p": 244 },
  },
  {
    id: "marey", name: "Marey", provider: "comfy-router", family: "moonvalley", routerModel: "moonvalley/text-to-video",
    // 21:9 is offered for Marey's video-to-video only.
    aspects: ["16:9", "9:16", "4:3", "1:1", "3:4"],
    resolutions: ["1080p"], defaultResolution: "1080p",
    durations: [5], defaultDuration: 5,
    frames: { first: true, last: false, both: false }, maxReferences: 0,
    sound: false, watermark: false, textToVideo: true, tuning: false, loras: false, styles: false, selfHosted: false,
    // Marey is not on the 2026-10-09 rate card; Comfy's own Marey nodes charged a
    // flat $1.50 a clip (one fixed 128-frame, 5.3 s, 1080p clip) for text and
    // image alike; the account balance moved by about that (≈316 credits) per
    // run on 2026-10-09. Text and image runs took 110 s and 112 s.
    etaSeconds: 110, perClip: { "1080p": { 5: 1500 } },
  },
  {
    id: "runway-gen4-turbo", name: "Gen-4 Turbo", provider: "comfy-router", family: "runway", routerModel: "runway/gen4_turbo",
    resolutions: ["720p"], defaultResolution: "720p",
    durations: { min: 2, max: 10 }, defaultDuration: 5,
    frames: { first: true, last: false, both: false }, maxReferences: 0,
    sound: false, watermark: false, textToVideo: false, tuning: false, loras: false, styles: false, selfHosted: false,
    // Rate card 2026-10-09: 15.09 credits a second = 71.5 mushies, rounded up
    // (the comfy node's $0.0715 a second). A 2 s clip took 35 s (2026-10-09).
    etaSeconds: 60, perSecond: { "720p": 72 },
  },
  {
    id: "flux-3-video", name: "FLUX 3 Video", provider: "comfy-router", family: "flux", routerModel: "bfl/flux-3-video",
    resolutions: ["720p", "1080p"], defaultResolution: "720p",
    durations: { min: 5, max: 20 }, defaultDuration: 5,
    frames: { first: true, last: true, both: true }, maxReferences: 0,
    sound: true, watermark: false, textToVideo: true, tuning: false, loras: false, styles: false, selfHosted: false,
    // Rate card 2026-10-09, text and image to video alike, with or without
    // sound: 51.29 (720p) and 87.50 (1080p) credits a second = 243.1 / 414.7
    // mushies, rounded up. A 5 s 720p clip with sound took 57 s; with keyframes
    // 96–105 s (2026-10-09).
    etaSeconds: 70, perSecond: { "720p": 244, "1080p": 415 },
  },
  {
    id: "p-video-2", name: "P-Video 2", provider: "comfy-router", family: "pruna", routerModel: "pruna/p-video-2",
    aspects: ["16:9", "4:3", "1:1", "3:4", "9:16"],
    resolutions: ["720p", "1080p"], defaultResolution: "720p",
    durations: { min: 1, max: 20 }, defaultDuration: 5,
    frames: { first: true, last: true, both: true }, maxReferences: 0, aspectFromFrame: true,
    sound: true, watermark: false, textToVideo: true, tuning: false, loras: false, styles: false, selfHosted: false,
    // Rate card 2026-10-09: 7.54 (720p) and 15.09 (1080p) credits a second =
    // 35.7 / 71.5 mushies, billed on the finished file's length, which runs one
    // frame long (a 1 s clip is 25 frames, 1.042 s): priced at 1.042× and rounded
    // up. 1 s clips took 12 s (text) and 22–34 s (frames) on 2026-10-09.
    etaSeconds: 30, perSecond: { "720p": 38, "1080p": 75 },
  },
  {
    id: "h3-max-turbo", name: "H3 Max Turbo", provider: "comfy-router", family: "hailuo", routerModel: "fal/h3-max-turbo",
    resolutions: ["480p", "768p"], defaultResolution: "768p",
    durations: { min: 5, max: 15 }, defaultDuration: 5,
    // Router serves fal's text-to-video route only. The soundtrack is always on.
    frames: { first: false, last: false, both: false }, maxReferences: 0,
    sound: true, soundAlways: true, watermark: false, textToVideo: true, tuning: false, loras: false, styles: false, selfHosted: false,
    // Not on the 2026-10-09 rate card; Comfy's own H3 Max Turbo node prices it at
    // $0.03575 (480p) and $0.0572 (768p) a second = 35.75 / 57.2 mushies, rounded
    // up (fal's list price after its promo, ×1.43 like Comfy's other resold
    // models). 5 s clips came back in 6 s (480p) and 12 s (768p) on 2026-10-09.
    etaSeconds: 15, perSecond: { "480p": 36, "768p": 58 },
  },
];
