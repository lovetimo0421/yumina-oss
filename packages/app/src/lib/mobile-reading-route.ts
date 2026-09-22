/** Mobile pages share Discover's document scrollport; games/editors keep panes.
 * Create starts at the picker, but can mount its editor at the same URL. */
export function getMobileReadingPageId(pathname: string, search: { worldId?: unknown; view?: unknown } = {}, createPickerActive = true) {
  if (/^\/app\/hub(?:\/|$)/.test(pathname)) return "hub-main";
  if (/^\/app\/community(?:\/|$)/.test(pathname)) return "community-main";
  if (/^\/app\/messages\/?$/.test(pathname)) return "dm-page-conversation-list";
  if (/^\/app\/library\/?$/.test(pathname)) {
    if (search.view === "favorites") return "library-favorites";
    return search.worldId ? "library-detail" : "library-main";
  }
  if (/^\/app\/profile\/?$/.test(pathname)) return "profile-main";
  if (/^\/app\/settings\/?$/.test(pathname)) return "settings-main";
  if (/^\/app\/admin(?:\/|$)/.test(pathname) && !/^\/app\/admin\/world-inspect(?:\/|$)/.test(pathname)) return "admin-main";
  if (/^\/app\/worlds\/create\/?$/.test(pathname) && createPickerActive) return "create-picker";
  if (/^\/app\/users\/[^/]+\/?$/.test(pathname)) return "public-profile-main";
  return undefined;
}

export type MobileReadingPageId = Exclude<ReturnType<typeof getMobileReadingPageId>, undefined>;
