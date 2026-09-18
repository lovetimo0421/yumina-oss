/**
 * Picks up new builds without asking. Detection is unchanged from the old
 * toast (entry-script hash on pageshow/visibility/focus/online, 60s throttle).
 * When a build is pending we reload at the next SAFE moment: a route change, or
 * returning from 30+ minutes in the background, and only when nothing would be
 * lost (see reload-safety.ts). After 6h with no safe moment, one persistent
 * pill offers a manual Refresh. Spec §5.
 */
import type { AnyRouter } from "@tanstack/react-router";
import i18n from "./i18n";
import { feedback } from "./feedback";
import { captureHubEvent } from "./analytics";
import { isSafeToReload, isProtectedPath, activeReloadHolds, type ReloadSnapshot } from "./reload-safety";
import { useChatStore } from "@/stores/chat";
import { useEditorStore } from "@/stores/editor";
import { useStudioStore } from "@/stores/studio";

const CHECK_THROTTLE_MS = 60_000;
const RESUME_AFTER_HIDDEN_MS = 30 * 60_000;
const RESUME_WINDOW_MS = 5_000;
const FALLBACK_AFTER_MS = 6 * 60 * 60_000;
const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "email", "tel", "password", "number", ""]);

let pendingBuild: string | null = null;
let pendingSince = 0;
let fallbackShownFor: string | null = null;
let lastCheckAt = 0;
let checkInFlight = false;
let hiddenAt = 0;
let resumeEligibleUntil = 0;

const tr = (key: string, fallback: string) =>
  (i18n.t as (k: string, o?: Record<string, unknown>) => string)(key, { defaultValue: fallback });

function loadedEntryScript(): string | null {
  const el = document.querySelector<HTMLScriptElement>('script[type="module"][src]');
  return el?.getAttribute("src") ?? null;
}

async function deployedEntryScript(): Promise<string | null> {
  const res = await fetch("/index.html", { cache: "no-store" });
  if (!res.ok) return null;
  const html = await res.text();
  return html.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/)?.[1] ?? null;
}

function textEntryHasContent(): boolean {
  const active = document.activeElement as HTMLElement | null;
  if (active instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(active.type) && active.value.length > 0) return true;
  if (active?.isContentEditable && (active.textContent ?? "").trim().length > 0) return true;
  // Composers are textareas (chat, DM, community). A draft that lost focus to a
  // nav click is exactly what the 2026-08-10 auto-reload destroyed.
  for (const ta of document.querySelectorAll<HTMLTextAreaElement>("textarea")) {
    if (!ta.disabled && !ta.readOnly && ta.value.trim().length > 0) return true;
  }
  return false;
}

export function collectReloadSnapshot(): ReloadSnapshot {
  const studio = useStudioStore.getState();
  return {
    textEntryHasContent: textEntryHasContent(),
    chatStreaming: useChatStore.getState().isStreaming,
    editorDirty: useEditorStore.getState().isDirty,
    studioBusy: studio.isAgentWorking || studio.isChatStreaming,
    dialogOpen: !!document.querySelector(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
    ),
    holds: activeReloadHolds(),
    protectedRoute: isProtectedPath(window.location.pathname),
  };
}

function reloadNow(trigger: "navigate" | "resume" | "manual", href?: string): void {
  captureHubEvent("deploy_reload", { trigger });
  if (href) window.location.assign(href);
  else window.location.reload();
}

function tryReload(trigger: "navigate" | "resume", href?: string): boolean {
  if (!pendingBuild) return false;
  if (!isSafeToReload(collectReloadSnapshot())) return false;
  reloadNow(trigger, href);
  return true;
}

function markPending(deployed: string): void {
  if (pendingBuild === deployed) return;
  pendingBuild = deployed;
  pendingSince = Date.now();
}

function maybeShowFallback(): void {
  if (!pendingBuild || fallbackShownFor === pendingBuild) return;
  if (Date.now() - pendingSince < FALLBACK_AFTER_MS) return;
  fallbackShownFor = pendingBuild;
  feedback.persistent(
    tr("common:feedback.updateReady", "Update ready"),
    { label: tr("common:action.refresh", "Refresh"), onClick: () => reloadNow("manual") },
    { id: "deploy-refresh" },
  );
}

export function checkForNewDeployment(force = false): void {
  if (checkInFlight) return;
  const now = Date.now();
  if (!force && now - lastCheckAt < CHECK_THROTTLE_MS) return;
  const loaded = loadedEntryScript();
  if (!loaded) return;
  lastCheckAt = now;
  checkInFlight = true;
  void deployedEntryScript()
    .then((deployed) => {
      if (!deployed || deployed === loaded) return;
      markPending(deployed);
      if (Date.now() < resumeEligibleUntil && tryReload("resume")) return;
      maybeShowFallback();
    })
    .catch(() => {
      /* offline or unreachable — keep the working page */
    })
    .finally(() => {
      checkInFlight = false;
    });
}

export function installDeployRefresh(router: AnyRouter): void {
  // Back-forward cache restores can resurrect an index.html whose chunks are
  // gone after a deploy; only a real entry-script change counts (a failed probe
  // deliberately does nothing — never tear down a working page over a probe).
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) checkForNewDeployment(true);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now();
      return;
    }
    const hiddenFor = hiddenAt ? Date.now() - hiddenAt : 0;
    hiddenAt = 0;
    if (hiddenFor >= RESUME_AFTER_HIDDEN_MS) {
      resumeEligibleUntil = Date.now() + RESUME_WINDOW_MS;
      if (tryReload("resume")) return;
    }
    checkForNewDeployment(hiddenFor >= RESUME_AFTER_HIDDEN_MS);
  });
  window.addEventListener("focus", () => checkForNewDeployment());
  window.addEventListener("online", () => checkForNewDeployment(true));

  router.subscribe("onBeforeNavigate", (event) => {
    if (!pendingBuild || !event.pathChanged) return;
    tryReload("navigate", event.toLocation.href);
  });

  if (import.meta.env.DEV) {
    // Manual QA: window.__testDeployReload() marks a fake build pending and
    // forces the fallback pill; then navigate to see the safe-moment reload.
    (window as unknown as Record<string, unknown>).__testDeployReload = (script = "dev-fake-entry.js") => {
      markPending(script);
      pendingSince = Date.now() - FALLBACK_AFTER_MS;
      maybeShowFallback();
    };
  }
}
