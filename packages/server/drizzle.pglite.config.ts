import { defineConfig } from "drizzle-kit";

// Local-dev only: push the full schema into the PGlite data dir used when no
// DATABASE_URL is set (see db/index.ts). The PGlite bootstrap DDL in
// ensureTables() lags the real schema (e.g. community threads/posts), so a
// fresh clone needs one `npx drizzle-kit push --config=drizzle.pglite.config.ts`
// before first `pnpm dev`.
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  driver: "pglite",
  dbCredentials: {
    url: "./dev.db",
  },
});
