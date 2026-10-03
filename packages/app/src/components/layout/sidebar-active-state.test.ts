import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { loadClientModule } from "@/lib/feed-beacon.test-helpers";

const noop = () => {};
const useStore = (state: Record<string, unknown>) => (select: (value: typeof state) => unknown) => select(state);

function renderSidebar(pathname: string) {
  const linkOptions = new Map<string, { exact?: boolean } | undefined>();
  const router = {
    useLocation: () => ({ pathname, searchStr: "" }),
    useRouter: () => ({ navigate: noop }),
    Link: ({ to, children, preload: _preload, activeOptions, ...props }: {
      to: string; children: ReactNode; preload: string; activeOptions?: { exact?: boolean };
    }) => {
      linkOptions.set(to, activeOptions);
      return createElement("a", { ...props, href: to }, children);
    },
  };
  const nav = loadClientModule(new URL("./sidebar-nav-item.tsx", import.meta.url), {
    "@tanstack/react-router": router,
  });
  const routes = loadClientModule(new URL("../../edition/routes.ts", import.meta.url), {
    "./edition": { getEditionInfo: () => ({ features: { hub: true } }) },
  });
  const { Sidebar } = loadClientModule<{ Sidebar: ComponentType }>(new URL("./sidebar.tsx", import.meta.url), {
    "@tanstack/react-router": router,
    "./sidebar-nav-item": nav,
    "@/edition/routes": routes,
    "@/hooks/use-auth-guard": { useAuthGuard: () => ({ isAuthenticated: true, requireAuth: noop }) },
    "@/stores/ui": { useUiStore: useStore({ mobileNavOpen: false, closeMobileNav: noop, recentPlayedWorlds: [], removeRecentPlayedWorld: noop }) },
    "@/stores/worlds": { useWorldsStore: useStore({ worlds: [] }) },
    "@/stores/user-profile": { useUserProfileStore: useStore({ profile: { name: "Admin", role: "admin" } }) },
    "@/edition/slots.state": { useCreditStore: useStore({ balance: 0 }) },
    "@/edition/edition": { useEdition: () => ({ features: { hub: true, community: true, socialProfiles: true, admin: true } }), useIsLocalEdition: () => false },
    "@/stores/library-search": { useLibrarySearchStore: useStore({ requestDefaultView: noop }) },
    "@/lib/plan-theme": { MushroomIcon: () => null },
    "@/lib/format-mushies": { floorMushies: (value: number) => value },
    "@/hooks/use-touch-device": { isIOS: () => false },
    "@/lib/feedback": { feedback: {} },
    "react-i18next": { useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }) },
  });
  const dom = new JSDOM(renderToStaticMarkup(createElement(Sidebar)));
  const active = Array.from(dom.window.document.querySelectorAll(".sidebar-nav-item--active .sidebar-nav-label"), node => node.textContent);
  dom.window.close();
  return { active, linkOptions };
}

test("the sidebar highlights exactly the current section, including its child pages", () => {
  for (const [pathname, label] of [
    ["/", "nav.discover"],
    ["/app/community", "nav.community"],
    ["/app/community/thread/story", "nav.community"],
    ["/app/library", "nav.library"],
    ["/app/profile", "nav.profile"],
    ["/app/profile/settings", "nav.profile"],
    ["/app/worlds/create", "nav.create"],
    ["/app/admin/editorial", "nav.admin"],
  ]) {
    assert.deepEqual(renderSidebar(pathname!).active, [label], pathname);
  }
});

test("unrelated routes and similar prefixes do not highlight Discover or another section", () => {
  for (const pathname of ["/@author", "/app/plans", "/app/library-extra", "/app/community-extra"]) {
    assert.deepEqual(renderSidebar(pathname).active, [], pathname);
  }
});

test("the Discover link also asks the router for an exact active match", () => {
  assert.equal(renderSidebar("/app/community").linkOptions.get("/")?.exact, true);
});
