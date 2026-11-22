import { env } from "../env.js";
import type { ToolDefinition } from "../llm/types.js";

/**
 * screenshot_ui's definition and switch, apart from the code that takes the
 * picture (lib/outside-ai-screenshot.ts, which signs a session and plays the
 * card): the Studio's tool list and the card MCP's both read this.
 */

export const SHOT_URL = process.env.SCREENSHOT_URL ?? "";
export const SHOT_SECRET = process.env.SCREENSHOT_SECRET ?? "";

export function isScreenshotEnabled(): boolean {
  return Boolean(SHOT_URL && SHOT_SECRET && env.APP_URL);
}

/** Screenshots one creator's AIs may take per hour (per instance). */
export const SCREENSHOTS_PER_HOUR = 30;
/** Playtest turns per hour, as the description says it (lib/outside-ai-guards.ts keeps the count). */
export const SHOT_PLAYTEST_TURNS_PER_HOUR = 30;

export const SCREENSHOT_UI: ToolDefinition = {
  type: "function",
  function: {
    name: "screenshot_ui",
    description:
      "See the card the way a player does: starts a throwaway playthrough, optionally plays a few moves, and returns a screenshot of the real player screen (the custom interface, the opening, the replies). " +
      "Use it after changing the interface or the opening to check how it actually looks. Without moves it is free; each move is a real playtest turn that costs the creator mushies and counts toward the " +
      `${SHOT_PLAYTEST_TURNS_PER_HOUR}-turns-an-hour playtest limit. At most ${SCREENSHOTS_PER_HOUR} screenshots an hour.`,
    parameters: {
      type: "object",
      properties: {
        device: { type: "string", enum: ["desktop", "mobile"], description: "Screen size: desktop (1280×800, default) or mobile (390×844)." },
        moves: { type: "array", items: { type: "string" }, maxItems: 3, description: "Optional: up to 3 things a player would type before the screenshot. Each costs a playtest turn." },
        wait_seconds: { type: "number", description: "Extra seconds to let animations settle before the shot (1-10, default 3)." },
        actions: {
          type: "array", maxItems: 8,
          description:
            "Optional: use the interface like a player before the picture is taken, in order. Each item is ONE of: " +
            "{\"click\": \"words on the button, tab or link\"} · {\"click\": {\"x\": 640, \"y\": 400}} for a canvas or 3D view · " +
            "{\"key\": \"KeyW\", \"hold_seconds\": 1} to hold a key (walking in 3D: KeyW/KeyA/KeyS/KeyD, Space, Enter) · {\"type\": \"text\"} · {\"wait_seconds\": 2}. " +
            "You get back, per action, whether the target was found, whether the words on screen changed, and anything the press tried to send that was not let through. " +
            "A press that sends the player's turn or calls the card's own AI is a real, billed playtest turn (at most 3 per screenshot).",
          items: { type: "object" },
        },
      },
    },
  },
};

