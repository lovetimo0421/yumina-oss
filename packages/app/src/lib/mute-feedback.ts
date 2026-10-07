import i18n from "./i18n";

export function getMuteErrorMessage(body: { code?: unknown; mutedUntil?: unknown }): string | null {
  if (body.code !== "COMMUNITY_MUTED") return null;
  // A permanent mute has no date to show. It reaches this path now that the
  // community gate also honours an account-level mute, which can be permanent.
  if (body.mutedUntil == null) {
    return i18n.t("communityMutedPermanent", {
      ns: "common",
      defaultValue: "You can no longer post in the community or comments.",
    });
  }
  if (typeof body.mutedUntil !== "string") return null;
  const until = new Date(body.mutedUntil);
  if (!Number.isFinite(until.getTime())) return null;
  return i18n.t("communityMuted", {
    ns: "common",
    date: until.toLocaleString(i18n.language),
    defaultValue: "You cannot post in the community or comments until {{date}}.",
  });
}
