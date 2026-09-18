import type { Hono } from "hono";
import { AUTH_MODE, env } from "../lib/env.js";
import { storageKind } from "../lib/s3.js";
import type { Edition, EditionFeatures, EditionInfo, EditionName } from "./types.js";

/** Every platform feature off. This is the open-source edition. */
export const LOCAL_FEATURES: EditionFeatures = {
  hub: false,
  publishing: false,
  community: false,
  billing: false,
  officialModels: false,
  achievements: false,
  referrals: false,
  dm: false,
  notifications: false,
  reviews: false,
  bundles: false,
  extensions: true,
  multiplayer: false,
  imageGeneration: false,
  library: false,
  sharedPlaythroughs: false,
  socialProfiles: false,
  admin: false,
  telemetry: false,
};

export function configuredSocialProviders(): string[] {
  const out: string[] = [];
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) out.push("google");
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) out.push("github");
  if (env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET) out.push("discord");
  if (env.TWITTER_CLIENT_ID && env.TWITTER_CLIENT_SECRET) out.push("twitter");
  return out;
}

export function releaseId(): string | null {
  return process.env.APP_RELEASE || process.env.RAILWAY_GIT_COMMIT_SHA || null;
}

export function buildInfo(edition: EditionName, features: EditionFeatures): EditionInfo {
  return {
    edition,
    release: releaseId(),
    features,
    auth: { mode: AUTH_MODE, socialProviders: configuredSocialProviders() },
    storage: { kind: storageKind() },
  };
}

export const localEdition: Edition = {
  name: "local",
  info: () => buildInfo("local", LOCAL_FEATURES),
  mountPublicApiRoutes(_app: Hono) {},
  mountApiRoutes(_app: Hono) {},
  mountRootRoutes(_app: Hono) {},
  startBackgroundJobs() {},
  stopBackgroundJobs() {},
  async drain(_timeoutMs: number) {},
  afterListen() {},
};
