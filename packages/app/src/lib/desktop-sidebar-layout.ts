import { isDiscoverAddress } from "./discover-genre";

export function getDesktopSidebarOffset(
  pathname: string,
  sidebarHidden: boolean,
): string {
  if (sidebarHidden) return "0px";
  if (isDiscoverAddress(pathname) || pathname.replace(/\/$/, "") === "/app/generate") return "var(--sidebar-collapsed-width)";
  return "calc(var(--sidebar-collapsed-width) + var(--desktop-sidebar-content-gap))";
}
