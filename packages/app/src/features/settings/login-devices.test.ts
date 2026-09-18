import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deviceLabel, describeDevice, sortSessions, type ActiveSession } from "./login-devices";

/**
 * The User-Agent strings below are verbatim from the six live sessions on
 * kicer's prod account (user zQJHAVyHWDEX8Oh2WKC6LDWc9DBRZ52R) — the report
 * that motivated the Login devices panel: "i forgot to log out in another
 * phone and i cannot".
 */
const KICER_SESSION_UAS = {
  linuxChrome: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
  androidChrome: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36",
  xiaomiTvBox: "Mozilla/5.0 (Linux; Android 11; MiTV-AXFR2 Build/RTT0.210630.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/94.0.4606.85 Mobile Safari/537.36",
  linuxFirefox: "Mozilla/5.0 (X11; Linux x86_64; rv:139.0) Gecko/20100101 Firefox/139.0",
};

describe("login device labels", () => {
  it("separates the real devices on the reporting user's account", () => {
    assert.equal(deviceLabel(KICER_SESSION_UAS.linuxChrome), "Linux · Chrome");
    assert.equal(deviceLabel(KICER_SESSION_UAS.androidChrome), "Android · Chrome");
    assert.equal(deviceLabel(KICER_SESSION_UAS.linuxFirefox), "Linux · Firefox");
  });

  it("calls an Android TV box a TV, not another Android phone", () => {
    // Both this and the phone report "Android"; if the TV token loses, the
    // player sees two identical "Android · Chrome" rows and cannot tell which
    // one is the phone they meant to sign out.
    assert.equal(deviceLabel(KICER_SESSION_UAS.xiaomiTvBox), "TV · Chrome");
    assert.notEqual(
      deviceLabel(KICER_SESSION_UAS.xiaomiTvBox),
      deviceLabel(KICER_SESSION_UAS.androidChrome),
    );
  });

  it("does not misread Chromium-family browsers as Safari or Chrome", () => {
    // Every Chromium UA still ends in "Safari/537.36", and Edge/Opera both
    // carry "Chrome/" — the specific token has to win.
    assert.equal(
      describeDevice("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0").browser,
      "Edge",
    );
    assert.equal(
      describeDevice("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 OPR/125.0.0.0").browser,
      "Opera",
    );
    assert.equal(
      describeDevice("Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36").browser,
      "Samsung Internet",
    );
    assert.deepEqual(
      describeDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"),
      // iPhone must not fall through to the "Mac OS X" branch.
      { device: "iPhone", browser: "Safari" },
    );
  });

  it("does not call headless Chrome 'Safari'", () => {
    // "HeadlessChrome/" has no word boundary before "Chrome", so /\bChrome\//
    // misses it and the UA falls through to the Safari branch. All 28 QA-run
    // sessions in the dev DB were mislabelled this way.
    assert.equal(
      deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/145.0.7632.6 Safari/537.36"),
      "Windows · Chrome",
    );
  });

  it("names the in-app browser instead of the webview it is built on", () => {
    // 2.1% of live sessions are in-app browsers. They all carry Safari/ or
    // Chrome/, so without their own tokens they collapse into the generic
    // buckets and stop being identifiable.
    assert.equal(
      deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 26_5_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.75(0x18004b46) NetType/WIFI Language/zh_CN"),
      "iPhone · WeChat",
    );
    assert.equal(
      deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 26_5_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/23F84 Barcelona 439.0.0.35.57 (iPhone18,1; iOS 26_5_2; en_US; en; scale=3.00; 1179x2556; IABMV/1)"),
      "iPhone · Instagram",
    );
    assert.equal(
      deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 mailapp/7.1.7"),
      "iPhone · Mail app",
    );
    assert.equal(
      deviceLabel("Mozilla/5.0 (Linux; U; Android 13; zh-CN; V2145A Build/TP1A) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/100.0.4896.58 Quark/7.4.0.680 Mobile Safari/537.36"),
      "Android · Quark",
    );
  });

  it("labels a nameless iOS webview as an in-app browser, not Safari", () => {
    assert.equal(
      deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 WKType/1"),
      "iPhone · In-app browser",
    );
  });

  it("recognizes HarmonyOS phones instead of leaving the device blank", () => {
    assert.equal(
      deviceLabel("Mozilla/5.0 (Phone; OpenHarmony 6.1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 ArkWeb/6.1.0.117 Mobile"),
      "HarmonyOS · Chrome",
    );
  });

  it("falls back to an empty label instead of inventing a device", () => {
    assert.equal(deviceLabel(null), "");
    assert.equal(deviceLabel(""), "");
    assert.equal(deviceLabel("curl/8.7.1"), "");
  });
});

describe("login device ordering", () => {
  const s = (token: string, updatedAt: string): ActiveSession => ({
    id: token, token, createdAt: updatedAt, updatedAt,
  });

  it("pins the current device to the top, then sorts by last active", () => {
    const ordered = sortSessions(
      [
        s("old", "2026-08-01T00:00:00Z"),
        s("newest", "2026-08-15T20:00:00Z"),
        s("current", "2026-08-10T00:00:00Z"),
        s("middle", "2026-08-14T00:00:00Z"),
      ],
      "current",
    );
    assert.deepEqual(ordered.map((x) => x.token), ["current", "newest", "middle", "old"]);
  });

  it("still returns every session when the current token is unknown", () => {
    // A stale cookie-cache read can hand us a token that is no longer in the
    // list; dropping rows there would hide devices the player needs to kill.
    const ordered = sortSessions([s("a", "2026-08-01T00:00:00Z"), s("b", "2026-08-02T00:00:00Z")], null);
    assert.deepEqual(ordered.map((x) => x.token), ["b", "a"]);
  });

  it("does not mutate the caller's array", () => {
    const input = [s("a", "2026-08-01T00:00:00Z"), s("b", "2026-08-02T00:00:00Z")];
    sortSessions(input, null);
    assert.deepEqual(input.map((x) => x.token), ["a", "b"]);
  });
});
