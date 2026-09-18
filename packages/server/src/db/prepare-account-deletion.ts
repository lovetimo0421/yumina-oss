import {
  ensureAccountDeletionForeignKeys,
  isAccountDeletionSchemaReady,
} from "./index.js";

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required; refusing to prepare a local PGlite database");
  }

  console.log("[account-deletion] Preparing database schema and safety constraints...");
  await ensureAccountDeletionForeignKeys();
  if (!isAccountDeletionSchemaReady()) {
    throw new Error("Account-deletion schema did not pass its readiness checks");
  }
  console.log("[account-deletion] Database schema is ready.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[account-deletion] Database preparation failed:", error);
    process.exit(1);
  });
