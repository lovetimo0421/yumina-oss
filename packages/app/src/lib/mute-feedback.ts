import i18n from "./i18n";

export function getMuteErrorMessage(body: { code?: unknown; mutedUntil?: unknown }): string | null {
  if (body.code !== "COMMUNITY_MUTED" || typeof body.mutedUntil !== "string") return null;
  const until = new Date(body.mutedUntil);
  if (!Number.isFinite(until.getTime())) return null;
  return i18n.t("communityMuted", {
    ns: "common",
    date: until.toLocaleString(i18n.language),
    defaultValue: "You cannot post in the community or comments until {{date}}.",
  });
}
