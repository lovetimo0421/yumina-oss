import { config } from "dotenv";
config({ path: "../../.env" });
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { worlds, user } from "./schema.js";
import { eq } from "drizzle-orm";
import { NIAH_WORLD_DEFINITION } from "./niah-world.js";
import { THREE_KINGDOMS_WORLD_DEFINITION } from "./three-kingdoms-world.js";
import { SURVIVOR_WORLD_DEFINITION } from "./survivor-world.js";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

const db = drizzle(pool);

async function seed() {
  console.log("Seeding database...");

  // Create a system user for demo content if it doesn't exist
  const existingUsers = await db
    .select()
    .from(user)
    .where(eq(user.email, "system@yumina.app"));

  let systemUserId: string;

  if (existingUsers.length === 0) {
    // We'll use a placeholder - in production, the demo world would be created by admin
    // For now, we'll check if any user exists and use the first one
    const anyUser = await db.select().from(user).limit(1);
    if (anyUser.length === 0) {
      console.log(
        "No users found. Please register a user first, then run seed again."
      );
      await pool.end();
      return;
    }
    systemUserId = anyUser[0]!.id;
  } else {
    systemUserId = existingUsers[0]!.id;
  }

  // Seed NIAH: No, I'm Not a Human
  const existingNiah = await db
    .select()
    .from(worlds)
    .where(eq(worlds.name, "No, I'm Not a Human"));

  if (existingNiah.length > 0) {
    console.log("Demo world 'No, I'm Not a Human' already exists. Updating...");
    await db
      .update(worlds)
      .set({
        schema: NIAH_WORLD_DEFINITION as unknown as Record<string, unknown>,
        description: NIAH_WORLD_DEFINITION.description,
        isPublished: true,
        updatedAt: new Date(),
      })
      .where(eq(worlds.id, existingNiah[0]!.id));
    console.log("Demo world 'No, I'm Not a Human' updated.");
  } else {
    await db.insert(worlds).values({
      creatorId: systemUserId,
      name: NIAH_WORLD_DEFINITION.name,
      description: NIAH_WORLD_DEFINITION.description,
      schema: NIAH_WORLD_DEFINITION as unknown as Record<string, unknown>,
      isPublished: true,
    });
    console.log("Demo world 'No, I'm Not a Human' created.");
  }

  // Seed Three Kingdoms: Rise of the Warlord
  const existingTK = await db
    .select()
    .from(worlds)
    .where(eq(worlds.name, "Three Kingdoms: Rise of the Warlord"));

  if (existingTK.length > 0) {
    console.log("Demo world 'Three Kingdoms: Rise of the Warlord' already exists. Updating...");
    await db
      .update(worlds)
      .set({
        schema: THREE_KINGDOMS_WORLD_DEFINITION as unknown as Record<string, unknown>,
        description: THREE_KINGDOMS_WORLD_DEFINITION.description,
        isPublished: true,
        updatedAt: new Date(),
      })
      .where(eq(worlds.id, existingTK[0]!.id));
    console.log("Demo world 'Three Kingdoms: Rise of the Warlord' updated.");
  } else {
    await db.insert(worlds).values({
      creatorId: systemUserId,
      name: THREE_KINGDOMS_WORLD_DEFINITION.name,
      description: THREE_KINGDOMS_WORLD_DEFINITION.description,
      schema: THREE_KINGDOMS_WORLD_DEFINITION as unknown as Record<string, unknown>,
      isPublished: true,
    });
    console.log("Demo world 'Three Kingdoms: Rise of the Warlord' created.");
  }

  // Seed Ashfall Survivors
  const existingSurvivor = await db
    .select()
    .from(worlds)
    .where(eq(worlds.name, "Ashfall Survivors"));

  if (existingSurvivor.length > 0) {
    console.log("Demo world 'Ashfall Survivors' already exists. Updating...");
    await db
      .update(worlds)
      .set({
        schema: SURVIVOR_WORLD_DEFINITION as unknown as Record<string, unknown>,
        description: SURVIVOR_WORLD_DEFINITION.description,
        isPublished: true,
        updatedAt: new Date(),
      })
      .where(eq(worlds.id, existingSurvivor[0]!.id));
    console.log("Demo world 'Ashfall Survivors' updated.");
  } else {
    await db.insert(worlds).values({
      creatorId: systemUserId,
      name: SURVIVOR_WORLD_DEFINITION.name,
      description: SURVIVOR_WORLD_DEFINITION.description,
      schema: SURVIVOR_WORLD_DEFINITION as unknown as Record<string, unknown>,
      isPublished: true,
    });
    console.log("Demo world 'Ashfall Survivors' created.");
  }

  await pool.end();
  console.log("Seed complete!");
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
