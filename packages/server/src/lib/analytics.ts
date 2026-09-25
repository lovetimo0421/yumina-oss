/**
 * Server-side typed PostHog event emitter.
 *
 * Mirrors the client wrapper in packages/app/src/lib/analytics.ts but
 * for events that can only be known server-side — primarily, which
 * worlds were served at which positions in response to a hub request.
 * Joining server-side `hub_serve` with client-side `hub_impression` /
 * `hub_click` (via `feed_request_id`) gives us CTR and position bias
 * per world.
 *
 * Every event auto-tags `environment` + `app_release` so production,
 * staging, and any developer's local shell can share one PostHog
 * project without polluting each other's dashboards.
 *
 * No-op when POSTHOG_API_KEY is unset or when NODE_ENV === "test" so
 * the suite can run without spamming real events.
 */

import { posthog } from "./posthog.js";
import { env } from "./env.js";
import { runtimeIdentity } from "./runtime-identity.js";

/** Deployment environment for filtering in PostHog dashboards. */
function detectEnvironment(): "production" | "development" | "preview" | "test" {
  const e = process.env.NODE_ENV;
  if (e === "test") return "test";
  if (e === "production") return "production";
  if (e === "preview" || e === "staging") return "preview";
  return "development";
}

const ENVIRONMENT = detectEnvironment();
const APP_RELEASE = process.env.APP_RELEASE ?? "unknown";

/**
 * Whether this instance is configured to actually send events. When
 * false, every captureHubEvent call is an explicit no-op — useful to
 * guard tests and CI from emitting to real PostHog.
 */
const ENABLED = Boolean(env.POSTHOG_API_KEY) && ENVIRONMENT !== "test";

/**
 * Server-emitted hub event taxonomy. Client has its own map in
 * packages/app/src/lib/analytics.ts — the two don't need to be
 * identical; they cover different information each side has.
 */
export type ServerHubEventMap = {
  /**
   * Response to a /api/worlds/hub request. Lists every world we
   * returned, in order, along with the request parameters. Pair with
   * client `hub_impression` / `hub_click` events via `feed_request_id`
   * to compute CTR.
   *
   * `world_ids` is an ordered array, not a count, so we can slice by
   * position later ("worlds at positions 0-4 get 3x the clicks of
   * positions 5-9" etc.).
   */
  hub_serve: {
    feed_request_id: string;
    feed: "recommended" | "default";
    surface:
      | "recommended" | "popular" | "newest" | "following" | "search" | "featured" | "category"
      | "continue" | "because_played" | "trending" | "new_rising";
    sort: "newest" | "popular";
    has_query: boolean;
    tag_count: number;
    offset: number;
    limit: number;
    returned_count: number;
    total_count: number | null;
    world_ids: string[];
    /** Tier of the user's reco profile (cold/warm/mature), if computed. */
    tier: "cold" | "warm" | "mature" | null;
    /** Whether this response was served from the recommended-feed output
     * cache ("hit") or freshly computed ("miss"). Absent on paths that don't
     * participate in the feed cache (default/search/tag/followed). Lets us
     * measure cache hit-rate in PostHog. */
    cache?: "hit" | "miss" | "cursor";
    /** Separates starter-hint exposure from baseline without logging chosen topics. */
    starter_policy?: "catalog-hints-v1" | null;
    policy_version?: string;
    catalog_scans?: number;
    duration_ms?: number;
    /** Cursor work, split without including world/account identifiers. */
    ranking_ms?: number;
    measurement_ms?: number;
    /** Hub filter construction (account preferences, blocks, language). */
    filters_ms?: number;
    /** Where a fresh visit spent its ranking time: t_profile_ms, t_engagement_ms,
     * t_personalization_ms, t_retrieve_ms, t_rank_ms, t_hydrate_ms, t_page_ms. */
    [mark: `t_${string}_ms`]: number | undefined;
    authenticated?: boolean;
    has_more?: boolean;
    measurement_status?: "recorded" | "unavailable" | "off";
    snapshot_bytes?: number;
    /** Ranking experiment arm that produced this slate (Ship 1:
     * "control" | "engage_v1"). Slice CTR by this to read the A/B. */
    variant?: string;
  };
};

/**
 * Capture a server-side hub event for a specific user (or anonymous).
 *
 * `distinctId`:
 *   - pass the authenticated user's id when available so events join
 *     with client events emitted after `posthog.identify(userId)` runs
 *     in the browser
 *   - pass a stable anonymous id (session cookie, IP hash, etc.) for
 *     logged-out users; if you pass null/undefined, we tag the event as
 *     `anon` which never joins a user profile
 */
export function captureHubEvent<K extends keyof ServerHubEventMap>(
  distinctId: string | null | undefined,
  event: K,
  props: ServerHubEventMap[K],
): void {
  if (!ENABLED) return;
  try {
    posthog.capture({
      distinctId: distinctId ?? "anon",
      event,
      properties: {
        ...props,
        environment: ENVIRONMENT,
        app_release: APP_RELEASE,
        region: runtimeIdentity.region,
        deployment_id: runtimeIdentity.deployment_id,
      },
    });
  } catch {
    // Analytics must never break a request.
  }
}

/**
 * Capture a generic server-side event (not scoped to hub).
 * Used for LLM errors, generation metrics, and other events that are
 * only observable on the server.
 */
export function captureServerEvent(
  distinctId: string | null | undefined,
  event: string,
  props: Record<string, unknown>,
): void {
  if (!ENABLED) return;
  try {
    posthog.capture({
      distinctId: distinctId ?? "anon",
      event,
      properties: {
        ...props,
        environment: ENVIRONMENT,
        app_release: APP_RELEASE,
      },
    });
  } catch {
    // Analytics must never break a request.
  }
}

/**
 * Generate a server-side feed-request id. Returned to the client in
 * the /hub response body so client events can echo it back for joining.
 */
export function newFeedRequestId(): string {
  // crypto.randomUUID is standard in Node 16+; our target is Node 22.
  return crypto.randomUUID();
}
