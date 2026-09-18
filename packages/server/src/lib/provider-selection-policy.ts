export type PreferredProvider = "official" | "private";

/** Private/BYOK mode is a billing boundary: Yumina's key may only be used when
 * a caller deliberately opts into that fallback. */
export function allowsOfficialKeyFallback(
  preferredProvider: PreferredProvider,
  explicitlyAllowed?: boolean,
): boolean {
  return preferredProvider === "official" || explicitlyAllowed === true;
}
