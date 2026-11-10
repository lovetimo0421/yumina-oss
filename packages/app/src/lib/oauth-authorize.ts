const apiBase = import.meta.env?.VITE_API_URL || "";

/**
 * Our OAuth authorization server (Better Auth `oauthProvider`) sends a
 * creator to /login or /oauth/consent with the authorization request in the
 * query, signed (`sig`, `exp`). True when this page is one of those.
 */
export function isOAuthAuthorizeQuery(search: string): boolean {
  const q = new URLSearchParams(search);
  return q.has("client_id") && q.has("sig");
}

/**
 * For a creator who is already signed in when /login opens mid-authorization:
 * the authorize URL that resumes it (the server re-checks everything).
 */
export function oauthAuthorizeResumeUrl(search: string): string | null {
  const path = oauthAuthorizeResumePath(search);
  return path ? `${apiBase}${path}` : null;
}

/**
 * The same request as a same-origin path, for a `returnTo` that has to survive
 * sign-up and the email-verification link (lib/auth-return.ts
 * isOAuthResumeReturnTo). The signature is dropped: the server re-checks the
 * client, redirect URI, scopes and PKCE from scratch.
 */
export function oauthAuthorizeResumePath(search: string): string | null {
  if (!isOAuthAuthorizeQuery(search)) return null;
  const q = new URLSearchParams(search);
  q.delete("sig");
  q.delete("exp");
  const prompt = (q.get("prompt") ?? "").split(" ").filter((p) => p && p !== "login" && p !== "create");
  if (prompt.length) q.set("prompt", prompt.join(" "));
  else q.delete("prompt");
  return `/api/auth/oauth2/authorize?${q.toString()}`;
}
