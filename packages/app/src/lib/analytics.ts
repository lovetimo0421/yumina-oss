/**
 * Typed PostHog event emitter.
 *
 * Goals:
 *  - One call site for every custom event so the taxonomy is discoverable
 *    by reading this file.
 *  - Auto-tag every event with `environment` so prod/dev/preview never
 *    cross-pollute dashboards.
 *  - No-op at runtime if PostHog isn't loaded (VITE_PUBLIC_POSTHOG_PROJECT_TOKEN
 *    missing, ad-blocker, analytics opt-out). Never throws.
 *
 * Event names all use the `hub_` prefix to visually group them in the
 * PostHog event list and to avoid clashing with autocapture ($pageview
 * etc.).
 *
 * Properties shared by every event:
 *  - environment: "production" | "development" | "preview"
 *  - app_release:  git SHA or tag if exposed via VITE_APP_RELEASE
 *
 * Add new events at the bottom of the HubEventMap and the compiler will
 * force you to handle them in the capture() switch.
 */

import posthog from "posthog-js";
import { isAnalyticsEnabled } from "./analytics-enabled";
import { arrivalProperties } from "./arrival-attribution";
import { queueFeedEvent, type FeedBeaconEvent } from "./feed-beacon";
import { linkObservedGameGuest } from "./game-identity";

/**
 * Narrow environment label. Read from Vite's MODE first (set by Vite CLI).
 * `?.` because `tsx --test` has no import.meta.env, and this module is now
 * pulled in transitively by lib/feedback — a store under test that can show a
 * pill would otherwise throw at import time.
 */
function detectEnvironment(): "production" | "development" | "preview" {
  const mode = import.meta.env?.MODE;
  if (mode === "production") return "production";
  if (mode === "preview") return "preview";
  return "development";
}

const ENVIRONMENT = detectEnvironment();
const APP_RELEASE = import.meta.env?.VITE_APP_RELEASE ?? "unknown";

/**
 * Every hub event's payload. Extend this map — do NOT call
 * `posthog.capture(arbitraryString, ...)` elsewhere.
 */
export type HubEventMap = {
  /** The /krew page mounted its game frame (krew.io running inside Yumina). */
  krew_embed_loaded: { signed_in: boolean; has_path: boolean };
  /** How the page answered the krew frame's identity request. */
  krew_auth_handoff: {
    outcome:
      | "token"
      | "unauthenticated"
      | "error"
      | "login_redirect"
      | "login_dialog"
      | "login_popup_success"
      | "login_popup_error"
      | "login_popup_blocked"
      | "login_email_success";
  };
  /**
   * A world card became visible in the viewport (≥500ms dwell, 50% of
   * card area shown). Debounced per-card-per-session via the feature
   * render layer; this function doesn't do any dedup.
   */
  hub_impression: {
    world_id: string;
    creator_id: string;
    surface:
      | "recommended" | "popular" | "newest" | "following" | "search" | "featured" | "category"
      | "continue" | "because_played" | "trending" | "new_rising";
    position: number;
    feed_request_id: string | null;
    attribution_token?: string;
  };

  /**
   * User clicked a hub card (before the preview modal opens). Fired on
   * every click regardless of what happens next.
   */
  hub_click: {
    world_id: string;
    creator_id: string;
    surface: HubEventMap["hub_impression"]["surface"];
    position: number;
    feed_request_id: string | null;
    attribution_token?: string;
  };

  /**
   * Preview modal successfully rendered — user is actually looking at
   * world details. Distinguishes a real "engaged view" from a bot-like
   * rapid click that dismisses immediately.
   */
  hub_preview_open: {
    world_id: string;
    creator_id: string;
    source: "card" | "deep-link" | "notification";
  };

  /**
   * Preview modal closed. `dwell_ms` measures engaged look-time at the
   * world detail. Close reason lets us separate "didn't care" from
   * "explicitly rejected" later.
   */
  hub_preview_close: {
    world_id: string;
    dwell_ms: number;
    reason: "backdrop" | "close-button" | "navigated-away" | "other";
    surface?: string | null;
    position?: number | null;
    feed_request_id?: string | null;
    attribution_token?: string;
  };

  /**
   * User clicked "Start Playing" from the preview modal. This is the
   * play intent for the recommendation funnel. Fires
   * on the click itself (before the actual session is provisioned) so
   * we count intent even when the server call fails. The server will
   * still get its own play-session-created log separately, so we never
   * rely on this event alone for billing or progression.
   */
  hub_play_start: {
    world_id: string;
    creator_id: string;
    /** Whether the user was authenticated at the moment of the click. */
    authenticated: boolean;
    /**
     * Was this a returning play (world already in library) or a new
     * session from discovery? Helps separate re-engagement from
     * first-time conversion.
     */
    in_library: boolean;
    /** Slate attribution (Ship 1): which feed placement led to this play.
     * Present when the preview was opened from a tracked HubCard; absent
     * for deep links / notifications / library entries. */
    surface?: HubEventMap["hub_impression"]["surface"] | null;
    position?: number | null;
    feed_request_id?: string | null;
    attribution_token?: string;
  };

  /**
   * User clicked "Add to Library" from the preview modal. Another
   * save intent, including login gates and failed mutations. The server
   * alone records a confirmed save.
   */
  hub_library_add: {
    world_id: string;
    creator_id: string;
    surface?: string | null;
    position?: number | null;
    feed_request_id?: string | null;
    attribution_token?: string;
  };

  /**
   * A feedback pill was shown. Volume per active user is the redesign's KPI.
   * `text` is the (authored, truncated) copy so error pills can be attributed
   * to the flow that failed — without it, "235 error pills on /app/library"
   * was an unanswerable number.
   */
  feedback_pill_shown: {
    kind: "notice" | "error" | "undo" | "progress" | "persistent" | "legacy";
    text?: string;
  };

  /** The tab reloaded itself (or the user clicked Refresh) to pick up a deploy. */
  deploy_reload: {
    trigger: "navigate" | "resume" | "manual";
  };

  /** Bounded, geometry-only diagnostics for mobile resume/interaction recovery. */
  ui_recovery: {
    reason: "viewport_resume" | "outer_scroll" | "orphaned_overlay_lock";
    previousHeight?: number;
    height?: number;
    layoutHeight?: number;
    visualHeight?: number;
    keyboardInset?: number;
    scrollTarget?: "html" | "body" | "root" | "shell" | "shell_content";
    previousScrollTop?: number;
    scrollTop?: number;
  };
};

