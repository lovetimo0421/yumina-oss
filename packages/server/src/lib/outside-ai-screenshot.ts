import { makeSignature } from "better-auth/crypto";
import { auth } from "./auth.js";
import { env } from "./env.js";
import type { ToolDefinition } from "./llm/types.js";
import { runPlaytest } from "./studio-tools/playtest-runner.js";
import { PLAYTEST_TURNS_PER_HOUR, takePlaytestTurns } from "./outside-ai-guards.js";

/**
 * Eyes for an AI that is not ours: the card's real player screen, rendered by
 * the private shot service (packages/screenshot, Microsoft's Playwright image)
 * as the creator would see it. The shot browser signs in with a session made
 * for this one picture and deleted right after.
 */

const SHOT_URL = process.env.SCREENSHOT_URL ?? "";
const SHOT_SECRET = process.env.SCREENSHOT_SECRET ?? "";

export function isScreenshotEnabled(): boolean {
  return Boolean(SHOT_URL && SHOT_SECRET && env.APP_URL);
}

/** Screenshots an outside AI may take for one creator per hour (per instance). */
export const SCREENSHOTS_PER_HOUR = 30;
const shotTimes = new Map<string, number[]>();

function takeShot(userId: string): boolean {
  const now = Date.now();
  const recent = (shotTimes.get(userId) ?? []).filter((t) => now - t < 3600_000);
  if (recent.length >= SCREENSHOTS_PER_HOUR) { shotTimes.set(userId, recent); return false; }
  recent.push(now);
  shotTimes.set(userId, recent);
  return true;
}

const VIEWPORTS = { desktop: { width: 1280, height: 800 }, mobile: { width: 390, height: 844 } } as const;

export const SCREENSHOT_UI: ToolDefinition = {
  type: "function",
  function: {
    name: "screenshot_ui",
    description:
      "See the card the way a player does: starts a throwaway playthrough, optionally plays a few moves, and returns a screenshot of the real player screen (the custom interface, the opening, the replies). " +
      "Use it after changing the interface or the opening to check how it actually looks. Without moves it is free; each move is a real playtest turn that costs the creator mushies and counts toward the " +
      `${PLAYTEST_TURNS_PER_HOUR}-turns-an-hour playtest limit. At most ${SCREENSHOTS_PER_HOUR} screenshots an hour.`,
    parameters: {
      type: "object",
      properties: {
        device: { type: "string", enum: ["desktop", "mobile"], description: "Screen size: desktop (1280×800, default) or mobile (390×844)." },
        moves: { type: "array", items: { type: "string" }, maxItems: 3, description: "Optional: up to 3 things a player would type before the screenshot. Each costs a playtest turn." },
        wait_seconds: { type: "number", description: "Extra seconds to let animations settle before the shot (1-10, default 3)." },
      },
    },
  },
};

export async function runScreenshot(args: { userId: string; worldId: string; input: Record<string, unknown> }): Promise<{ ok: boolean; result?: unknown; error?: string; image?: { data: string; mimeType: string } }> {
  const { userId, worldId, input } = args;
  if (!isScreenshotEnabled()) return { ok: false, error: "Screenshots are not available right now." };
  const moves = (Array.isArray(input.moves) ? input.moves : [])
    .filter((m): m is string => typeof m === "string" && m.trim().length > 0)
    .map((m) => m.trim().slice(0, 2000)).slice(0, 3);
  if (moves.length && takePlaytestTurns(userId, moves.length) < moves.length) {
    return { ok: false, error: `Playtest limit reached: ${PLAYTEST_TURNS_PER_HOUR} turns per hour. Take the screenshot without moves, or try later.` };
  }
  if (!takeShot(userId)) return { ok: false, error: `Screenshot limit reached: ${SCREENSHOTS_PER_HOUR} an hour. Try again later.` };

  let sessionId: string;
  try {
    sessionId = (await runPlaytest({ userId, worldId, moves })).sessionId;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const authContext = await auth.$context;
  // A session for this one picture: minutes long, deleted right after; the
  // shot browser can only read with it (packages/screenshot).
  const created = await authContext.internalAdapter.createSession(userId, true,
    { expiresAt: new Date(Date.now() + 3 * 60_000), userAgent: "Yumina screenshot" }, true);
  try {
    const app = new URL(env.APP_URL);
    const cookie = authContext.authCookies.sessionToken;
    const value = `${created.token}.${await makeSignature(created.token, authContext.secret)}`;
    const device = input.device === "mobile" ? "mobile" : "desktop";
    const res = await fetch(`${SHOT_URL}/shot`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-shot-secret": SHOT_SECRET },
      body: JSON.stringify({
        url: `${app.origin}/app/chat/${sessionId}`,
        cookies: [{ name: cookie.name, value, url: app.origin, httpOnly: true, secure: app.protocol === "https:", sameSite: "Lax" }],
        viewport: VIEWPORTS[device],
        waitMs: Math.min(Math.max(Number(input.wait_seconds) || 3, 1), 10) * 1000,
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) return { ok: false, error: `The screenshot could not be taken (${res.status}).` };
    const data = Buffer.from(await res.arrayBuffer()).toString("base64");
    return {
      ok: true,
      result: `Screenshot of the player screen (${device}${moves.length ? `, after ${moves.length} move(s)` : ", the opening"}). Playtest session ${sessionId}.`,
      image: { data, mimeType: "image/png" },
    };
  } catch (error) {
    return { ok: false, error: `The screenshot could not be taken: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    await authContext.internalAdapter.deleteSession(created.token).catch(() => {});
  }
}
