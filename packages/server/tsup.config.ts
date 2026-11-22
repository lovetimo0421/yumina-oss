import { defineConfig } from "tsup";
import { mkdir, copyFile } from "node:fs/promises";

// Open-source edition: the server plus the worker threads it starts beside
// index.js. The analytics and image workers are hosted services and are not
// part of this tree.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    // Loaded by lib/card-code/stamp.ts as a worker thread, beside index.js.
    "card-code-worker": "src/lib/card-code/worker.ts",
    // Loaded by lib/regex-rules/runner.ts: players' regex rules run here, under a time limit.
    "regex-rules-worker": "src/lib/regex-rules/worker.ts",
    // Loaded by lib/card-translate-regex/runner.ts: a card's own regexes run here when the card is translated.
    "card-translate-regex-worker": "src/lib/card-translate-regex/worker.ts",
  },
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  target: "node22",
  onSuccess: async () => {
    // Read by db/session-media-ddl.ts beside index.js.
    await mkdir("dist/migrations", { recursive: true });
    await copyFile("scripts/session-media.sql", "dist/migrations/session-media.sql");
    // Served verbatim by routes/local-setup.ts.
    await mkdir("dist/local-setup", { recursive: true });
    await copyFile("src/local-setup/setup.ps1", "dist/local-setup/setup.ps1");
    await copyFile("src/local-setup/setup.sh", "dist/local-setup/setup.sh");
  },
});