/**
 * Capture a typed hub event. Safe to call before PostHog has loaded —
 * events queue on the PostHog stub until initialization completes.
 *
 * Always returns undefined so callers don't accidentally chain on it.
 */
export function captureHubEvent<K extends keyof HubEventMap>(
  event: K,
  props: HubEventMap[K],
): void {
  try {
    // posthog-js exposes a no-op if not initialized, but defensive check
    // guards against server-side rendering or test harnesses that import
    // this file without a window.
    if (typeof window === "undefined") return;

    // One canonical occurrence, mirrored to product analytics with the same
    // ID. Training consumes the feed log, not both copies as separate labels.
    let occurrence: Readonly<FeedBeaconEvent> | undefined;
    if (event === "hub_impression" || event === "hub_click") {
      const p = props as HubEventMap["hub_click"];
      occurrence = queueFeedEvent({
        eventType: event === "hub_impression" ? "impression" : "click",
        worldId: p.world_id,
        position: p.position >= 0 ? p.position : null,
        feedRequestId: p.feed_request_id,
        surface: p.surface,
        attributionToken: p.attribution_token,
      });
    } else if (event === "hub_play_start" || event === "hub_library_add" || event === "hub_preview_close") {
      const p = props as HubEventMap["hub_play_start"] & Partial<HubEventMap["hub_preview_close"]>;
      occurrence = queueFeedEvent({
        eventType: event === "hub_play_start" ? "play" : event === "hub_library_add" ? "save_intent" : "preview_dwell",
        worldId: p.world_id,
        position: p.position ?? null,
        feedRequestId: p.feed_request_id ?? null,
        surface: p.surface ?? null,
        attributionToken: p.attribution_token,
        ...(event === "hub_preview_close" ? { durationMs: Math.max(0, Math.min(30 * 60_000, Math.round(p.dwell_ms ?? 0))) } : {}),
      });
    }

    const { attribution_token: _token, ...productProps } = props as HubEventMap[K] & { attribution_token?: string };
    if (isAnalyticsEnabled()) posthog.capture(event, {
      ...productProps,
      ...(occurrence ? { event_id: occurrence.eventId, $insert_id: occurrence.eventId, occurred_at: occurrence.occurredAt, event_source: "feed_beacon" } : {}),
      environment: ENVIRONMENT,
      app_release: APP_RELEASE,
    });
  } catch {
    // Never let analytics break the app.
  }
}

/**
 * Associate the current browser session with an authenticated user id.
 * Call after login / session restore. Reset on logout.
 */
export function identifyAnalyticsUser(
  userId: string,
  traits?: Record<string, string | number | boolean | null | undefined>,
): void {
  try {
    if (typeof window === "undefined") return;
    if (isAnalyticsEnabled()) posthog.identify(userId, traits);
    linkObservedGameGuest(userId);
  } catch {
    // ignore
  }
}

export function resetAnalyticsUser(): void {
  try {
    if (typeof window === "undefined") return;
    if (isAnalyticsEnabled()) posthog.reset();
  } catch {
    // ignore
  }
}

