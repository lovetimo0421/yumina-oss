import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

/**
 * Standalone build of the UI preview harness (`preview/`).
 *
 * Deliberately separate from vite.config.ts: no router codegen, no sandbox
 * entry, no source maps, and `base: "./"` so the emitted bundle opens from
 * the file system with no server. Nothing here ships.
 */
export default defineConfig({
  root: path.resolve(__dirname, "preview"),
  base: "./",
  // The real pages reference /mushie-coin.png and friends by absolute path,
  // so the app public dir has to sit at the preview root.
  publicDir: path.resolve(__dirname, "./public"),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@yumina/engine": path.resolve(__dirname, "../engine/src/index.ts"),
    },
  },
  server: { port: 5200, strictPort: true, host: true },
  build: {
    outDir: path.resolve(__dirname, "../../docs/design/ui-preview"),
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
  },
});
