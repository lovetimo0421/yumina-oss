import type { Hono } from "hono";

/**
 * Editions.
 *
 *   hosted — yumina.io. Hub/discover, community, billing, admin, analytics,
 *            multiplayer rooms, the works.
 *   local  — the open-source self-hosted build. Play + build + library with the
 *            user's own model keys. No platform services.
 *
 * Everything hosted-only reaches the core through this seam and nothing else:
 * the hosted implementation (edition/hosted.ts) is the ONLY file allowed to
 * import hosted route modules and background jobs, and the open-source export
 * replaces edition/impl.ts so that file is never shipped. Core code that needs
 * to know what exists asks `edition.info().features`, never NODE_ENV or a
 * hard-coded hostname.
 */
export type EditionName = "hosted" | "local";

export interface EditionFeatures {
  /** Discover / hub browse, featured, search, recommendations. */
  hub: boolean;
  /** Submit-for-review publishing and the moderation state machine. */
  publishing: boolean;
  /** Forums, threads, events, profile walls. */
  community: boolean;
  /** Credits, plans, Stripe, tips, check-ins, quests. */
  billing: boolean;
  /** Platform-paid models (credits) next to the user's own keys. */
  officialModels: boolean;
  achievements: boolean;
  referrals: boolean;
  dm: boolean;
  notifications: boolean;
  reviews: boolean;
  /** Bundles marketplace (import of bundle files stays core). */
  bundles: boolean;
  /** The Extensions page (first-party extensions such as session memory). */
  extensions: boolean;
  /** Realtime game rooms / multiplayer. */
  multiplayer: boolean;
  /** Platform image generation (credit-metered, hosted image API). */
  imageGeneration: boolean;
  /** Hub library (saved worlds from other creators). "My worlds" is always on. */
  library: boolean;
  sharedPlaythroughs: boolean;
  /** Social profiles: follows, public profile pages, partner dashboard. */
  socialProfiles: boolean;
  admin: boolean;
  /** Server- and client-side product analytics. */
  telemetry: boolean;
}

export interface EditionInfo {
  edition: EditionName;
  /** Release identifier when known (build SHA or version string). */
  release: string | null;
  features: EditionFeatures;
  auth: {
    mode: "single-user" | "multi-user";
    /** Social providers that are configured (env has id + secret). */
    socialProviders: string[];
  };
  storage: { kind: "s3" | "local" | "none" };
}

export interface Edition {
  readonly name: EditionName;
  /** Static capability description served at GET /api/edition. */
  info(): EditionInfo;
  /**
   * Routers that must sit BEFORE messageRoutes' broad `/api/*` auth middleware:
   * public reads (hub gallery, community, bundles), webhooks (Stripe), guest
   * beacons. Mounted after the early core routers (auth, users, worlds, keys,
   * sessions).
   */
  mountPublicApiRoutes(app: Hono): void;
  /** Routers mounted after all core routers. */
  mountApiRoutes(app: Hono): void;
  /** Non-/api surfaces: sitemap, first-party game pages, asset proxies. */
  mountRootRoutes(app: Hono): void;
  /** Interval jobs, cache prewarms, leader-elected sweeps. Called from start(). */
  startBackgroundJobs(): void;
  /** Mirror of startBackgroundJobs for graceful shutdown. */
  stopBackgroundJobs(): void;
  /** Let in-flight hosted work (image jobs, ...) finish before exit. */
  drain(timeoutMs: number): Promise<void>;
  /** Fire-and-forget provisioning that must wait until the port is bound. */
  afterListen(): void;
}