// ── Signup conversion (ad attribution) ──────────────────────────────
// One chokepoint for every "a new account was just created" signal:
//  - PostHog `signup_completed` (carries utm_* event properties from the
//    session, so acquisition dashboards can break down by campaign/ad)
//  - Reddit Ads pixel `SignUp` (pixel is injected in index.html, prod only)
//  - Meta pixel `CompleteRegistration` (no-op until the Meta pixel ships)
// Device-local guard so login loops / refreshes can't refire; dashboards
// should still count unique persons, not raw events (a same-account signup
// seen from a second device inside the freshness window fires again).
const SIGNUP_FIRED_KEY = "y_signup_conversion_at";

export function trackSignupConversion(userId?: string | null): void {
  try {
    if (typeof window === "undefined") return;
    try {
      const prev = localStorage.getItem(SIGNUP_FIRED_KEY);
      if (prev && Date.now() - Number(prev) < 24 * 60 * 60 * 1000) return;
      localStorage.setItem(SIGNUP_FIRED_KEY, String(Date.now()));
    } catch {
      // storage unavailable (private mode) — still fire, just unguarded
    }
    if (isAnalyticsEnabled()) posthog.capture("signup_completed", { ...arrivalProperties(), ...(userId ? { user_id: userId } : {}) });
    const w = window as unknown as {
      rdt?: (...args: unknown[]) => void;
      fbq?: (...args: unknown[]) => void;
    };
    // conversionId must match the server-side CAPI SignUp's conversion_id
    // (the user id) — Reddit dedupes the pixel/CAPI pair on it.
    if (typeof w.rdt === "function") {
      w.rdt("track", "SignUp", userId ? { conversionId: userId } : undefined);
    }
    if (typeof w.fbq === "function") w.fbq("track", "CompleteRegistration");
  } catch {
    // Never let analytics break the app.
  }
}

/**
 * OAuth signups have no client-side success callback (the browser round-trips
 * through the provider), so we detect them by account age when the profile
 * first loads: created within the last 30 minutes = this session's signup.
 * Email signups fire directly from the register page and are deduped by the
 * device guard above.
 */
export function maybeTrackSignupFromCreatedAt(
  createdAt: string | null | undefined,
  userId?: string | null,
): void {
  if (!createdAt) return;
  const created = new Date(createdAt).getTime();
  if (!Number.isFinite(created)) return;
  if (Date.now() - created > 30 * 60 * 1000) return;
  trackSignupConversion(userId);
}

// ── Reddit pixel engagement events (retargeting fuel) ───────────────
// ActiveUser: fired at most once per device per 24h when an authenticated
// profile loads. Feeds the "existing users" exclusion audience so paid
// campaigns don't pay to reach people who already use Yumina — the pixel
// only exists since 2026-07-28, so a SignUp-based exclusion misses every
// account older than that.
const ACTIVE_USER_FIRED_KEY = "y_active_user_pixel_at";

export function trackActiveUserPixel(): void {
  try {
    if (typeof window === "undefined") return;
    try {
      const prev = localStorage.getItem(ACTIVE_USER_FIRED_KEY);
      if (prev && Date.now() - Number(prev) < 24 * 60 * 60 * 1000) return;
      localStorage.setItem(ACTIVE_USER_FIRED_KEY, String(Date.now()));
    } catch {
      // storage unavailable (private mode) — still fire, just unguarded
    }
    const w = window as unknown as { rdt?: (...args: unknown[]) => void };
    if (typeof w.rdt === "function") {
      w.rdt("track", "Custom", { customEventName: "ActiveUser" });
    }
  } catch {
    // Never let analytics break the app.
  }
}

// Lead: a logged-out visitor clicked "Start Playing" — the highest-intent
// pre-signup moment we can observe. Doubles as (a) a retargeting include
// audience ("hit the login wall, never signed up") and (b) a fallback
// conversion goal if SignUp volume is too thin for Reddit's learning phase.
const GUEST_PLAY_INTENT_FIRED_KEY = "y_lead_pixel_at";

export function trackGuestPlayIntentPixel(): void {
  try {
    if (typeof window === "undefined") return;
    try {
      const prev = localStorage.getItem(GUEST_PLAY_INTENT_FIRED_KEY);
      if (prev && Date.now() - Number(prev) < 24 * 60 * 60 * 1000) return;
      localStorage.setItem(GUEST_PLAY_INTENT_FIRED_KEY, String(Date.now()));
    } catch {
      // storage unavailable (private mode) — still fire, just unguarded
    }
    const w = window as unknown as { rdt?: (...args: unknown[]) => void };
    if (typeof w.rdt === "function") w.rdt("track", "Lead");
  } catch {
    // Never let analytics break the app.
  }
}

/**
 * Generate a feed-request id on the client when the backend didn't
 * provide one. Lets us stitch together an impression event with the
 * click event that followed — even if the click is on a cached card
 * loaded in a different session.
 */
export function newFeedRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `fr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
