export const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createdSessionId(responseOk: boolean, payload: unknown): string | null {
  const id = (payload as { data?: { id?: unknown } } | null)?.data?.id;
  return responseOk && typeof id === "string" && SESSION_ID_PATTERN.test(id) ? id : null;
}

export function chatSessionTarget(url: string): {
  matchesChatRoute: boolean;
  sessionId: string | null;
} {
  const match = url.match(/\/app\/chat(?:\/([^/?#]+))?(?:[/?#]|$)/);
  if (!match) return { matchesChatRoute: false, sessionId: null };

  try {
    const id = decodeURIComponent(match[1] ?? "");
    return {
      matchesChatRoute: true,
      sessionId: SESSION_ID_PATTERN.test(id) ? id : null,
    };
  } catch {
    return { matchesChatRoute: true, sessionId: null };
  }
}
