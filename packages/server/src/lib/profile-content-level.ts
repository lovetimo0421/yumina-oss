import { parseContentLevelParam } from "./hub-tags.js";

/** Match Discover's content-mode precedence, with guests always limited. */
export function resolveProfileContentLevel(
  signedIn: boolean,
  requestedLevel: string | undefined,
  preferences: Record<string, unknown> | null | undefined,
): "safe" | "r18" {
  if (!signedIn) return "safe";
  return parseContentLevelParam(requestedLevel)
    ?? parseContentLevelParam(typeof preferences?.contentLevel === "string" ? preferences.contentLevel : undefined)
    ?? (preferences?.showNsfw === true ? "r18" : "safe");
}
