// A card's own interface asking for a picture (api.images.generate in the
// sandbox). The server draws it the way it draws a reply's picture and never
// charges without the player's yes: while it would cost mushies and this card
// isn't allowed yet, it answers {reason:"consent"} and this asks in Yumina's
// own dialog. Only a real click in the card may open that dialog; card code
// running by itself gets "consent" back and should show its own button. The
// dialog's Draw arms after a moment, and "don't ask again" (checked; the price
// is right above it) is the player's choice: unchecked approves this picture only.
import i18n from "@/lib/i18n";

const apiBase = import.meta.env?.VITE_API_URL || "";

export interface CardImageRequest {
  subject?: string;
  look?: string;
  scene?: string;
  drawId?: string;
}

export interface CardImageResult {
  ok: boolean;
  url?: string;
  reason?: string;
  charged?: number;
  balance?: number;
  freeLeft?: number;
  price?: number;
}

export const CONFIRM_ARM_MS = 800;
// Sessions with the ask open: a second picture while it is up is "busy", so a
// card can't swap the request under the player's cursor.
const asking = new Set<string>();
const DRAW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");

async function post(sessionId: string, request: CardImageRequest, extra: Record<string, unknown> = {}): Promise<CardImageResult> {
  try {
    const r = await fetch(`${apiBase}/api/card-images`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, ...request, ...extra }),
    });
    if (!r.ok) return { ok: false, reason: r.status === 400 ? "invalid" : "unavailable" };
    return ((await r.json()) as { data: CardImageResult }).data;
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

export async function generateCardImage(sessionId: string, raw: unknown, fromClick: boolean): Promise<CardImageResult> {
  const input = (raw ?? {}) as Record<string, unknown>;
  const request: CardImageRequest = {
    subject: text(input.subject, 60) || undefined,
    look: text(input.look, 300) || undefined,
    scene: text(input.scene, 600) || undefined,
    drawId: typeof input.drawId === "string" && DRAW_ID.test(input.drawId) ? input.drawId : crypto.randomUUID(),
  };
  if (!request.subject && !request.scene) return { ok: false, reason: "invalid" };
  let result = await post(sessionId, request);
  if (result.reason === "consent") {
    if (!fromClick) return result;
    if (asking.has(sessionId)) return { ok: false, reason: "busy" };
    asking.add(sessionId);
    let choice: { confirmed: boolean; option: boolean };
    try {
      const { confirmChoice } = await import("@/components/ui/global-confirm-dialog");
      const free = result.freeLeft ?? 0;
      choice = await confirmChoice(
        String(i18n.t("chat:cardImages.ask.body", {
          price: result.price ?? 0,
          defaultValue: "This story wants to draw a picture for you. Each picture costs {{price}} mushies.",
        })) + (free > 0 ? ` ${String(i18n.t("chat:cardImages.ask.free", { count: free, defaultValue: "You have {{count}} free pictures left." }))}` : ""),
        {
          title: String(i18n.t("chat:cardImages.ask.title", { defaultValue: "Let this story draw pictures?" })),
          confirmLabel: String(i18n.t("chat:cardImages.ask.confirm", { defaultValue: "Draw" })),
          tone: "warning",
          // The card chose where the player was clicking; a second click there
          // must not land on Draw.
          armDelayMs: CONFIRM_ARM_MS,
          option: {
            label: String(i18n.t("chat:cardImages.ask.remember", { defaultValue: "Don't ask again for this story" })),
            defaultChecked: true,
          },
        },
      );
    } finally {
      asking.delete(sessionId);
    }
    if (!choice.confirmed) return { ok: false, reason: "declined" };
    result = await post(sessionId, request, { confirmed: true, remember: choice.option });
  }
  if (typeof result.balance === "number" && typeof result.charged === "number") {
    const { syncCreditsFromMessageResponse } = await import("@/edition/slots.state");
    syncCreditsFromMessageResponse({ cost: result.charged, balance: result.balance });
  }
  if (result.reason === "credits" && fromClick) {
    const { handleStreamCreditError } = await import("@/edition/slots.state");
    handleStreamCreditError("NO_CREDITS");
  }
  return result;
}

export async function cancelCardImage(sessionId: string, drawId: unknown): Promise<boolean> {
  if (typeof drawId !== "string" || !DRAW_ID.test(drawId)) return false;
  try {
    const r = await fetch(`${apiBase}/api/card-images/cancel`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, drawId }),
    });
    return r.ok;
  } catch {
    return false;
  }
}
