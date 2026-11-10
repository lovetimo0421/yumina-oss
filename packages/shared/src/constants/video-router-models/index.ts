/**
 * Comfy Router's partner video models, one file per group of families so each
 * family's specs, prices and their evidence sit together. Prices are Comfy's
 * rate card (211 credits = $1) converted to mushies ($1 ≈ 1000), rounded up so
 * a clip never costs us more than it charges.
 */

import type { VideoModelSpec } from "../video-models.js";
import { SEEDANCE_VIDEO_MODELS } from "./seedance.js";
import { KLING_VIDEO_MODELS } from "./kling.js";
import { FRONTIER_VIDEO_MODELS } from "./frontier.js";
import { ALIBABA_VIDEO_MODELS } from "./alibaba.js";
import { MORE_VIDEO_MODELS } from "./more.js";

export const ROUTER_VIDEO_MODELS: readonly VideoModelSpec[] = [
  ...SEEDANCE_VIDEO_MODELS,
  ...KLING_VIDEO_MODELS,
  ...FRONTIER_VIDEO_MODELS,
  ...ALIBABA_VIDEO_MODELS,
  ...MORE_VIDEO_MODELS,
];
