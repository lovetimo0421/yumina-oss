import { describe, it, expect } from "vitest";
import { resolveCombatTurn } from "../combat/resolve-turn.js";
import type { PlayerStats, EnemyStats, CombatAction } from "../combat/resolve-turn.js";

describe("resolveCombatTurn", () => {
  const player: PlayerStats = { hp: 100, attack: 20, defense: 5 };
  const enemy: EnemyStats = {
    name: "Goblin",
    hp: 50,
    maxHp: 50,
    attack: 10,
    defense: 3,
  };

  // Deterministic RNG for predictable tests
  function fixedRng(value: number) {
    return () => value;
  }

  it("attack deals damage to enemy and enemy counterattacks", () => {
    const action: CombatAction = { type: "attack" };
    const result = resolveCombatTurn(player, enemy, action);
    expect(result.playerDamageDealt).toBeGreaterThanOrEqual(14);
    expect(result.playerDamageDealt).toBeLessThanOrEqual(20);
    expect(result.enemyHp).toBe(enemy.hp - result.playerDamageDealt);
    expect(result.enemyDamageDealt).toBeGreaterThanOrEqual(2);
    expect(result.enemyDamageDealt).toBeLessThanOrEqual(8);
    expect(result.playerHp).toBe(player.hp - result.enemyDamageDealt);
    expect(result.fled).toBe(false);
    expect(result.log.length).toBeGreaterThanOrEqual(2);
    // Log entries should be structured objects
    expect(result.log[0]).toHaveProperty("type", "player_attack");
    expect(result.log[0]).toHaveProperty("damage");
  });

  it("deterministic results with fixed rng", () => {
    // rng=0.5 → randomInt maps to middle of range → randomInt(-3,3) = 0
    const result = resolveCombatTurn(player, enemy, { type: "attack" }, fixedRng(0.5));
    // damage = max(1, 20-3+0) = 17
    expect(result.playerDamageDealt).toBe(17);
    // enemy damage = max(1, 10-5+0) = 5
    expect(result.enemyDamageDealt).toBe(5);
  });

  it("enemy dies when hp reaches 0", () => {
    const weakEnemy: EnemyStats = { ...enemy, hp: 1, defense: 0 };
    const action: CombatAction = { type: "attack" };
    const result = resolveCombatTurn(player, weakEnemy, action);
    expect(result.enemyHp).toBe(0);
    expect(result.combatEnded).toBe(true);
    expect(result.combatResult).toBe("win");
    expect(result.enemyDamageDealt).toBe(0);
  });

  it("player dies when hp reaches 0", () => {
    const weakPlayer: PlayerStats = { hp: 1, attack: 5, defense: 0 };
    const strongEnemy: EnemyStats = { ...enemy, attack: 50, defense: 100 };
    const action: CombatAction = { type: "attack" };
    const result = resolveCombatTurn(weakPlayer, strongEnemy, action);
    expect(result.playerHp).toBe(0);
    expect(result.combatEnded).toBe(true);
    expect(result.combatResult).toBe("lose");
  });

  it("damage floor is 1 even when defense exceeds attack", () => {
    const tankEnemy: EnemyStats = { ...enemy, defense: 999 };
    const action: CombatAction = { type: "attack" };
    const result = resolveCombatTurn(player, tankEnemy, action);
    expect(result.playerDamageDealt).toBe(1);
  });

  it("flee succeeds with high fleeRate", () => {
    const fleeableEnemy: EnemyStats = { ...enemy, fleeRate: 100 };
    const action: CombatAction = { type: "flee" };
    const result = resolveCombatTurn(player, fleeableEnemy, action);
    expect(result.fled).toBe(true);
    expect(result.combatEnded).toBe(true);
    expect(result.combatResult).toBe("flee");
    expect(result.playerDamageDealt).toBe(0);
    expect(result.enemyDamageDealt).toBe(0);
    expect(result.log[0]).toHaveProperty("type", "flee_success");
  });

  it("flee fails with 0 fleeRate, enemy gets free attack", () => {
    const unfleeableEnemy: EnemyStats = { ...enemy, fleeRate: 0 };
    const action: CombatAction = { type: "flee" };
    const result = resolveCombatTurn(player, unfleeableEnemy, action);
    expect(result.fled).toBe(false);
    expect(result.combatEnded).toBe(false);
    expect(result.playerDamageDealt).toBe(0);
    expect(result.enemyDamageDealt).toBeGreaterThanOrEqual(1);
    expect(result.log[0]).toHaveProperty("type", "flee_fail");
    expect(result.log[1]).toHaveProperty("type", "enemy_counter");
  });

  it("hp never goes below 0", () => {
    const weakPlayer: PlayerStats = { hp: 1, attack: 1, defense: 0 };
    const strongEnemy: EnemyStats = { ...enemy, hp: 500, attack: 999, defense: 0 };
    const result = resolveCombatTurn(weakPlayer, strongEnemy, { type: "attack" });
    expect(result.playerHp).toBe(0);
    expect(result.enemyHp).toBeGreaterThanOrEqual(0);
  });

  it("default fleeRate is 50 when not specified", () => {
    const noFleeRateEnemy: EnemyStats = {
      name: "Test",
      hp: 100,
      maxHp: 100,
      attack: 10,
      defense: 0,
    };
    const results = Array.from({ length: 100 }, () =>
      resolveCombatTurn(player, { ...noFleeRateEnemy }, { type: "flee" })
    );
    const flees = results.filter((r) => r.fled).length;
    expect(flees).toBeGreaterThan(10);
    expect(flees).toBeLessThan(90);
  });

  it("structured log entries have correct shape", () => {
    // Use fixed rng so flee fails deterministically
    const result = resolveCombatTurn(
      player,
      { ...enemy, fleeRate: 0 },
      { type: "flee" },
      fixedRng(0.99), // rng=0.99 → randomInt(0,99)=99 ≥ fleeRate(0) check uses <, so 99 < 0 is false → flee fails
    );
    expect(result.log).toEqual([
      { type: "flee_fail" },
      { type: "enemy_counter", damage: expect.any(Number), enemyName: "Goblin" },
    ]);
  });
});
