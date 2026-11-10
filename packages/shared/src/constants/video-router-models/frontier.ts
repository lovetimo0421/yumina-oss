import type { VideoModelSpec } from "../video-models.js";

/**
 * Google Veo 3.1 on Vertex (veo/*) and xAI Grok Imagine (xai/*), through Router.
 *
 * Veo bills (credits / sec) × duration by resolution and audio (Comfy rate card
 * 2026-10-09, 211 credits = $1); every rate is a whole number of mushies, so
 * the prices are the card exactly. Frames and shape do not change the bill.
 * Vertex takes a last frame only together with a first one (a last frame alone
 * fails upstream, measured), which the spec cannot say yet, so Veo offers the
 * first frame only. Its asset references need an 8 s clip on Veo 3.1 (a 4 s
 * Fast run with one failed upstream), so they are off until a spec can tie
 * references to a length.
 *
 * Grok's soundtrack is always on and a first frame sets the clip's shape. The
 * result reports xAI's own bill (usage.cost_in_usd_ticks), measured 2026-10-09:
 * 1.5 is $0.08 / $0.14 a second at 480p / 720p, 1.5 Lite $0.02 / $0.03 / $0.14
 * at 480p / 720p / 1080p, and each input picture (frame or reference) adds a
 * flat $0.01. Comfy's card lists 1.5 at 24.14 / 42.24 / 75.43 credits a second
 * (+3.02 per input picture) — exactly 1.43× xAI's bill — and does not list
 * Lite, so 1.5 is priced at the card and Lite at xAI × 1.43, rounded up.
 * xAI charges for moderated (refused) videos too, and Router passes that on.
 */
export const FRONTIER_VIDEO_MODELS: readonly VideoModelSpec[] = [
  {
    id: "veo-3.1-lite", name: "Veo 3.1 Lite", provider: "comfy-router", family: "veo", routerModel: "veo/veo-3.1-lite-generate-001",
    aspects: ["16:9", "9:16"],
    resolutions: ["720p", "1080p"], defaultResolution: "720p",
    durations: [4, 6, 8], defaultDuration: 6,
    frames: { first: true, last: true, both: true, lastNeedsFirst: true }, maxReferences: 0,
    sound: true, watermark: false, textToVideo: true, tuning: false, loras: false, styles: false, selfHosted: false,
    // veo-3.1-lite: 720p 6.33 / 10.55, 1080p 10.55 / 16.88 credits a second
    // without / with audio. A 4 s 720p clip took 40 s end to end, 1080p 96 s.
    etaSeconds: 50,
    perSecond: { "720p": 30, "1080p": 50 }, perSecondSound: { "720p": 50, "1080p": 80 },
  },
  {
    id: "veo-3.1-fast", name: "Veo 3.1 Fast", provider: "comfy-router", family: "veo", routerModel: "veo/veo-3.1-fast-generate-001",
    aspects: ["16:9", "9:16"],
    resolutions: ["720p", "1080p", "4K"], defaultResolution: "720p",
    durations: [4, 6, 8], defaultDuration: 6,
    frames: { first: true, last: true, both: true, lastNeedsFirst: true }, maxReferences: 0,
    sound: true, watermark: false, textToVideo: true, tuning: false, loras: false, styles: false, selfHosted: false,
    // veo-3.1-fast-generate: 720p 16.88 / 21.1, 1080p 21.1 / 25.32, 4k 52.75 /
    // 63.3 credits a second without / with audio. A 4 s 720p clip took 55 s.
    etaSeconds: 70,
    perSecond: { "720p": 80, "1080p": 100, "4K": 250 }, perSecondSound: { "720p": 100, "1080p": 120, "4K": 300 },
  },
  {
    id: "veo-3.1", name: "Veo 3.1", provider: "comfy-router", family: "veo", routerModel: "veo/veo-3.1-generate-001",
    aspects: ["16:9", "9:16"],
    resolutions: ["720p", "1080p", "4K"], defaultResolution: "720p",
    durations: [4, 6, 8], defaultDuration: 6,
    frames: { first: true, last: true, both: true, lastNeedsFirst: true }, maxReferences: 0,
    sound: true, watermark: false, textToVideo: true, tuning: false, loras: false, styles: false, selfHosted: false,
    // veo-3.1-generate: 720p and 1080p 42.2 / 84.4, 4k 84.4 / 126.6 credits a
    // second without / with audio. A 4 s 720p clip took 51 s.
    etaSeconds: 65,
    perSecond: { "720p": 200, "1080p": 200, "4K": 400 }, perSecondSound: { "720p": 400, "1080p": 400, "4K": 600 },
  },
  {
    id: "grok-imagine-1.5-lite", name: "Grok Imagine 1.5 Lite", provider: "comfy-router", family: "grok", routerModel: "xai/grok-imagine-video-1.5-lite",
    aspects: ["16:9", "4:3", "1:1", "3:4", "9:16"],
    resolutions: ["480p", "720p", "1080p"], defaultResolution: "720p",
    durations: { min: 1, max: 15 }, defaultDuration: 5,
    frames: { first: true, last: false, both: false }, maxReferences: 0, aspectFromFrame: true,
    sound: true, soundAlways: true, watermark: false, textToVideo: true, tuning: false, loras: false, styles: false, selfHosted: false,
    // xAI $0.02 / $0.03 / $0.14 a second × 1.43, +$0.01 a frame × 1.43. A 5 s
    // 720p clip took 34 s ($0.15 at xAI, we charge 215).
    etaSeconds: 35,
    perSecond: { "480p": 29, "720p": 43, "1080p": 201 }, perFrameRequest: 15,
  },
  {
    id: "grok-imagine-1.5", name: "Grok Imagine 1.5", provider: "comfy-router", family: "grok", routerModel: "xai/grok-imagine-video-1.5",
    aspects: ["16:9", "4:3", "1:1", "3:4", "9:16"],
    resolutions: ["480p", "720p", "1080p"], defaultResolution: "720p",
    durations: { min: 1, max: 15 }, defaultDuration: 5,
    // References are their own mode (xAI refuses them with an image) and top
    // out at 720p: the adapter sends a 1080p request with references at 720p,
    // still charged as 1080p. Up to 14 per xAI's model table.
    frames: { first: true, last: false, both: false }, maxReferences: 14, referencesWithoutFrames: true, aspectFromFrame: true,
    sound: true, soundAlways: true, watermark: false, textToVideo: true, tuning: false, loras: false, styles: false, selfHosted: false,
    // Card: 24.14 / 42.24 / 75.43 credits a second, +3.02 an input picture.
    // A 5 s 720p clip took 68 s ($0.70 at xAI, $1.00 at the card, we charge 1005).
    etaSeconds: 70,
    perSecond: { "480p": 115, "720p": 201, "1080p": 358 }, perFrameRequest: 15, perReference: 15,
  },
];
