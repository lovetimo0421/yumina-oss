import type { VideoModelSpec } from "../video-models.js";

/**
 * Alibaba's Wan and HappyHorse on DashScope, through Router (wan/*). Where
 * DashScope splits text-, image- and reference-to-video into separate ids, one
 * spec covers them and the adapter picks the id from what the request carries.
 *
 * Every price is Comfy's rate card of 2026-10-09 (Wan / HappyHorse sections,
 * 211 credits = $1): a flat rate per output second by resolution, the same with
 * or without a frame, references or sound. DashScope bills the seconds it was
 * asked for, so the rate times the length is the whole bill; the mushie rates
 * below are that rate rounded up to the next whole mushie. Every smoke run on
 * 2026-10-09 reported exactly the seconds asked for in its usage, at the tier asked.
 *
 * Wan 2.7 and 3.0 also draw between a first and a last frame (verified), but
 * refuse a last frame on its own (502 provider_error, verified) — and a spec
 * cannot say "last only with first", so the last frame stays off until it can.
 */
export const ALIBABA_VIDEO_MODELS: readonly VideoModelSpec[] = [
  {
    id: "wan-3.0", name: "Wan 3.0", provider: "comfy-router", family: "wan", routerModel: "wan/wan3.0-video",
    aspects: ["16:9", "4:3", "1:1", "3:4", "9:16"],
    resolutions: ["480p", "720p", "1080p"], defaultResolution: "720p",
    durations: { min: 2, max: 30 }, defaultDuration: 5,
    // A first frame, or up to 10 reference images: DashScope refuses
    // references and frames in one request. The soundtrack has a switch.
    frames: { first: true, last: true, both: true, lastNeedsFirst: true }, maxReferences: 10, referencesWithoutFrames: true, aspectFromFrame: true,
    sound: true, watermark: true, textToVideo: true, tuning: false, loras: false, styles: false, selfHosted: false,
    // 15.09 / 30.17 / 60.35 credits a second at 480P / 720P / 1080P, sound
    // included (the 30% launch discount ended 2026-09-30). 2 s at 480P took
    // 107 s with sound, 74 s from a frame, 90 s from a reference.
    etaSeconds: 180, perSecond: { "480p": 72, "720p": 143, "1080p": 287 },
  },
  {
    id: "wan-3.0-prime", name: "Wan 3.0 Prime", provider: "comfy-router", family: "wan", routerModel: "wan/wan3.0-video-prime",
    aspects: ["16:9", "4:3", "1:1", "3:4", "9:16"],
    resolutions: ["480p", "720p", "1080p"], defaultResolution: "720p",
    durations: { min: 2, max: 30 }, defaultDuration: 5,
    frames: { first: true, last: true, both: true, lastNeedsFirst: true }, maxReferences: 10, referencesWithoutFrames: true, aspectFromFrame: true,
    sound: true, watermark: true, textToVideo: true, tuning: false, loras: false, styles: false, selfHosted: false,
    // 20.52 / 42.24 / 84.48 credits a second at 480P / 720P / 1080P, sound
    // included. 2 s at 480P with sound took 96 s.
    etaSeconds: 200, perSecond: { "480p": 98, "720p": 201, "1080p": 401 },
  },
  {
    id: "wan-2.7", name: "Wan 2.7", provider: "comfy-router", family: "wan", routerModel: "wan/wan2.7-t2v",
    aspects: ["16:9", "4:3", "1:1", "3:4", "9:16"],
    resolutions: ["720p", "1080p"], defaultResolution: "720p",
    // Text and frames take 2–15 s, references only 2–10 s: the spec has one
    // range, so it stops at 10 rather than fail a reference clip after the charge.
    durations: { min: 2, max: 10 }, defaultDuration: 5,
    // wan2.7-i2v: a first frame; wan2.7-r2v: 1–5 reference images.
    frames: { first: true, last: true, both: true, lastNeedsFirst: true }, maxReferences: 5, referencesWithoutFrames: true, aspectFromFrame: true,
    // DashScope adds a soundtrack on its own and has no switch for it (quiet
    // ambience; a reference clip came back with a near-silent track).
    sound: true, soundAlways: true, watermark: true, textToVideo: true, tuning: false, loras: false, styles: false, selfHosted: false,
    // 21.1 / 31.65 credits a second at 720P / 1080P for t2v, i2v and r2v alike.
    // 2 s at 720P took 251 s from text, 41 s from frames, 68 s from a reference.
    etaSeconds: 150, perSecond: { "720p": 100, "1080p": 150 },
  },
  {
    id: "wan-2.6", name: "Wan 2.6", provider: "comfy-router", family: "wan", routerModel: "wan/wan2.6-t2v",
    aspects: ["16:9", "4:3", "1:1", "3:4", "9:16"],
    resolutions: ["720p", "1080p"], defaultResolution: "720p",
    durations: [5, 10, 15], defaultDuration: 5,
    // wan2.6-i2v takes one first frame. wan2.6-r2v is left out: its references
    // are video clips, which the page has no way to give.
    frames: { first: true, last: false, both: false }, maxReferences: 0, aspectFromFrame: true,
    sound: true, soundAlways: true, watermark: true, textToVideo: true, tuning: false, loras: false, styles: false, selfHosted: false,
    // 21.1 / 31.65 credits a second at 720p / 1080p, t2v and i2v alike.
    // 5 s at 720p took 57 s from text, 83 s from a frame.
    etaSeconds: 80, perSecond: { "720p": 100, "1080p": 150 },
  },
  {
    id: "wan-2.5", name: "Wan 2.5", provider: "comfy-router", family: "wan", routerModel: "wan/wan2.5-t2v-preview",
    // 480P comes in landscape, portrait and square only.
    aspects: ["16:9", "1:1", "9:16"],
    resolutions: ["480p", "720p", "1080p"], defaultResolution: "720p",
    durations: [5, 10], defaultDuration: 5,
    frames: { first: true, last: false, both: false }, maxReferences: 0, aspectFromFrame: true,
    sound: true, soundAlways: true, watermark: true, textToVideo: true, tuning: false, loras: false, styles: false, selfHosted: false,
    // 10.55 / 21.1 / 31.65 credits a second at 480p / 720p / 1080p, t2v and i2v
    // alike. 5 s at 480p took 85 s from text, 94 s from a frame.
    etaSeconds: 100, perSecond: { "480p": 50, "720p": 100, "1080p": 150 },
  },
  {
    id: "happyhorse-1.1", name: "HappyHorse 1.1", provider: "comfy-router", family: "happyhorse", routerModel: "wan/happyhorse-1.1-t2v",
    aspects: ["16:9", "4:3", "1:1", "3:4", "9:16"],
    // DashScope also draws 480P, but Comfy's rate card has no 480P price for it.
    resolutions: ["720p", "1080p"], defaultResolution: "720p",
    durations: { min: 3, max: 15 }, defaultDuration: 5,
    // i2v: one first frame; r2v: 1–9 reference images, nothing else.
    frames: { first: true, last: false, both: false }, maxReferences: 9, referencesWithoutFrames: true, aspectFromFrame: true,
    // Always comes with a soundtrack (no switch); stamps its logo unless told not to.
    sound: true, soundAlways: true, watermark: true, textToVideo: true, tuning: false, loras: false, styles: false, selfHosted: false,
    // 42.24 / 54.31 credits a second at 720P / 1080P. 3 s at 720P took 84 s
    // from text, 79 s from a frame.
    etaSeconds: 130, perSecond: { "720p": 201, "1080p": 258 },
  },
  {
    id: "happyhorse-1.0", name: "HappyHorse 1.0", provider: "comfy-router", family: "happyhorse", routerModel: "wan/happyhorse-1.0-t2v",
    aspects: ["16:9", "4:3", "1:1", "3:4", "9:16"],
    resolutions: ["720p", "1080p"], defaultResolution: "720p",
    durations: { min: 3, max: 15 }, defaultDuration: 5,
    frames: { first: true, last: false, both: false }, maxReferences: 9, referencesWithoutFrames: true, aspectFromFrame: true,
    sound: true, soundAlways: true, watermark: true, textToVideo: true, tuning: false, loras: false, styles: false, selfHosted: false,
    // 29.54 / 50.64 credits a second at 720P / 1080P. 3 s at 720P took 62 s
    // from text, 218 s from a frame, 79 s from a reference.
    etaSeconds: 120, perSecond: { "720p": 140, "1080p": 240 },
  },
];
