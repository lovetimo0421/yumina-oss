import { defineConfig } from "tsup";
import { copyFile, mkdir } from "node:fs/promises";

// Open-source edition: one entry. The analytics and image workers are hosted
// services and are not part of this tree.
export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  target: "node22",
  onSuccess: async () => {
    await mkdir("dist/migrations", { recursive: true });
    await copyFile("scripts/session-media.sql", "dist/migrations/session-media.sql");
  },
});
