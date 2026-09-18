/** Only full reading pages opt in; editors and account forms keep their panes. */
export function getMobileReadingPageId(pathname: string, search: { worldId?: unknown; view?: unknown } = {}) {
  if (/^\/app\/hub(?:\/|$)/.test(pathname)) return "hub-main";
  if (/^\/app\/community(?:\/|$)/.test(pathname)) return "community-main";
  if (/^\/app\/messages\/?$/.test(pathname)) return "dm-page-conversation-list";
  if (/^\/app\/library\/?$/.test(pathname)) {
    if (search.view === "favorites") return "library-favorites";
    return search.worldId ? "library-detail" : "library-main";
  }
  if (/^\/app\/profile\/?$/.test(pathname)) return "profile-main";
  if (/^\/app\/users\/[^/]+\/?$/.test(pathname)) return "public-profile-main";
  return undefined;
}

export type MobileReadingPageId = Exclude<ReturnType<typeof getMobileReadingPageId>, undefined>;
