import assert from "node:assert/strict";
import test from "node:test";
import {
  POPUP_AUTH_DONE,
  authPopupFeatures,
  isPopupAuthDoneEvent,
  parsePopupAuthDone,
  popupAuthDoneUrl,
} from "./popup-auth";

void test("popup done URL is same-origin and flags errors in the query", () => {
  assert.equal(popupAuthDoneUrl("https://yumina.io"), "https://yumina.io/auth/popup-done");
  assert.equal(popupAuthDoneUrl("https://yumina.io", true), "https://yumina.io/auth/popup-done?error=1");
});

void test("only the done message is parsed; the error text is bounded", () => {
  assert.equal(parsePopupAuthDone(null), null);
  assert.equal(parsePopupAuthDone("yumina:popup-auth-done"), null);
  assert.equal(parsePopupAuthDone({ type: "yumina:auth:token" }), null);
  assert.deepEqual(parsePopupAuthDone({ type: POPUP_AUTH_DONE }), { type: POPUP_AUTH_DONE });
  assert.deepEqual(parsePopupAuthDone({ type: POPUP_AUTH_DONE, error: "" }), { type: POPUP_AUTH_DONE });
  const long = parsePopupAuthDone({ type: POPUP_AUTH_DONE, error: "x".repeat(200) });
  assert.equal(long?.error?.length, 80);
});

void test("the message is accepted only from our origin and from the popup we opened", () => {
  const popup = {} as Window;
  const other = {} as Window;
  const data = { type: POPUP_AUTH_DONE };
  assert.ok(isPopupAuthDoneEvent({ origin: "https://yumina.io", source: popup, data }, popup, "https://yumina.io"));
  assert.equal(isPopupAuthDoneEvent({ origin: "https://evil.example", source: popup, data }, popup, "https://yumina.io"), null);
  assert.equal(isPopupAuthDoneEvent({ origin: "https://yumina.io", source: other, data }, popup, "https://yumina.io"), null);
  assert.equal(isPopupAuthDoneEvent({ origin: "https://yumina.io", source: popup, data }, null, "https://yumina.io"), null);
});

void test("popup is centered on the opener and never placed off-screen", () => {
  const features = authPopupFeatures({ screenX: 100, screenY: 50, outerWidth: 1400, outerHeight: 900 });
  assert.match(features, /^popup=yes,width=520,height=680,left=540,top=160,/);
  const tiny = authPopupFeatures({ screenX: 0, screenY: 0, outerWidth: 400, outerHeight: 600 });
  assert.match(tiny, /left=0,top=0/);
});
