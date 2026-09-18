import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// The compat-lite gate lives as an inline <script> in two hand-written HTML
// entry points, so nothing typechecks or bundles it. These tests execute the
// REAL script text against real user agents — the gate can't drift from the
// cases below without turning this red.

const ENTRIES = {
  app: new URL("../../index.html", import.meta.url),
  sandbox: new URL("../../sandbox/index.html", import.meta.url),
};

function compatLiteGate(entry: URL): string {
  const html = readFileSync(entry, "utf8");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const gate = scripts.find((s) => s.includes("compat-lite"));
  assert.ok(gate, `no compat-lite inline script found in ${entry.pathname}`);
  return gate;
}

function tagsCompatLite(gate: string, userAgent: string): boolean {
  const documentElement = { className: "dark" };
  const context = vm.createContext({ navigator: { userAgent }, document: { documentElement } });
  vm.runInContext(gate, context);
  return documentElement.className.includes("compat-lite");
}

/** [description, user agent, should the document get .compat-lite] */
const CASES: Array<[string, string, boolean]> = [
  // Tencent X5/TBS on Android: advertises Chrome/121 but runs Tencent's own
  // compositor. Community report 2026-08-17 — soft keyboard, page goes black.
  [
    "QQ Browser on Android (X5, reports Chrome/121)",
    "Mozilla/5.0 (Linux; U; Android 16; zh-cn; PKM110 Build/BP2A.250605.015) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/121.0.6167.71 MQQBrowser/20.3 Mobile Safari/537.36 COVC/048901",
    true,
  ],
  [
    "WeChat's legacy TBS/X5 webview",
    "Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/107.0.5304.141 Mobile Safari/537.36 MicroMessenger/8.0.30 TBS/046205",
    true,
  ],
  [
    "aged Chromium (the original <111 gate)",
    "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/86.0.4240.198 Mobile Safari/537.36",
    true,
  ],
  // Same apps on iOS are WKWebView skins — Safari's compositor handles glass
  // and blend modes fine, so they must keep the full visual treatment.
  [
    "QQ Browser on iOS (WKWebView, not X5)",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 MQQBrowser/20.5.0 Mobile/15E148 Safari/604.1 QBWebViewUA/2",
    false,
  ],
  // WeChat's current kernel is XWEB, a different engine from X5 with zero
  // reports against it. Kept on the modern pipeline on purpose.
  [
    "WeChat XWEB",
    "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36 XWEB/1300123 MicroMessenger/8.0.48",
    false,
  ],
  [
    "Chrome on Android",
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/143.0.0.0 Mobile Safari/537.36",
    false,
  ],
  [
    "Samsung Internet",
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 SamsungBrowser/30.0 Chrome/143.0.0.0 Mobile Safari/537.36",
    false,
  ],
  [
    "Mobile Safari",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/26.2 Mobile/15E148 Safari/604.1",
    false,
  ],
  [
    "desktop Chrome",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/139.0.0.0 Safari/537.36",
    false,
  ],
];

for (const [entryName, entry] of Object.entries(ENTRIES)) {
  test(`${entryName} entry tags compat-lite for X5 kernels only`, () => {
    const gate = compatLiteGate(entry);
    for (const [what, ua, expected] of CASES) {
      assert.equal(
        tagsCompatLite(gate, ua),
        expected,
        `${what} should ${expected ? "" : "not "}get .compat-lite`,
      );
    }
  });
}

test("compat-lite flattens the effects these kernels mis-composite", () => {
  const css = readFileSync(new URL("../styles/globals.css", import.meta.url), "utf8");
  assert.match(css, /html\.compat-lite \*[\s\S]{0,160}backdrop-filter: none !important/);
  assert.match(css, /html\.compat-lite \[data-immersive-bg\] img \{\s*mix-blend-mode: normal !important;/);
});

test("both wallpaper layers carry the data-immersive-bg hook the CSS targets", () => {
  for (const file of ["../components/layout/app-shell.tsx", "../features/auth/auth-layout.tsx"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /mix-blend-screen/, `${file} still blends its wallpaper`);
    assert.match(source, /data-immersive-bg/, `${file} must expose data-immersive-bg`);
  }
});
