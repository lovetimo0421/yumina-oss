import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { playSessions, worlds, worldPendingEdits } from "../db/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { normalizeGameState } from "../lib/game-state.js";
import { viewerSeesWorkingCopy } from "../lib/working-copy.js";
import {
  GameStateManager,
  ReactionEvaluator,
  runReactionChain,
  resolveCombatTurn,
  migrateWorldDefinition,
} from "@yumina/engine";
import type {
  WorldDefinition,
  Effect,
  EnemyStats,
} from "@yumina/engine";
import type { AppEnv } from "../lib/types.js";

const reactionEvaluator = new ReactionEvaluator();

const combatRoutes = new Hono<AppEnv>();

combatRoutes.use("/*", authMiddleware);

combatRoutes.post("/sessions/:sessionId/action", async (c) => {
  const currentUser = c.get("user");
  const sessionId = c.req.param("sessionId");

  // Validate request body
  const body = await c.req.json<{ action: string }>().catch(() => null);
  if (!body || (body.action !== "attack" && body.action !== "flee")) {
    return c.json({ error: "Invalid action. Must be 'attack' or 'flee'." }, 400);
  }

  // Wrap in transaction with FOR UPDATE to prevent race conditions
  const result = await db.transaction(async (tx) => {
    // Load session with row-level lock
    const sessionRows = await tx.execute(
      sql`SELECT * FROM play_sessions WHERE id = ${sessionId} FOR UPDATE`,
    );

    if (sessionRows.rows.length === 0 || (sessionRows.rows[0] as any).user_id !== currentUser.id) {
      return { error: "Session not found" as const, status: 404 as const };
    }
    const session = sessionRows.rows[0] as { user_id: string; world_id: string; state: Record<string, unknown> };

    // Load world definition
    const worldRows = await tx
      .select()
      .from(worlds)
      .where(eq(worlds.id, session.world_id));

    if (worldRows.length === 0) {
      return { error: "World not found" as const, status: 404 as const };
    }

    // Creator-only overlay: the author's combat turns on their OWN published
    // world run off the held working copy (matches messages.ts / sessions.ts),
    // so unapproved rule/entry edits take effect immediately for them. Players
    // and non-creators keep the approved live schema.
    let combatSchema = worldRows[0]!.schema as unknown as WorldDefinition;
    if (viewerSeesWorkingCopy(worldRows[0]!.status, worldRows[0]!.creatorId, currentUser.id)) {
      const [pend] = await tx
        .select({ schema: worldPendingEdits.schema })
        .from(worldPendingEdits)
        .where(eq(worldPendingEdits.worldId, session.world_id))
        .limit(1);
      if (pend?.schema) combatSchema = pend.schema as unknown as WorldDefinition;
    }

    const worldDef = migrateWorldDefinition(combatSchema);
    const gameState = normalizeGameState(worldDef, session.state);

    // Read combat state from variables
    const vars = gameState.variables;
    if (!vars.combat_active) {
      return { error: "Not in combat" as const, status: 400 as const };
    }

    const enemyData = vars.combat_enemy as Record<string, unknown> | undefined;
    if (!enemyData || typeof enemyData.name !== "string" || typeof enemyData.hp !== "number") {
      return { error: "Invalid combat_enemy data" as const, status: 400 as const };
    }

    const rawHp = vars.hp;
    const rawAttack = vars.attack;
    const rawDefense = vars.defense;

    const player = {
      hp: typeof rawHp === "number" ? rawHp : 0,
      attack: typeof rawAttack === "number" ? rawAttack : 0,
      defense: typeof rawDefense === "number" ? rawDefense : 0,
    };

    const enemyAttack = typeof enemyData.attack === "number" ? enemyData.attack : 0;
    const enemyDefense = typeof enemyData.defense === "number" ? enemyData.defense : 0;
    const enemyMaxHp = typeof enemyData.maxHp === "number" ? enemyData.maxHp : (enemyData.hp as number);
    const enemyFleeRate = typeof enemyData.fleeRate === "number" ? enemyData.fleeRate : undefined;

    const enemy: EnemyStats = {
      name: enemyData.name as string,
      hp: enemyData.hp as number,
      maxHp: enemyMaxHp,
      attack: enemyAttack,
      defense: enemyDefense,
      fleeRate: enemyFleeRate,
    };

    // Resolve combat turn
    const turn = resolveCombatTurn(player, enemy, { type: body.action as "attack" | "flee" });

    // Build effects to apply
    const effects: Effect[] = [
      { variableId: "hp", operation: "set", value: turn.playerHp },
      {
        variableId: "combat_enemy",
        operation: "set",
        value: { ...enemyData, hp: turn.enemyHp },
      },
    ];

    if (turn.combatEnded) {
      effects.push({ variableId: "combat_active", operation: "set", value: false });
      effects.push({
        variableId: "combat_result",
        operation: "set",
        value: turn.combatResult ?? "win",
      });
    }

    // Apply via GameStateManager (respects min/max bounds, fires listeners)
    const stateManager = new GameStateManager(worldDef, gameState);
    const changes = stateManager.applyEffects(effects);

    // Evaluate rules/reactions (e.g., achievements, death triggers)
    const turnEvents = changes.map((ch) => ({
      type: "state:changed" as const,
      variableId: ch.variableId,
      oldValue: ch.oldValue,
      newValue: ch.newValue,
    }));
    runReactionChain(
      reactionEvaluator,
      stateManager,
      turnEvents,
      worldDef.reactions ?? [],
      worldDef.rules ?? [],
    );

    // Save state to DB
    const finalState = stateManager.getSnapshot();
    await tx
      .update(playSessions)
      .set({
        state: finalState as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .where(eq(playSessions.id, sessionId));

    // Return turn result + updated variable values for frontend sync
    return {
      data: {
        turn,
        state: {
          hp: finalState.variables.hp,
          combat_enemy: finalState.variables.combat_enemy,
          combat_active: finalState.variables.combat_active,
          ...(finalState.variables.combat_result != null ? { combat_result: finalState.variables.combat_result } : {}),
        },
      },
    };
  });

  if ("error" in result) {
    return c.json({ error: result.error }, result.status);
  }
  return c.json(result);
});

export { combatRoutes };
