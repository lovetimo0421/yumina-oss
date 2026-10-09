/** A saved, immutable plan offered by the advisor; accepting it starts Build. */
export interface StudioBuildProposal {
  revision: string;
  brief: string;
  summary: string;
  steps: string[];
}

export function isStudioBuildProposal(value: unknown): value is StudioBuildProposal {
  if (!value || typeof value !== "object") return false;
  const p = value as StudioBuildProposal;
  return typeof p.revision === "string" && /^[a-f0-9]{64}$/.test(p.revision)
    && typeof p.brief === "string" && p.brief.trim().length > 0 && p.brief.length <= 6_000
    && typeof p.summary === "string" && p.summary.trim().length > 0 && p.summary.length <= 200
    && Array.isArray(p.steps) && p.steps.length >= 1 && p.steps.length <= 5
    && p.steps.every(s => typeof s === "string" && s.trim().length > 0 && s.length <= 160);
}
