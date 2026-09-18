/**
 * One-time script: migrate DND worlds and related sessions to the current
 * official Yumina schema/runtime shape.
 *
 * This does two things:
 * 1. Rewrites DND world schemas to the canonical Cards/DND.json structure.
 * 2. Collapses legacy personal/session variables into the new *-by-user maps.
 *
 * Safe to run multiple times.
 */
import { config } from "dotenv";
config({ path: "../../.env" });

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { migrateWorldDefinition } from "@yumina/engine";
import type { GameState, WorldDefinition } from "@yumina/engine";
import { playSessions, worlds } from "./schema.js";

type JsonRecord = Record<string, unknown>;

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});
const db = drizzle(pool);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const canonicalDndPath = path.resolve(__dirname, "../../../../Cards/DND.json");

const SHARED_VARIABLE_IDS = [
  "session-module",
  "session-rules-mode",
  "combat-meta",
  "combat-order",
  "combat-units",
  "combat-enemies",
] as const;

const BY_USER_VARIABLE_IDS = [
  "session-origin-hooks-by-user",
  "active-character-by-user",
  "character-order-by-user",
  "character-created-by-user",
  "creation-drafts-by-user",
  "character-sheets-by-user",
] as const;

const LEGACY_ROOT_VARIABLE_IDS = [
  "session-origin-hook",
  "active-character-id",
  "character-order",
  "character-created",
  "creation-step",
  "creation-complete",
  "creation-identity",
  "creation-point-buy",
  "creation-abilities",
  "creation-background",
  "creation-species",
  "creation-proficiencies",
  "creation-class",
  "creation-inventory",
  "creation-derived",
  "creation-validation",
  "creation-alignment",
  "character-identity",
  "character-build",
  "character-abilities",
  "character-proficiencies",
  "character-defenses",
  "character-spellcasting",
  "character-resources",
  "character-inventory",
  "character-features",
  "character-notes",
] as const;

const DEFAULT_DRAFT = {
  step: 0,
  complete: false,
  identity: { name: "", gender: "", species: "", class: "", level: 1, subclass: "" },
  pointBuy: {
    budget: 27,
    spent: 0,
    remaining: 27,
    min: 8,
    max: 15,
    costTable: { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 },
    baseScores: { STR: 8, DEX: 8, CON: 8, INT: 8, WIS: 8, CHA: 8 },
  },
  abilities: {
    baseScores: { STR: 8, DEX: 8, CON: 8, INT: 8, WIS: 8, CHA: 8 },
    speciesBonuses: { STR: 0, DEX: 0, CON: 0, INT: 0, WIS: 0, CHA: 0 },
    finalScores: { STR: 8, DEX: 8, CON: 8, INT: 8, WIS: 8, CHA: 8 },
    modifiers: { STR: -1, DEX: -1, CON: -1, INT: -1, WIS: -1, CHA: -1 },
  },
  background: {
    mechanicalBackground: "",
    originHookPreset: "",
    originHookCustom: "",
    backgroundSkills: [] as unknown[],
    toolChoices: [] as unknown[],
    languageChoices: [] as unknown[],
  },
  species: {
    bonusSkills: [] as unknown[],
    languageChoices: [] as unknown[],
    toolChoices: [] as unknown[],
    abilityChoices: [] as unknown[],
    featChoices: [] as unknown[],
    weaponChoices: [] as unknown[],
    cantripChoices: [] as unknown[],
  },
  proficiencies: {
    saves: [] as unknown[],
    skills: [] as unknown[],
    expertise: [] as unknown[],
    tools: [] as unknown[],
    armor: [] as unknown[],
    weapons: [] as unknown[],
    languages: [] as unknown[],
  },
  class: {
    classSkills: [] as unknown[],
    fightingStyle: "",
    cantrips: [] as unknown[],
    spellsKnown: [] as unknown[],
    preparedSpells: [] as unknown[],
    invocations: [] as unknown[],
    subclass: "",
    advancementChoices: [] as unknown[],
  },
  inventory: {
    budget: 500,
    spent: 0,
    remaining: 500,
    selected: [] as unknown[],
  },
  derived: {
    proficiencyBonus: 2,
    hpMax: 0,
    acBase: 10,
    initiative: 0,
    passivePerception: 10,
    equipmentBudget: 500,
    equipmentSpent: 0,
    equipmentRemaining: 500,
  },
  validation: {
    coreReady: false,
    choicesReady: false,
    previewReady: false,
    coreIssues: [] as unknown[],
    coreAutoFilled: [] as unknown[],
  },
  alignment: "",
};

const DEFAULT_SHEET = {
  identity: {},
  build: {},
  abilities: {},
  proficiencies: {},
  defenses: {},
  spellcasting: {},
  resources: {},
  inventory: {},
  features: {},
  notes: {},
};

