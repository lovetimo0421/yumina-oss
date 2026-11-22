import type { VideoModelSpec } from "../video-models.js";

/** ByteDance Seedance on BytePlus, through Router (byteplus/*). */
export const SEEDANCE_VIDEO_MODELS: readonly VideoModelSpec[] = [
  {
    id: "seedance-2.5", name: "Seedance 2.5", provider: "comfy-router", family: "seedance", routerModel: "byteplus/dreamina-seedance-2-5-260628",
    resolutions: ["480p", "720p", "1080p"], defaultResolution: "720p",
    durations: { min: 4, max: 15 }, defaultDuration: 5,
    frames: { first: true, last: true, both: true }, maxReferences: 9, referencesWithoutFrames: true, aspectFromFrame: true,
    sound: true, watermark: true, textToVideo: true, tuning: false, loras: false, styles: false, selfHosted: false,
    // Comfy bills Seedance 2.5 by tokens (width × height × fps × seconds / 1024)
    // at 3.229 credits per 1K below 1080p and 3.530 at 1080p, 211 credits = $1
    // (rate card 2026-10-09); reference images do not change the rate. At 24 fps
    // that is 147 / 331 / 813 mushies a second at 480p / 720p / 1080p for 16:9.
    // Rounded up to cover the extra frame (a 4 s clip is 97 frames: 38,830
    // tokens = $0.594, measured 2026-10-09) and 21:9, the widest tier (+4.5%
    // pixels at 480p). A 4 s 480p clip with sound took 155 s end to end.
    etaSeconds: 150, perSecond: { "480p": 156, "720p": 336, "1080p": 825 },
    // Following a video is billed as video-to-video: 1.931 credits per 1K
    // tokens, but the reference's own tokens count as well. We crop it to the
    // clip's shape at 24 fps and about its size (Seedance wants 409,600 to
    // 927,408 pixels a frame: a 480p reference grows to the floor, never past
    // the widest 480p clip; a wide 720p one shrinks to the ceiling), so the
    // bill is at most twice the widest clip's tokens at 1.931:
    // 156 × 1.931 / 3.229 × 2 = 187 a second at 480p, 402 at 720p.
    // Measured 2026-10-16 (12 s and 8 s at 480p following a 12 s and an 8 s
    // blockout): 446 and 298 credits, 2,114 and 1,412 mushies, under 2,244 and
    // 1,496. The 1080p video-to-video rate is not on the card, so no 1080p.
    referenceVideo: { resolutions: ["480p", "720p"], perSecond: { "480p": 187, "720p": 402 } },
  },
  {
    id: "seedance-2.0", name: "Seedance 2.0", provider: "comfy-router", family: "seedance", routerModel: "byteplus/dreamina-seedance-2-0-260128",
    resolutions: ["480p", "720p", "1080p"], defaultResolution: "720p",
    durations: { min: 4, max: 15 }, defaultDuration: 5,
    frames: { first: true, last: true, both: true }, maxReferences: 9, referencesWithoutFrames: true, aspectFromFrame: true,
    sound: true, watermark: true, textToVideo: true, tuning: false, loras: false, styles: false, selfHosted: false,
    // Same token formula as 2.5 at 2.112 credits per 1K below 1080p and 2.323 at
    // 1080p (rate card 2026-10-09): 96 / 216 / 535 mushies a second at 16:9,
    // rounded up for the extra frame and 21:9 like 2.5.
    etaSeconds: 300, perSecond: { "480p": 102, "720p": 220, "1080p": 545 },
  },
  {
    id: "seedance-2.0-fast", name: "Seedance 2.0 Fast", provider: "comfy-router", family: "seedance", routerModel: "byteplus/dreamina-seedance-2-0-fast-260128",
    resolutions: ["480p", "720p"], defaultResolution: "720p",
    durations: { min: 4, max: 15 }, defaultDuration: 5,
    frames: { first: true, last: true, both: true }, maxReferences: 9, referencesWithoutFrames: true, aspectFromFrame: true,
    sound: true, watermark: true, textToVideo: true, tuning: false, loras: false, styles: false, selfHosted: false,
    // 1.690 credits per 1K tokens (2026-10-09): 77 / 173 mushies a second, rounded up.
    etaSeconds: 150, perSecond: { "480p": 82, "720p": 176 },
  },
  {
    id: "seedance-2.0-mini", name: "Seedance 2.0 Mini", provider: "comfy-router", family: "seedance", routerModel: "byteplus/dreamina-seedance-2-0-mini",
    resolutions: ["480p", "720p"], defaultResolution: "720p",
    durations: { min: 4, max: 15 }, defaultDuration: 5,
    frames: { first: true, last: true, both: true }, maxReferences: 9, referencesWithoutFrames: true, aspectFromFrame: true,
    sound: true, watermark: true, textToVideo: true, tuning: false, loras: false, styles: false, selfHosted: false,
    // 1.056 credits per 1K tokens (2026-10-09): 48 / 108 mushies a second, rounded up.
    etaSeconds: 110, perSecond: { "480p": 51, "720p": 110 },
  },
  {
    id: "seedance-1.0-pro", name: "Seedance 1.0 Pro", provider: "comfy-router", family: "seedance", routerModel: "byteplus/seedance-1-0-pro-250528",
    resolutions: ["480p", "720p", "1080p"], defaultResolution: "1080p",
    durations: { min: 2, max: 12 }, defaultDuration: 5,
    frames: { first: true, last: true, both: true }, maxReferences: 0, aspectFromFrame: true, cameraFixed: true,
    sound: false, watermark: true, textToVideo: true, tuning: false, loras: false, styles: false, selfHosted: false,
    // 527.5 credits per 1M tokens (2026-10-09); per 10 s, top of range, +6%
    // (480p 2 s with first+last frame measured exactly 50 mushies at 25/s):
    // 480p 50.64, 720p 118.16, 1080p 257.42 credits.
    etaSeconds: 50, perSecond: { "480p": 27, "720p": 60, "1080p": 130 },
  },
  {
    id: "seedance-1.0-pro-fast", name: "Seedance 1.0 Pro Fast", provider: "comfy-router", family: "seedance", routerModel: "byteplus/seedance-1-0-pro-fast-251015",
    resolutions: ["480p", "720p", "1080p"], defaultResolution: "1080p",
    durations: { min: 2, max: 12 }, defaultDuration: 5,
    frames: { first: true, last: false, both: false }, maxReferences: 0, aspectFromFrame: true, cameraFixed: true,
    sound: false, watermark: true, textToVideo: true, tuning: false, loras: false, styles: false, selfHosted: false,
    // 211 credits per 1M tokens (2026-10-09); per 10 s, top of range, +3%:
    // 480p 21.1, 720p 48.53, 1080p 103.39 credits.
    etaSeconds: 30, perSecond: { "480p": 11, "720p": 24, "1080p": 51 },
  },
];
