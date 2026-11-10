import {
  activeNarrator,
  computeActiveWorldbookIds,
  resolveStation,
  type GameState,
  type WorldDefinition,
} from "@yumina/engine";
import { checkBalance, validateModelAccess } from "./credit-service.js";
import { resolveProviderForModel } from "./resolve-provider.js";

/**
 * Which model narrates this turn.
 *
 * A narrator station may name its own model — a cheap fast one for a hallway
 * dungeon, a strong one for the confrontation it leads to. That is the point
 * of several AIs on one card, and it is also a way to make a card unplayable
 * for somebody, so it is a REQUEST rather than an instruction: the station's
 * model is used only when this particular player can actually run it, and the
 * player's own choice is what happens otherwise.
 *
 * The checks are the same two the turn would apply anyway — can we reach a
 * provider for it, and does their plan allow it — asked early so the answer is
 * a substitution instead of a 403. They cost one extra provider lookup, and
 * only on cards that name a model at all.
 */
export async function pickNarratorModel(opts: {
  worldDef: WorldDefinition;
  state: GameState;
  /** What the player chose (already redirected/defaulted). */
  playerModel: string;
  userId: string;
  forceOfficial: boolean;
}): Promise<{ model: string; station: { id: string; name: string } | null }> {
  const { worldDef, state, playerModel, userId, forceOfficial } = opts;
  const books = worldDef.worldbooks;
  if (!Array.isArray(books) || books.length === 0) return { model: playerModel, station: null };

  const narrator = activeNarrator(books, computeActiveWorldbookIds(books, state));
  if (!narrator) return { model: playerModel, station: null };

  const wanted = resolveStation(narrator)?.model?.trim();
  if (!wanted || wanted === playerModel) {
    return { model: playerModel, station: { id: narrator.id, name: narrator.name } };
  }

  try {
    const provider = await resolveProviderForModel(userId, wanted, { forceOfficial });
    if (!provider) return { model: playerModel, station: { id: narrator.id, name: narrator.name } };
    // A BYOK player runs on their own key: plan gating does not apply to them,
    // and asking would cost a wallet read for an answer nobody uses.
    if (!provider.isByok) {
      const wallet = await checkBalance(userId);
      const access = await validateModelAccess(wallet?.wallet.plan ?? "free", wanted);
      if (!access.allowed) return { model: playerModel, station: { id: narrator.id, name: narrator.name } };
    }
    return { model: wanted, station: { id: narrator.id, name: narrator.name } };
  } catch {
    // A lookup that throws is not a reason to fail the turn — the player's own
    // model was always a valid answer.
    return { model: playerModel, station: { id: narrator.id, name: narrator.name } };
  }
}