const DEFAULT_ORIGIN_HOOK = { presetId: "", title: "", customText: "" };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function readRecord(value: unknown): JsonRecord {
  return isRecord(value) ? { ...value } : {};
}

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function readNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? clone(value) : [];
}

function readObject(value: unknown, fallback: JsonRecord): JsonRecord {
  return isRecord(value) ? clone(value) : clone(fallback);
}

function hasOwnKey(record: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isDndWorld(world: { name: string; schema: Record<string, unknown> }, canonical: WorldDefinition): boolean {
  const schema = readRecord(world.schema);
  return (
    world.name === canonical.name ||
    readString(schema.name) === canonical.name ||
    readString(schema.id) === canonical.id
  );
}

function mergeCanonicalDndSchema(
  existingSchema: Record<string, unknown>,
  canonical: WorldDefinition,
): WorldDefinition {
  const migratedExisting = migrateWorldDefinition(existingSchema as unknown as WorldDefinition);
  return {
    ...canonical,
    id: migratedExisting.id || canonical.id,
    name: migratedExisting.name || canonical.name,
    description: migratedExisting.description || canonical.description,
    author: migratedExisting.author || canonical.author,
    ...(migratedExisting.avatar ? { avatar: migratedExisting.avatar } : canonical.avatar ? { avatar: canonical.avatar } : {}),
  };
}

function buildDraftFromLegacy(source: JsonRecord): JsonRecord {
  return {
    step: readNumber(source["creation-step"], DEFAULT_DRAFT.step),
    complete: readBoolean(source["creation-complete"], DEFAULT_DRAFT.complete),
    identity: readObject(source["creation-identity"], DEFAULT_DRAFT.identity),
    pointBuy: readObject(source["creation-point-buy"], DEFAULT_DRAFT.pointBuy),
    abilities: readObject(source["creation-abilities"], DEFAULT_DRAFT.abilities),
    background: readObject(source["creation-background"], DEFAULT_DRAFT.background),
    species: readObject(source["creation-species"], DEFAULT_DRAFT.species),
    proficiencies: readObject(source["creation-proficiencies"], DEFAULT_DRAFT.proficiencies),
    class: readObject(source["creation-class"], DEFAULT_DRAFT.class),
    inventory: readObject(source["creation-inventory"], DEFAULT_DRAFT.inventory),
    derived: readObject(source["creation-derived"], DEFAULT_DRAFT.derived),
    validation: readObject(source["creation-validation"], DEFAULT_DRAFT.validation),
    alignment: readString(source["creation-alignment"], DEFAULT_DRAFT.alignment),
  };
}

function buildSheetFromLegacy(source: JsonRecord): JsonRecord {
  return {
    identity: readObject(source["character-identity"], DEFAULT_SHEET.identity),
    build: readObject(source["character-build"], DEFAULT_SHEET.build),
    abilities: readObject(source["character-abilities"], DEFAULT_SHEET.abilities),
    proficiencies: readObject(source["character-proficiencies"], DEFAULT_SHEET.proficiencies),
    defenses: readObject(source["character-defenses"], DEFAULT_SHEET.defenses),
    spellcasting: readObject(source["character-spellcasting"], DEFAULT_SHEET.spellcasting),
    resources: readObject(source["character-resources"], DEFAULT_SHEET.resources),
    inventory: readObject(source["character-inventory"], DEFAULT_SHEET.inventory),
    features: readObject(source["character-features"], DEFAULT_SHEET.features),
    notes: readObject(source["character-notes"], DEFAULT_SHEET.notes),
  };
}

function migrateDndSessionState(
  rawState: unknown,
  ownerUserId: string,
  canonical: WorldDefinition,
): GameState {
  const state = readRecord(rawState);
  const rootVariables = readRecord(state.variables);
  const rootPersonal = readRecord(state.personalVariables);
  const nextVariables: JsonRecord = {};
  const userIds = new Set<string>([ownerUserId]);

  for (const variableId of SHARED_VARIABLE_IDS) {
    const variableDef = canonical.variables.find((variable) => variable.id === variableId);
    nextVariables[variableId] = hasOwnKey(rootVariables, variableId)
      ? clone(rootVariables[variableId])
      : clone(variableDef?.defaultValue ?? null);
  }

  for (const variableId of BY_USER_VARIABLE_IDS) {
    nextVariables[variableId] = readRecord(rootVariables[variableId]);
    for (const userId of Object.keys(readRecord(nextVariables[variableId]))) {
      userIds.add(userId);
    }
  }

  for (const userId of Object.keys(rootPersonal)) {
    userIds.add(userId);
  }

  for (const userId of userIds) {
    const perUserSource = isRecord(rootPersonal[userId]) ? readRecord(rootPersonal[userId]) : rootVariables;

    const originHooks = readRecord(nextVariables["session-origin-hooks-by-user"]);
    if (!hasOwnKey(originHooks, userId) && hasOwnKey(perUserSource, "session-origin-hook")) {
      originHooks[userId] = readObject(perUserSource["session-origin-hook"], DEFAULT_ORIGIN_HOOK);
      nextVariables["session-origin-hooks-by-user"] = originHooks;
    }

    const activeCharacters = readRecord(nextVariables["active-character-by-user"]);
    if (!hasOwnKey(activeCharacters, userId) && hasOwnKey(perUserSource, "active-character-id")) {
      activeCharacters[userId] = readString(perUserSource["active-character-id"], "");
      nextVariables["active-character-by-user"] = activeCharacters;
    }

    const characterOrders = readRecord(nextVariables["character-order-by-user"]);
    if (!hasOwnKey(characterOrders, userId) && hasOwnKey(perUserSource, "character-order")) {
      characterOrders[userId] = readArray(perUserSource["character-order"]);
      nextVariables["character-order-by-user"] = characterOrders;
    }

    const characterCreated = readRecord(nextVariables["character-created-by-user"]);
    if (!hasOwnKey(characterCreated, userId) && hasOwnKey(perUserSource, "character-created")) {
      characterCreated[userId] = readBoolean(perUserSource["character-created"], false);
      nextVariables["character-created-by-user"] = characterCreated;
    }

    const creationDrafts = readRecord(nextVariables["creation-drafts-by-user"]);
    if (!hasOwnKey(creationDrafts, userId)) {
      creationDrafts[userId] = buildDraftFromLegacy(perUserSource);
      nextVariables["creation-drafts-by-user"] = creationDrafts;
    }

    const characterSheets = readRecord(nextVariables["character-sheets-by-user"]);
    if (!hasOwnKey(characterSheets, userId)) {
      characterSheets[userId] = buildSheetFromLegacy(perUserSource);
      nextVariables["character-sheets-by-user"] = characterSheets;
    }
  }

  const nextState: GameState = {
    worldId: readString(state.worldId, canonical.id),
    variables: nextVariables as GameState["variables"],
    turnCount: readNumber(state.turnCount, 0),
    metadata: readRecord(state.metadata),
    ...(isRecord(state.ruleState)
      ? { ruleState: state.ruleState as unknown as GameState["ruleState"] }
      : {}),
  };

  if ("activeCharacterId" in state) {
    nextState.activeCharacterId =
      typeof state.activeCharacterId === "string" || state.activeCharacterId === null
        ? state.activeCharacterId
        : undefined;
  }

  return nextState;
}

async function loadCanonicalDnd(): Promise<WorldDefinition> {
  const raw = JSON.parse(await fs.readFile(canonicalDndPath, "utf8")) as WorldDefinition;
  return migrateWorldDefinition(raw);
}

async function migrateDndWorlds() {
  const canonical = await loadCanonicalDnd();

  console.log("Loading worlds...");
  const allWorlds = await db.select({ id: worlds.id, name: worlds.name, schema: worlds.schema }).from(worlds);
  const dndWorlds = allWorlds.filter((world) => isDndWorld(world, canonical));

  console.log(`Found ${dndWorlds.length} DND world(s).`);
  if (dndWorlds.length === 0) {
    await pool.end();
    return;
  }

  let migratedWorldCount = 0;
  let migratedSessionCount = 0;

  for (const world of dndWorlds) {
    const nextSchema = mergeCanonicalDndSchema(world.schema, canonical);
    await db
      .update(worlds)
      .set({
        schema: nextSchema as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .where(eq(worlds.id, world.id));
    migratedWorldCount++;

    const sessions = await db
      .select({ id: playSessions.id, userId: playSessions.userId, state: playSessions.state })
      .from(playSessions)
      .where(eq(playSessions.worldId, world.id));

    for (const session of sessions) {
      const nextState = migrateDndSessionState(session.state, session.userId, nextSchema);
      await db
        .update(playSessions)
        .set({
          state: nextState as unknown as Record<string, unknown>,
          updatedAt: new Date(),
        })
        .where(eq(playSessions.id, session.id));
      migratedSessionCount++;
    }
  }

  console.log(`Migrated ${migratedWorldCount} DND world(s) and ${migratedSessionCount} session(s).`);
  await pool.end();
}

migrateDndWorlds().catch(async (error) => {
  console.error("Fatal error while migrating DND worlds:", error);
  await pool.end();
  process.exit(1);
});
