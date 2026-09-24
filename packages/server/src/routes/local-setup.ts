import { Hono } from "hono";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * One-command installers for running models on the player's own machine:
 *
 *   Windows  irm "https://yumina.io/local/setup.ps1?lang=zh" | iex
 *   macOS    curl -fsSL "https://yumina.io/local/setup.sh?lang=zh" | bash
 *
 * `&mode=allow` runs only the "let this site connect + restart Ollama" part,
 * for a player whose Ollama is installed but refuses the site.
 *
 * The scripts are plain files beside this module (copied into dist/ by
 * tsup.config.ts) so anyone can read exactly what they run. The only thing
 * filled in per request is the site origin Ollama should allow — taken from
 * the host the script was fetched from, never from a query parameter, so no
 * link can be crafted that makes the script allow some other site.
 */

const SCRIPTS = {
  "setup.ps1": "text/plain; charset=utf-8",
  "setup.sh": "text/plain; charset=utf-8",
} as const;

type ScriptName = keyof typeof SCRIPTS;

// src/routes/local-setup.ts → src/local-setup/ in dev; dist/index.js → dist/local-setup/ in prod.
const DIR_CANDIDATES = [new URL("./local-setup/", import.meta.url), new URL("../local-setup/", import.meta.url)];

const cache = new Map<ScriptName, string>();

function loadScript(name: ScriptName): string | null {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  for (const dir of DIR_CANDIDATES) {
    const path = fileURLToPath(new URL(name, dir));
    if (existsSync(path)) {
      // Normalize to LF: bash rejects CRLF, and PowerShell accepts either.
      const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
      // Cache only in production; in dev an edited script shows up on the next fetch.
      if (process.env.NODE_ENV === "production") cache.set(name, text);
      return text;
    }
  }
  return null;
}

const HOST_RE = /^[a-z0-9.-]+(:\d{1,5})?$/i;

/** The origin the player's browser is on, as seen by this request. */
export function requestOrigin(headers: { get(name: string): string | null | undefined }, fallbackProto: string): string | null {
  const host = (headers.get("x-forwarded-host") ?? headers.get("host") ?? "").split(",")[0]!.trim();
  if (!HOST_RE.test(host)) return null;
  const forwarded = (headers.get("x-forwarded-proto") ?? "").split(",")[0]!.trim().toLowerCase();
  const proto = forwarded === "https" || forwarded === "http" ? forwarded : fallbackProto;
  return `${proto}://${host.toLowerCase()}`;
}

export function renderScript(template: string, origin: string, lang: string, mode = "setup"): string {
  return template
    .replaceAll("__ORIGIN__", origin)
    .replaceAll("__LANG__", lang === "zh" ? "zh" : "en")
    .replaceAll("__MODE__", mode === "allow" ? "allow" : "setup");
}

export const localSetupRoutes = new Hono();

for (const name of Object.keys(SCRIPTS) as ScriptName[]) {
  localSetupRoutes.get(`/${name}`, (c) => {
    const template = loadScript(name);
    if (!template) return c.text("Not found", 404);
    const origin = requestOrigin(c.req.raw.headers, process.env.NODE_ENV === "production" ? "https" : "http");
    if (!origin) return c.text("Bad host", 400);
    const lang = c.req.query("lang") === "zh" ? "zh" : "en";
    // "allow" = only let this site connect and restart Ollama; anything else is the full setup.
    const mode = c.req.query("mode") === "allow" ? "allow" : "setup";
    c.header("Content-Type", SCRIPTS[name]);
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    return c.body(renderScript(template, origin, lang, mode));
  });
}
