/**
 * Open-source edition stub. Live characters are a hosted feature (see
 * rig/jobs.ts); the public lookup a card uses for `@rig:<id>` finds nothing
 * here, so the route answers 404 like any unknown id.
 */

export type RigSettings = {
  off?: string[];
  custom?: { slot: string; name: string; prompt?: string }[];
  [key: string]: unknown;
};

export async function publicRigCharacter(_id: string): Promise<{ id: string; assetId: string; settings: RigSettings; name: string } | null> {
  return null;
}
