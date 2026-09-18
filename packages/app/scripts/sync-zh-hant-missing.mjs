// Add ONLY the keys that exist in zh/*.json but are missing from zh-Hant/*.json,
// converted with the same OpenCC profile as gen-zh-hant.mjs. Existing zh-Hant
// strings are never touched.
//
// Why a second script: the committed zh-Hant tree has hand-corrected wording
// that a full regeneration would overwrite with worse machine output (seen
// 2026-09-15: 已通過初審，並發放 → 已透過初審，併發放). Use this after adding new zh
// keys; use gen-zh-hant.mjs only when you intend to re-derive everything.
//
//   pnpm --filter @yumina/app i18n:zh-hant:missing            # all namespaces
//   pnpm --filter @yumina/app i18n:zh-hant:missing profile plans

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as OpenCCNs from "opencc-js";

const Converter = OpenCCNs.Converter ?? OpenCCNs.default?.Converter;
if (typeof Converter !== "function") throw new Error("opencc-js Converter export not found");
const convert = Converter({ from: "cn", to: "twp" });

const here = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(here, "..", "src", "locales", "zh");
const OUT_DIR = join(here, "..", "src", "locales", "zh-Hant");

const only = new Set(process.argv.slice(2).map((n) => (n.endsWith(".json") ? n : `${n}.json`)));
const files = readdirSync(SRC_DIR).filter((f) => f.endsWith(".json") && (only.size === 0 || only.has(f))).sort();

function deepConvert(node) {
  if (typeof node === "string") return convert(node);
  if (Array.isArray(node)) return node.map(deepConvert);
  if (node && typeof node === "object") {
    const out = {};
    for (const key of Object.keys(node)) out[key] = deepConvert(node[key]);
    return out;
  }
  return node;
}

/** Copy leaves present in `src` but absent in `dst` (converted). Returns the number added. */
function fillMissing(src, dst, path = "") {
  let added = 0;
  for (const key of Object.keys(src)) {
    const from = src[key];
    const here = path ? `${path}.${key}` : key;
    if (!(key in dst)) {
      dst[key] = deepConvert(from);
      added += typeof from === "string" ? 1 : countStrings(from);
      console.log(`  + ${here}`);
    } else if (from && typeof from === "object" && !Array.isArray(from) && dst[key] && typeof dst[key] === "object") {
      added += fillMissing(from, dst[key], here);
    }
  }
  return added;
}

function countStrings(node) {
  if (typeof node === "string") return 1;
  if (Array.isArray(node)) return node.reduce((n, x) => n + countStrings(x), 0);
  if (node && typeof node === "object") return Object.values(node).reduce((n, x) => n + countStrings(x), 0);
  return 0;
}

let total = 0;
for (const file of files) {
  const srcRaw = readFileSync(join(SRC_DIR, file), "utf8");
  const outPath = join(OUT_DIR, file);
  const dstRaw = existsSync(outPath) ? readFileSync(outPath, "utf8") : "{}\n";
  const src = JSON.parse(srcRaw);
  const dst = JSON.parse(dstRaw);
  console.log(file);
  const added = fillMissing(src, dst);
  if (added === 0) { console.log("  (nothing missing)"); continue; }
  const useCrlf = dstRaw.includes("\r\n");
  const trailingNewline = /\n$/.test(dstRaw);
  let text = JSON.stringify(dst, null, 2);
  if (useCrlf) text = text.replace(/\n/g, "\r\n");
  if (trailingNewline) text += useCrlf ? "\r\n" : "\n";
  writeFileSync(outPath, text, "utf8");
  total += added;
}
console.log(`\n✓ zh-Hant: ${total} missing string(s) added, existing strings untouched`);
