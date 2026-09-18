import { getEditionInfo } from "./edition";

/**
 * Route targets that only exist in the hosted edition, typed as plain
 * strings on purpose.
 *
 * TanStack's `Link`/`navigate`/`redirect` check string LITERALS against the
 * registered route tree. The open-source export deletes the hosted route
 * files, so a literal like `to: "/app/hub"` inside a core file would stop
 * typechecking there. A `string`-typed value is accepted by the router in
 * both editions, and every helper here already answers with a route that
 * exists in the current edition.
 */
export const HOSTED_ROUTES: Record<
  "hub" | "community" | "communityNew" | "admin" | "partner" | "plans" | "creator" | "generate",
  string
> = {
  hub: "/app/hub",
  community: "/app/community",
  communityNew: "/app/community/new",
  admin: "/app/admin",
  partner: "/app/partner",
  plans: "/app/plans",
  creator: "/creator",
  generate: "/app/generate",
};

/** Where `/`, `/app` and post-login land: Discover when the hub exists, else the library. */
export function getLandingRoute(): string {
  return getEditionInfo().features.hub ? HOSTED_ROUTES.hub : "/app/library";
}

/**
 * The signed-in user's own page. `/app/profile` is a core route in both
 * editions — the social profile when hosted, the same own-account sections
 * without the platform (avatar, AI settings, personas, extensions, recently
 * played, prompts) otherwise. The `ProfileRoot` slot picks the page, so
 * callers never need to.
 */
export function getProfileRoute(): string {
  return "/app/profile";
}

/** Public profile of another user, or null when profiles are not a thing. */
export function getUserProfileHref(userId: string): string | null {
  return getEditionInfo().features.socialProfiles ? `/app/users/${encodeURIComponent(userId)}` : null;
}

/** The standalone image-generation workshop, or null without platform image generation. */
export function getGenerateHref(): string | null {
  return getEditionInfo().features.imageGeneration ? HOSTED_ROUTES.generate : null;
}

/** The plans / mushie packs page, or null without billing. */
export function getPlansHref(tab?: "subscription" | "packs"): string | null {
  if (!getEditionInfo().features.billing) return null;
  return tab ? `${HOSTED_ROUTES.plans}?tab=${tab}` : HOSTED_ROUTES.plans;
}
