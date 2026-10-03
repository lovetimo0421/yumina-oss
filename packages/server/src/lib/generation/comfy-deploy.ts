import type { GenerationProvider } from "./provider.js";

// Hosted GPU deployments are unavailable in the open-source edition.
export const getComfyDeployProvider = (): GenerationProvider | null => null;
