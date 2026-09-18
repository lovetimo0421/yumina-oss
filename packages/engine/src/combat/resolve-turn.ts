export interface PlayerStats {
  hp: number;
  attack: number;
  defense: number;
}

export interface EnemyStats {
  name: string;
  hp: number;
  /** Not used by the engine — retained for the caller's reference (e.g. server/UI). */
  maxHp: number;
  attack: number;
  defense: number;
  fleeRate?: number;
}

export interface CombatAction {
  type: "attack" | "flee";
}

export interface CombatLogEntry {
  type: "flee_success" | "flee_fail" | "player_attack" | "enemy_attack" | "enemy_counter";
  damage?: number;
  enemyName?: string;
}

export interface TurnResult {
  playerDamageDealt: number;
  enemyDamageDealt: number;
  playerHp: number;
  enemyHp: number;
  fled: boolean;
  combatEnded: boolean;
  combatResult?: "win" | "lose" | "flee";
  log: CombatLogEntry[];
}

function randomInt(min: number, max: number, rng: () => number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function calcDamage(attackerAtk: number, defenderDef: number, rng: () => number): number {
  return Math.max(1, attackerAtk - defenderDef + randomInt(-3, 3, rng));
}

export function resolveCombatTurn(
  player: PlayerStats,
  enemy: EnemyStats,
  action: CombatAction,
  rng: () => number = Math.random,
): TurnResult {
  const log: CombatLogEntry[] = [];
  let playerHp = player.hp;
  let enemyHp = enemy.hp;
  let playerDamageDealt = 0;
  let enemyDamageDealt = 0;

  if (action.type === "flee") {
    const fleeRate = enemy.fleeRate ?? 50;
    if (randomInt(0, 99, rng) < fleeRate) {
      log.push({ type: "flee_success" });
      return {
        playerDamageDealt: 0,
        enemyDamageDealt: 0,
        playerHp,
        enemyHp,
        fled: true,
        combatEnded: true,
        combatResult: "flee",
        log,
      };
    }
    log.push({ type: "flee_fail" });
    enemyDamageDealt = calcDamage(enemy.attack, player.defense, rng);
    playerHp = Math.max(0, playerHp - enemyDamageDealt);
    log.push({ type: "enemy_counter", damage: enemyDamageDealt, enemyName: enemy.name });
    return {
      playerDamageDealt: 0,
      enemyDamageDealt,
      playerHp,
      enemyHp,
      fled: false,
      combatEnded: playerHp <= 0,
      combatResult: playerHp <= 0 ? "lose" : undefined,
      log,
    };
  }

  playerDamageDealt = calcDamage(player.attack, enemy.defense, rng);
  enemyHp = Math.max(0, enemyHp - playerDamageDealt);
  log.push({ type: "player_attack", damage: playerDamageDealt });

  if (enemyHp <= 0) {
    return {
      playerDamageDealt,
      enemyDamageDealt: 0,
      playerHp,
      enemyHp: 0,
      fled: false,
      combatEnded: true,
      combatResult: "win",
      log,
    };
  }

  enemyDamageDealt = calcDamage(enemy.attack, player.defense, rng);
  playerHp = Math.max(0, playerHp - enemyDamageDealt);
  log.push({ type: "enemy_attack", damage: enemyDamageDealt, enemyName: enemy.name });

  return {
    playerDamageDealt,
    enemyDamageDealt,
    playerHp,
    enemyHp,
    fled: false,
    combatEnded: playerHp <= 0,
    combatResult: playerHp <= 0 ? "lose" : undefined,
    log,
  };
}
