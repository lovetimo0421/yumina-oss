export function getDesktopSidebarOffset(
  pathname: string,
  sidebarHidden: boolean,
): string {
  if (sidebarHidden) return "0px";
  if (pathname.startsWith("/app/hub")) return "var(--sidebar-collapsed-width)";
  return "calc(var(--sidebar-collapsed-width) + var(--desktop-sidebar-content-gap))";
}
