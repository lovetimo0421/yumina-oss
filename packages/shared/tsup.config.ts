import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", "card-code": "src/card-code/index.ts" },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
});
