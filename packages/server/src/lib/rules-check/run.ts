// check_rules plays a card's multiplayer rules file in the realtime game
// server's sandbox (packages/game-server), which is hosted-only. The
// open-source edition keeps the tool's shape and says it is not available.
import type { WorldDefinition } from "@yumina/engine";

export type CheckRulesOutcome = { ok: true; result: Record<string, unknown> & { file: string } } | { ok: false; error: string };

export async function executeCheckRules(_world: WorldDefinition, _args: Record<string, unknown>): Promise<CheckRulesOutcome> {
  return { ok: false, error: "check_rules needs the multiplayer game server, which is not part of the open-source edition." };
}
