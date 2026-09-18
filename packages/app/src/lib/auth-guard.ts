import { clearSessionCache } from "./auth-client";

let redirecting = false;

const LOGIN_COOLDOWN_KEY = "__yumina_login_ts__";

export function markLoginComplete() {
  try { sessionStorage.setItem(LOGIN_COOLDOWN_KEY, String(Date.now())); } catch {}
}

export function handleAuthLoss() {
  if (redirecting) return;

  // Don't redirect if we just logged in within the last 10 seconds —
  // avoids a redirect loop when polling fires before cookies propagate.
  try {
    const loginTs = Number(sessionStorage.getItem(LOGIN_COOLDOWN_KEY) || 0);
    if (Date.now() - loginTs < 10_000) return;
  } catch {}

  // Don't redirect if we're already on the login page
  if (window.location.pathname === "/login" || window.location.pathname === "/register") return;

  redirecting = true;
  clearSessionCache();
  window.location.href = "/login";
}
