import { defineConfig } from "tsup";

// Open-source edition: one entry. The analytics and image workers are hosted
// services and are not part of this tree.
export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  target: "node22",
});
