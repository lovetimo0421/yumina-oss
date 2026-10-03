/**
 * The browser tab title. The server writes the right <title> into the HTML
 * for the first page; this keeps it right as people move around the app.
 *
 * Rule (owner, 2026-09-30): the home page is "Yumina", every other page is
 * just its own name. No "· Yumina" suffix anywhere. The tab follows the UI
 * language through the `common:tabTitle.*` strings; the English words here
 * are the fallback and what tests pin.
 */
import { useSyncExternalStore } from "react";

export type TabTitleKey =
  | "home"
  | "discover"
  | "community"
  | "bundles"
  | "create"
  | "library"
  | "quests"
  | "messages"
  | "profile"
  | "settings"
  | "plans"
  | "creator"
  | "signIn"
  | "createAccount"
  | "krew";

export const TAB_TITLE_EN: Record<TabTitleKey, string> = {
  home: "Yumina",
  discover: "Discover",
  community: "Community",
  bundles: "Bundles",
  create: "Create",
  library: "Library",
  quests: "Quests",
  messages: "Messages",
  profile: "Profile",
  settings: "Settings",
  plans: "Plans",
  creator: "Creator",
  signIn: "Sign in",
  createAccount: "Create account",
  krew: "Krew.io",
};

const SECTION_KEYS: Array<[RegExp, TabTitleKey]> = [
  [/^\/$/, "home"],
  // A world address renders Discover with the preview open; the preview supplies the world name.
  [/^\/@[^/]+\/.+/, "discover"],
  [/^\/app\/hub\/bundles(\/|$)/, "bundles"],
  [/^\/app\/hub(\/|$)/, "discover"],
  [/^\/app\/community(\/|$)/, "community"],
  [/^\/app\/bundles(\/|$)/, "bundles"],
  [/^\/app\/worlds(\/|$)/, "create"],
  [/^\/app\/library(\/|$)/, "library"],
  [/^\/app\/quests(\/|$)/, "quests"],
  [/^\/app\/messages(\/|$)/, "messages"],
  [/^\/app\/profile(\/|$)/, "profile"],
  [/^\/app\/settings(\/|$)/, "settings"],
  [/^\/app\/plans(\/|$)/, "plans"],
  [/^\/app\/creator(\/|$)/, "creator"],
  [/^\/creator(\/|$)/, "creator"],
  [/^\/content(\/|$)/, "creator"],
  [/^\/login$/, "signIn"],
  [/^\/register$/, "createAccount"],
  [/^\/krew(\/|$)/, "krew"],
];

/** Which named page a path belongs to; "home" for anything unlisted. */
export function titleKeyForPath(pathname: string): TabTitleKey {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  for (const [pattern, key] of SECTION_KEYS) {
    if (pattern.test(path)) return key;
  }
  return "home";
}

/** The English tab title for a path. */
export function titleForPath(pathname: string): string {
  return TAB_TITLE_EN[titleKeyForPath(pathname)];
}

/**
 * Something on screen that knows its own name sets it here and clears it when
 * it goes away. An overlay (the world preview) wins over the page under it
 * (a thread, a profile), so closing the overlay hands the tab back to the page.
 */
export type DocumentTitleSource = "overlay" | "page";
const PRIORITY: DocumentTitleSource[] = ["overlay", "page"];

const overrides = new Map<DocumentTitleSource, string>();
const listeners = new Set<() => void>();
let snapshot: string | null = null;

function recompute(): void {
  let next: string | null = null;
  for (const source of PRIORITY) {
    const value = overrides.get(source);
    if (value) {
      next = value;
      break;
    }
  }
  if (next === snapshot) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

export function setDocumentTitleOverride(
  title: string | null | undefined,
  source: DocumentTitleSource = "page",
): void {
  const value = title && title.trim() ? title.trim() : null;
  if (value) overrides.set(source, value);
  else overrides.delete(source);
  recompute();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current override, for tests and non-React callers. */
export function getDocumentTitleOverride(): string | null {
  return snapshot;
}

export function useDocumentTitleOverride(): string | null {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}
