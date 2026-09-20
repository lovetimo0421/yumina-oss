import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ─── Studio agent recovery budget ───────────────────────────────────────────
// A dropped SSE is routine on long Studio runs (transpacific links, proxies,
// tab suspends). The agent survives it: the server keeps iterating and writing
// to the world, and the client falls back to polling agent_runs. That fallback
// is only as good as its budget, and the budget lives as two constants in two
// packages that drifted apart:
//
//   2026-04-16  client HARD_CAP_MS   = 15 min
//   2026-07-17  server ABSOLUTE_TIMEOUT_MS  10 min -> 30 min
//
// For two months every run past the 15-minute mark was reported to the creator
// as a connection failure while the agent was still editing their card. These
// tests pin the invariants that make that class of drift impossible to
// reintroduce silently.

const here = dirname(fileURLToPath(import.meta.url));
const studioStore = readFileSync(join(here, "studio.ts"), "utf8");
const agentRoute = readFileSync(
  join(here, "../../../server/src/routes/agent.ts"),
  "utf8",
);

/** Reads `const NAME = <number literal with _ separators>` out of a source file. */
function readNumericConst(source: string, name: string): number {
  const match = new RegExp(`const ${name}\\s*=\\s*([0-9_]+)`).exec(source);
  assert.ok(match, `${name} not found — was it renamed?`);
  return Number(match[1]!.replace(/_/g, ""));
}

/** Reads `const NAME = <a> * <b> * <c>` (the server writes its timeouts this way). */
function readProductConst(source: string, name: string): number {
  const match = new RegExp(`const ${name}\\s*=\\s*([0-9*\\s]+);`).exec(source);
  assert.ok(match, `${name} not found — was it renamed?`);
  return match[1]!
    .split("*")
    .map((part) => Number(part.trim()))
    .reduce((a, b) => a * b, 1);
}

test("the client outlasts the server: recovery never gives up on a live run", () => {
  const clientCap = readNumericConst(studioStore, "HARD_CAP_MS");
  const serverCap = readProductConst(agentRoute, "ABSOLUTE_TIMEOUT_MS");

  assert.ok(
    clientCap > serverCap,
    `client HARD_CAP_MS (${clientCap}ms) must outlast the server's ABSOLUTE_TIMEOUT_MS ` +
      `(${serverCap}ms). A shorter client budget reports healthy long runs as ` +
      `connection failures while the agent is still editing the world.`,
  );
  // Enough slack for the terminal status write to land and be polled.
  assert.ok(
    clientCap - serverCap >= 60_000,
    `leave at least a minute of margin (currently ${clientCap - serverCap}ms) so the ` +
      `client can observe the server's own terminal status instead of racing it.`,
  );
});

test("the stall watchdog stays well inside the absolute timeout", () => {
  const idle = readProductConst(agentRoute, "IDLE_TIMEOUT_MS");
  const absolute = readProductConst(agentRoute, "ABSOLUTE_TIMEOUT_MS");
  assert.ok(idle < absolute, "IDLE_TIMEOUT_MS must trip before ABSOLUTE_TIMEOUT_MS");
});

test("recovery treats a stale heartbeat as death, not a slow model", () => {
  // The heartbeat bumps updated_at every 5s, so STALE_MS only has to outlast a
  // few missed ticks. It must stay far below the hard cap or a healthy run gets
  // declared dead between polls.
  const stale = readNumericConst(studioStore, "STALE_MS");
  const poll = readNumericConst(studioStore, "POLL_INTERVAL_MS");
  const cap = readNumericConst(studioStore, "HARD_CAP_MS");
  assert.ok(stale >= poll * 4, "STALE_MS must tolerate several missed heartbeats");
  assert.ok(stale < cap, "STALE_MS must be a liveness check, not the overall budget");
});

test("friendlyNetworkError covers Chrome's wording as well as Firefox's", () => {
  const match = /if \(\/([^/]+)\/i\.test\(raw\)\) \{/.exec(
    studioStore.slice(studioStore.indexOf("function friendlyNetworkError")),
  );
  assert.ok(match, "friendlyNetworkError's pattern not found — was it refactored?");
  const pattern = new RegExp(match[1]!, "i");

  // Chrome throws a bare `network error` on a severed response body; Firefox
  // says `NetworkError`. Only the latter used to match, so a creator who waited
  // out a 30-minute run was shown a raw untranslated string.
  for (const raw of [
    "network error",
    "NetworkError when attempting to fetch resource.",
    "Failed to fetch",
    "Load failed",
    "The network connection was lost.",
  ]) {
    assert.ok(pattern.test(raw), `"${raw}" should be recognised as a network drop`);
  }
  assert.ok(
    !pattern.test("Agent stalled — no model output for 3 minutes."),
    "a real server-side error must not be masked as a network drop",
  );
});

test("a disconnected client is fed progress, not just a spinner", () => {
  // Everything below used to wait for the run to finish. A creator watching an
  // information-free banner cannot tell a working agent from a hung one, and
  // the observed behaviour was hitting Stop on runs that were mid-edit.
  const runningBranch = studioStore.slice(
    studioStore.indexOf("// Still running."),
    studioStore.indexOf("consecutiveNetErrs++"),
  );
  assert.ok(runningBranch.length > 0, "the still-running poll branch moved");
  assert.match(
    runningBranch,
    /emitTurns\(data\.committedTurns/,
    "bubbles committed while disconnected must reach the transcript on each poll",
  );
  assert.match(
    runningBranch,
    /onRecoveryProgress\?\.\(/,
    "each poll must report the server's step counter to the UI",
  );
});

test("the heartbeat persists the step counter, not just liveness", () => {
  // Without `iteration` on this write the column only moves when a run pauses
  // for approval, so a recovering client polls a step counter frozen at its
  // starting value and the banner can only ever say "still working".
  const heartbeat = agentRoute.slice(
    agentRoute.indexOf("const heartbeat = setInterval"),
    agentRoute.indexOf("heartbeatTicks++"),
  );
  assert.ok(heartbeat.length > 0, "the heartbeat interval moved");
  assert.match(
    heartbeat,
    /\.set\(\{\s*updatedAt: new Date\(\),\s*iteration\s*\}\)/,
    "the heartbeat UPDATE must carry the live iteration alongside updatedAt",
  );
});
