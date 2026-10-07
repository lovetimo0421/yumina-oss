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
  if (!isOAuthAuthorizeQuery(search)) return null;
  const q = new URLSearchParams(search);
  q.delete("sig");
  q.delete("exp");
  const prompt = (q.get("prompt") ?? "").split(" ").filter((p) => p && p !== "login");
  if (prompt.length) q.set("prompt", prompt.join(" "));
  else q.delete("prompt");
  return `${apiBase}/api/auth/oauth2/authorize?${q.toString()}`;
}
