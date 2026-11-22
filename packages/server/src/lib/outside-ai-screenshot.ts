import { makeSignature } from "better-auth/crypto";
import { auth } from "./auth.js";
import { env } from "./env.js";
import { runPlaytest } from "./studio-tools/playtest-runner.js";
import { SCREENSHOT_UI, SCREENSHOTS_PER_HOUR, SHOT_SECRET, SHOT_URL, isScreenshotEnabled } from "./studio-tools/screenshot-tool.js";
import { PLAYTEST_TURNS_PER_HOUR, playtestTurnsLeft, takePlaytestTurns } from "./outside-ai-guards.js";

/**
 * Eyes for an AI that is not ours: the card's real player screen, rendered by
 * the private shot service (packages/screenshot, Microsoft's Playwright image)
 * as the creator would see it. The shot browser signs in with a session made
 * for this one picture and deleted right after.
 */

export { SCREENSHOT_UI, isScreenshotEnabled, SCREENSHOTS_PER_HOUR };

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

/** What the presses did, as the shot service reports it. */
interface ShotReport {
  actions: { did: string; found: boolean; textChanged: boolean; blocked: string[] }[];
  blocked: string[];
  paidWrites: number;
}
/** Billed turns the presses of one screenshot may cause. */
const MAX_PAID_PRESSES = 3;

function readReport(header: string | null): ShotReport | null {
  if (!header) return null;
  try {
    const parsed = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as ShotReport;
    return Array.isArray(parsed.actions) ? parsed : null;
  } catch { return null; }
}

function describeReport(report: ShotReport): string {
  const lines = report.actions.map((a, i) => {
    const outcome = !a.found ? "NOT FOUND on screen" : a.textChanged ? "the screen's words changed" : "nothing on screen changed (a canvas or 3D view can still have moved: look at the picture)";
    return `${i + 1}. ${a.did}: ${outcome}${a.blocked.length ? `; tried to send and was not let through: ${a.blocked.join(", ")}` : ""}`;
  });
  return lines.join("\n");
}

export async function runScreenshot(args: { userId: string; worldId: string; input: Record<string, unknown> }): Promise<{ ok: boolean; result?: unknown; error?: string; image?: { data: string; mimeType: string } }> {
  const { userId, worldId, input } = args;
  if (!isScreenshotEnabled()) return { ok: false, error: "Screenshots are not available right now." };
  const moves = (Array.isArray(input.moves) ? input.moves : [])
    .filter((m): m is string => typeof m === "string" && m.trim().length > 0)
    .map((m) => m.trim().slice(0, 2000)).slice(0, 3);
  if (moves.length && takePlaytestTurns(userId, moves.length) < moves.length) {
    return { ok: false, error: `Playtest limit reached: ${PLAYTEST_TURNS_PER_HOUR} turns per hour. Take the screenshot without moves, or try later.` };
  }
  const actions = (Array.isArray(input.actions) ? input.actions : []).filter((a) => a && typeof a === "object").slice(0, 8);
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
        // Presses happen in a throwaway playthrough, and may write to it and nothing
        // else: the turn, the card's own AI call, a button's action, its variables.
        ...(actions.length > 0 && {
          actions,
          writes: {
            paths: ["messages", "ai-call", "execute-action", "state", "player-state"].map((p) => `/api/sessions/${sessionId}/${p}`),
            paid: ["messages", "ai-call"].map((p) => `/api/sessions/${sessionId}/${p}`),
            max: 16,
            maxPaid: Math.min(MAX_PAID_PRESSES, playtestTurnsLeft(userId)),
          },
        }),
      }),
      signal: AbortSignal.timeout(actions.length > 0 ? 240_000 : 90_000),
    });
    if (!res.ok) return { ok: false, error: `The screenshot could not be taken (${res.status}).` };
    const data = Buffer.from(await res.arrayBuffer()).toString("base64");
    const report = readReport(res.headers.get("x-shot-report"));
    // The turns the presses caused count like typed moves.
    if (report?.paidWrites) takePlaytestTurns(userId, report.paidWrites);
    const pressed = actions.length === 0 ? ""
      : report ? `\nWhat the presses did:\n${describeReport(report)}`
      : "\nThe presses were not carried out (the screenshot service does not support them yet); this is the screen without them.";
    return {
      ok: true,
      result: `Screenshot of the player screen (${device}${moves.length ? `, after ${moves.length} move(s)` : ", the opening"}${actions.length && report ? `, after ${report.actions.length} press(es)` : ""}). Playtest session ${sessionId}.${pressed}`,
      image: { data, mimeType: "image/png" },
    };
  } catch (error) {
    return { ok: false, error: `The screenshot could not be taken: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    await authContext.internalAdapter.deleteSession(created.token).catch(() => {});
  }
}
