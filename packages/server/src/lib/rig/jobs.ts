/**
 * Open-source edition stub. Live characters (the rig that turns a picture into
 * a moving portrait) run on hosted GPU deployments and are credit-metered. In
 * the local build the feature reports itself unavailable: nothing is offered,
 * nothing is charged, and a call that slips through fails with a clear code.
 */

export const RIG_PROVIDER = "comfy-rig";
export const RIG_PRICE_MUSHIES = 1500;
export const RIG_MINUTES = 30;
export const RIG_HOLD_MUSHIES = 4500;
export const RIG_TYPICAL_MUSHIES = [1500, 2500] as const;

export type RigStage = "start" | "draw" | "finish" | "turn" | "fit";

export type RigJob = {
  id: string;
  status: string;
  assetId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  params: unknown;
  costMushies: number | null;
};

export class RigSubmissionError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "RigSubmissionError";
    this.code = code;
  }
}

const unavailable = () => new RigSubmissionError("LIVE_CHARACTERS_UNAVAILABLE", "Live characters are not available in this edition");

export function rigAvailable(): boolean {
  return false;
}

export function liveCharactersFor(_account: { role?: string | null } | null | undefined): boolean {
  return false;
}

export async function liveCharactersForUser(_userId: string): Promise<boolean> {
  return false;
}

export async function existingRigJob(_userId: string, _pictureAssetId: string): Promise<RigJob | null> {
  return null;
}

export async function submitRigJob(_userId: string, _input: { pictureAssetId: string; name?: string; requestId?: string }): Promise<RigJob> {
  throw unavailable();
}

export async function watchRigJob(
  _jobId: string,
  _signal: AbortSignal,
  _onProgress: (p: { stage: RigStage; done: number; total: number }) => Promise<void>,
): Promise<RigJob> {
  throw unavailable();
}

export function startRigPickup(): void {}
export function stopRigPickup(): void {}
export function driveRigJob(_jobId: string): void {}
