import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function findTests(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? findTests(file) : entry.name.endsWith(".test.ts") ? [file] : [];
  });
}
const selected = process.argv.slice(2);
const files = selected.length ? selected.map(file => resolve(serverRoot, file)) : findTests(join(serverRoot, "src"));
for (const file of files) {
  if (relative(join(serverRoot, "src"), file).startsWith("..") || !file.endsWith(".test.ts")) {
    throw new Error("Local tests must be .test.ts files inside packages/server/src");
  }
}

// Inherit only operating-system paths. Never forward credentials, DATABASE_URL,
// NODE_OPTIONS, or a developer's test flags into the isolated child process.
const systemKeys = new Set(["path", "systemroot", "windir", "comspec", "pathext", "temp", "tmp", "home", "userprofile", "appdata", "localappdata"]);
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => systemKeys.has(key.toLowerCase())));
Object.assign(childEnv, {
  NODE_ENV: "test",
  DATABASE_URL: "",
  DATABASE_READ_URL: "",
  PGLITE_DATA_DIR: "memory://",
  BETTER_AUTH_SECRET: "yumina-isolated-local-tests-only-secret",
  REDIS_URL: "",
  POSTHOG_API_KEY: "",
  TZ: "UTC",
  YUMINA_LOCAL_TEST: "1",
});
// Hand node a glob (it expands patterns itself) or short cwd-relative paths.
// ~200 absolute paths overflow the Windows command line (spawn ENAMETOOLONG).
const testArgs = selected.length ? files.sort().map((file) => relative(serverRoot, file)) : ["src/**/*.test.ts"];
const child = spawn(process.execPath, [
  "--import", "tsx", "--import", "./scripts/test-local-environment.mjs",
  "--test", "--test-timeout=120000", "--test-concurrency=2", "--test-reporter=tap", ...testArgs,
], { cwd: serverRoot, env: childEnv, stdio: "inherit" });
child.on("error", error => { console.error(error); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
