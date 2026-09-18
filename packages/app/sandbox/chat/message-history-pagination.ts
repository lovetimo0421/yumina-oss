export const EARLIER_HISTORY_TOP_PX = 80;

export type EarlierHistoryAction =
  | "none"
  | "reveal-local"
  | "load-server"
  | "reveal-and-load";

/**
 * Keep the render window and server page independent internally, but expose
 * them as one history action to the player. A session can have older rows both
 * inside the browser's 200-message window and on the server.
 */
export function getEarlierHistoryAction(
  hiddenLocalCount: number,
  hasEarlierServerMessages: boolean,
): EarlierHistoryAction {
  if (hiddenLocalCount > 0 && hasEarlierServerMessages) return "reveal-and-load";
  if (hiddenLocalCount > 0) return "reveal-local";
  if (hasEarlierServerMessages) return "load-server";
  return "none";
}

export function shouldAutoRequestEarlierHistory(options: {
  action: EarlierHistoryAction;
  armed: boolean;
  failed: boolean;
  loading: boolean;
  scrollTop: number;
  viewportUnderfilled?: boolean;
}): boolean {
  return (
    options.action !== "none" &&
    (options.armed || options.viewportUnderfilled === true) &&
    !options.failed &&
    !options.loading &&
    options.scrollTop <= EARLIER_HISTORY_TOP_PX
  );
}

export async function executeEarlierHistoryAction(
  action: EarlierHistoryAction,
  callbacks: {
    revealLocal: () => void;
    loadServer: () => Promise<boolean>;
  },
): Promise<boolean> {
  if (action === "none") return false;

  if (action === "reveal-local" || action === "reveal-and-load") {
    callbacks.revealLocal();
  }

  if (action === "reveal-local") return true;

  try {
    return await callbacks.loadServer();
  } catch {
    return false;
  }
}
