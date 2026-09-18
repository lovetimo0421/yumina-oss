// Generate Traditional Chinese (zh-Hant) UI locale files from the Simplified
// Chinese (zh) source via OpenCC.
//
// Why this exists: zh-Hant is a UI-only locale that piggybacks on the zh card
// pool (the server normalizes `zh-Hant` → `zh` for Discover, so Traditional and
// Simplified viewers share the same catalog). The translations themselves are
// mechanically derivable from zh, so we generate them deterministically rather
// than hand-maintaining a parallel tree that would silently drift.
//
// OpenCC profile `cn → twp` = Simplified → Traditional (Taiwan standard) WITH
// vocabulary/idiom conversion (软件→軟體, 默认→預設, 视频→影片, 登录→登入), so the
// result reads natural to a Traditional audience rather than being a raw
// character swap.
//
// Run after editing any zh/*.json:  pnpm --filter @yumina/app i18n:zh-hant
//
// Output is committed to git (reviewable, and the i18next fallback chain
// zh-Hant → zh → en means a stale/missing key degrades to Simplified, never to
// English). Only string VALUES are converted — JSON keys and {{interpolation}}
// placeholders are left untouched (OpenCC never touches ASCII/braces).

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as OpenCCNs from "opencc-js";

const Converter = OpenCCNs.Converter ?? OpenCCNs.default?.Converter;
if (typeof Converter !== "function") {
  throw new Error("opencc-js Converter export not found");
}

const here = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(here, "..", "src", "locales", "zh");
const OUT_DIR = join(here, "..", "src", "locales", "zh-Hant");

const convert = Converter({ from: "cn", to: "twp" });

// Product-term overrides, applied AFTER OpenCC on the converted string. Use ONLY
// for cases where s2twp picks a form we don't want for Yumina (brand nouns,
// over-eager idiom conversion). Keep this small and justified — every entry is a
// place OpenCC's default was judged wrong.  [convertedForm, desiredForm]
const OVERRIDES = [];

function convertString(s) {
  let out = convert(s);
  for (const [from, to] of OVERRIDES) {
    if (from && out.includes(from)) out = out.split(from).join(to);
  }
  return out;
}

// Recurse: convert string values; leave object keys and non-strings as-is.
function deepConvert(node) {
  if (typeof node === "string") return convertString(node);
  if (Array.isArray(node)) return node.map(deepConvert);
  if (node && typeof node === "object") {
    const out = {};
    for (const key of Object.keys(node)) out[key] = deepConvert(node[key]);
    return out;
  }
  return node;
}

mkdirSync(OUT_DIR, { recursive: true });

const files = readdirSync(SRC_DIR).filter((f) => f.endsWith(".json")).sort();
let totalStrings = 0;

for (const file of files) {
  const raw = readFileSync(join(SRC_DIR, file), "utf8");
  // Preserve the source file's exact line-ending + trailing-newline shape so the
  // generated tree matches the rest of the locale dir (CRLF here) and produces
  // no spurious EOL churn. JSON.stringify only emits structural '\n' (real
  // newlines inside values are escaped as the two chars backslash-n), so the
  // CRLF rewrite below can't corrupt value content.
  const useCrlf = raw.includes("\r\n");
  const trailingNewline = /\n$/.test(raw);

  const converted = deepConvert(JSON.parse(raw));

  let text = JSON.stringify(converted, null, 2);
  if (useCrlf) text = text.replace(/\n/g, "\r\n");
  if (trailingNewline) text += useCrlf ? "\r\n" : "\n";

  writeFileSync(join(OUT_DIR, file), text, "utf8");

  const count = countStrings(converted);
  totalStrings += count;
  console.log(`  ${file.padEnd(24)} ${count} strings${useCrlf ? "" : "  (LF)"}`);
}

function countStrings(node) {
  if (typeof node === "string") return 1;
  if (Array.isArray(node)) return node.reduce((n, x) => n + countStrings(x), 0);
  if (node && typeof node === "object") {
    return Object.values(node).reduce((n, x) => n + countStrings(x), 0);
  }
  return 0;
}

console.log(`\n✓ zh-Hant: ${files.length} namespaces, ${totalStrings} strings → ${OUT_DIR}`);
