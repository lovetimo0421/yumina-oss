export interface SessionManagerNavigationOptions {
  sessionId: string;
  navigate: (sessionId: string) => Promise<unknown>;
  close: () => void;
}

/**
 * Keep the session manager visible until the chat route has actually finished
 * loading. Closing first exposes the route underneath (usually Hub) while the
 * chat loader is pending, which looks like the player was kicked back home.
 */
export async function navigateFromSessionManager({
  sessionId,
  navigate,
  close,
}: SessionManagerNavigationOptions): Promise<void> {
  await navigate(sessionId);
  close();
}
