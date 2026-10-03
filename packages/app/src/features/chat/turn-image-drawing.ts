// Per-turn pictures, host side. A reply is drawn after its turn has finished
// (POST /messages/:id/illustrate), so the player can keep playing while it
// draws. Meanwhile the reply carries a client-only `turnImage` status that
// crosses into the sandbox with the message: the chat shows a placeholder,
// then the picture, or says why there isn't one.

export type TurnImageFailureReason = "busy" | "timeout" | "unavailable" | "credits";
export type TurnImageStatus = { status: "drawing" } | { status: "failed"; reason: TurnImageFailureReason };

interface TurnImageSettings { available: boolean; auto: boolean }
interface IllustrateResponse { ok: boolean; reason?: string; content?: string; charged?: number; balance?: number }

const apiBase = import.meta.env.VITE_API_URL || "";
// Reasons the player is told about. "off", "nothing" and "stale" end quietly.
const SHOWN_REASONS = new Set<string>(["busy", "timeout", "unavailable", "credits"]);

let settings: Promise<TurnImageSettings | null> | null = null;
// Latest draw per message: an older draw that finishes late (its reply was
// regenerated meanwhile) must not clear the newer one's placeholder.
const latestDraw = new Map<string, number>();
let drawCounter = 0;

async function turnImageSettings(): Promise<TurnImageSettings | null> {
  settings ??= fetch(`${apiBase}/api/messages/turn-images/settings`, { credentials: "include" })
    .then(async (r) => (r.ok ? ((await r.json()) as { data: TurnImageSettings }).data : null))
    .catch(() => null);
  const value = await settings;
  if (!value) settings = null; // don't cache a failed read
  return value;
}

/** The player flipped the auto switch; read it fresh next turn. */
export function forgetTurnImageSettings(): void {
  settings = null;
}

/** Draws the picture for one reply. `auto` is the after-turn call (skipped
 *  when the player's switch is off); the "draw this scene" button passes false. */
export async function drawTurnImage(messageId: string, auto: boolean, note?: string, fine = false): Promise<IllustrateResponse> {
  const { useChatStore } = await import("@/stores/chat");
  const store = () => useChatStore.getState();
  if (auto) {
    const s = await turnImageSettings();
    if (!s?.available || !s.auto) return { ok: false, reason: "off" };
  }
  const message = store().messages.find((m) => m.id === messageId);
  if (!message || message.role !== "assistant") return { ok: false, reason: "stale" };
  // A second click while drawing is ignored; an after-turn call always runs
  // (a regenerated reply replaces the one still drawing, which comes back stale).
  if (!auto && message.turnImage?.status === "drawing") return { ok: false, reason: "busy" };
  const draw = ++drawCounter;
  latestDraw.set(messageId, draw);
  store().updateMessage(messageId, { turnImage: { status: "drawing" } });

  let result: IllustrateResponse;
  try {
    const r = await fetch(`${apiBase}/api/messages/${messageId}/illustrate`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auto, ...(note ? { note } : {}), ...(fine ? { fine } : {}) }),
    });
    // 403: the player hasn't opted in (Settings › Display › Experimental) — end quietly.
    result = r.ok ? ((await r.json()) as { data: IllustrateResponse }).data
      : { ok: false, reason: r.status === 403 ? "off" : "unavailable" };
  } catch {
    result = { ok: false, reason: "unavailable" };
  }

  if (typeof result.balance === "number") {
    const { syncCreditsFromMessageResponse } = await import("@/edition/slots.state");
    syncCreditsFromMessageResponse({ cost: result.charged ?? 0, balance: result.balance });
  }
  // Asked for by hand and can't pay: straight to the top-up, as chat does.
  if (!auto && result.reason === "credits") {
    const { handleStreamCreditError } = await import("@/edition/slots.state");
    handleStreamCreditError("NO_CREDITS");
  }
  if (latestDraw.get(messageId) !== draw) return result;
  latestDraw.delete(messageId);
  const current = store().messages.find((m) => m.id === messageId);
  if (!current) return result;
  if (result.ok && result.content) {
    const active = current.activeSwipeIndex ?? 0;
    const swipes = current.swipes?.map((s, i) => (i === active ? { ...s, content: result.content! } : s));
    store().updateMessage(messageId, { content: result.content, ...(swipes ? { swipes } : {}), turnImage: undefined });
  } else if (result.reason && SHOWN_REASONS.has(result.reason)) {
    store().updateMessage(messageId, { turnImage: { status: "failed", reason: result.reason as TurnImageFailureReason } });
  } else {
    store().updateMessage(messageId, { turnImage: undefined });
  }
  return result;
}
