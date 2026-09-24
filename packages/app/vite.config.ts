import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import path from "path";
import { sandboxDocAsset } from "./vite-plugins/sandbox-doc-asset";

export default defineConfig({
  plugins: [
    TanStackRouterVite({
      routesDirectory: "./src/routes",
      generatedRouteTree: "./src/routeTree.gen.ts",
    }),
    react(),
    tailwindcss(),
    sandboxDocAsset(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@yumina/engine": path.resolve(__dirname, "../engine/src/index.ts"),
    },
  },
  css: {
    // Tailwind 4 output leans on modern CSS (oklch(), color-mix(),
    // relative colors). Old WebView kernels — Quark/UC's U4, aged Android
    // WebViews — parse none of it, which surfaced as unstyled/green-screen
    // pages after the 2026-08-02 stale-deployment refresh forced everyone
    // onto the current build. Lightning CSS transpiles/adds fallbacks down
    // to the same browser floor as the JS bundle (Vite build.target
    // "modules" ≈ Chrome 87 / Safari 14), so any browser that can run the
    // app's JS also gets parseable colors. Versions are (major << 16).
    transformer: "lightningcss",
    lightningcss: {
      targets: {
        chrome: 87 << 16,
        edge: 88 << 16,
        firefox: 78 << 16,
        safari: (14 << 16) | (0 << 8),
        android: 87 << 16,
        ios_saf: (14 << 16) | (0 << 8),
      },
    },
  },
  build: {
    cssMinify: "lightningcss",
    // "hidden": emit .map files for PostHog error-tracking symbolication but
    // omit the sourceMappingURL comment from the bundles. The Dockerfile
    // uploads the maps to PostHog (posthog-cli sourcemap inject/upload) and
    // strips them before the dist is copied into the public dir, so maps are
    // never served to browsers.
    sourcemap: "hidden",
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        sandbox: path.resolve(__dirname, "sandbox/index.html"),
      },
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom"],
          "vendor-router": ["@tanstack/react-router"],
          "vendor-posthog": ["posthog-js"],
          "vendor-i18n": ["i18next", "react-i18next"],
          // Charts are reachable from two lazy chunks (admin analytics + the
          // referral panel). Without this, rollup hoists recharts to their
          // common ancestor — the entry chunk — and every user downloads it on
          // first paint. Pinning it here keeps it lazy for both.
          "vendor-charts": ["recharts"],
        },
      },
    },
  },
  server: {
    port: 5173,
    cors: {
      // The sandbox iframe has an opaque origin (null) due to sandbox="allow-scripts"
      // without allow-same-origin. Vite must allow * so ES modules can load.
      origin: "*",
    },
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
      "/cdn": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
      // One-command local-model installers. changeOrigin stays off so the
      // script is rendered for the page's own origin (127.0.0.1:5173 etc.).
      "/local": {
        target: "http://localhost:3000",
        changeOrigin: false,
      },
      // Local-disk asset uploads (PUT /storage/upload?token=...) when no S3
      // bucket is configured. Keeps dev same-origin; harmless in prod.
      "/storage": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
