const RELOADED_RELEASE_KEY = "__yumina_reloaded_release__";
const RELEASE_ENDPOINT = "/health/release";
const RELEASE_CHECK_INTERVAL_MS = 5 * 60_000;

interface ReleasePayload {
  release?: unknown;
}

interface ReleaseRefreshDependencies {
  fetchImpl?: typeof fetch;
  storage?: Pick<Storage, "getItem" | "setItem">;
  reload?: () => void;
}

function normalizeRelease(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function shouldReloadForRelease(
  currentRelease: unknown,
  latestRelease: unknown,
  reloadedRelease: unknown,
): boolean {
  const current = normalizeRelease(currentRelease);
  const latest = normalizeRelease(latestRelease);
  const reloaded = normalizeRelease(reloadedRelease);

  return current !== null && latest !== null && current !== latest && reloaded !== latest;
}

export async function refreshForNewRelease(
  currentRelease: unknown,
  dependencies: ReleaseRefreshDependencies = {},
): Promise<boolean> {
  const current = normalizeRelease(currentRelease);
  if (!current) return false;

  const fetchImpl = dependencies.fetchImpl ?? window.fetch.bind(window);
  const storage = dependencies.storage ?? window.sessionStorage;
  const reload = dependencies.reload ?? (() => window.location.reload());

  try {
    const response = await fetchImpl(RELEASE_ENDPOINT, {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!response.ok) return false;

    const payload = (await response.json()) as ReleasePayload;
    const latest = normalizeRelease(payload.release);
    const reloaded = storage.getItem(RELOADED_RELEASE_KEY);

    if (!shouldReloadForRelease(current, latest, reloaded)) return false;

    // Record the target before reloading. If a rolling deploy briefly returns
    // mismatched server/static versions, this prevents a refresh loop.
    storage.setItem(RELOADED_RELEASE_KEY, latest!);
    reload();
    return true;
  } catch {
    // Version checks are recovery-only and must never interrupt the app.
    return false;
  }
}

export function installReleaseRefresh(currentRelease: unknown): () => void {
  if (!normalizeRelease(currentRelease)) return () => {};

  let checking = false;
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      await refreshForNewRelease(currentRelease);
    } finally {
      checking = false;
    }
  };

  const checkWhenVisible = () => {
    if (document.visibilityState === "visible") void check();
  };

  // A short initial delay keeps the check off the critical render path. Focus
  // and visibility checks cover tabs left open while a new deploy completes.
  const initialTimer = window.setTimeout(() => void check(), 10_000);
  const intervalTimer = window.setInterval(() => void check(), RELEASE_CHECK_INTERVAL_MS);
  window.addEventListener("focus", checkWhenVisible);
  document.addEventListener("visibilitychange", checkWhenVisible);

  return () => {
    window.clearTimeout(initialTimer);
    window.clearInterval(intervalTimer);
    window.removeEventListener("focus", checkWhenVisible);
    document.removeEventListener("visibilitychange", checkWhenVisible);
  };
}
