import assert from "node:assert/strict";
import test from "node:test";
import { backgroundChargeDecision, readBackgroundChargePrefs } from "@yumina/shared";
import {
  askBackgroundConsent,
  askPendingBackgroundConsent,
  closeBackgroundConsent,
  declinedChoice,
  nextBackgroundChargePrefs,
  useBackgroundConsentStore,
} from "./background-consent-store";

test("a reply's consentNeeded queues each AI once, ignoring junk", () => {
  closeBackgroundConsent();
  askBackgroundConsent([{ feature: "recap", model: "google/gemini-3.1-flash-lite", estCredits: 0.4, hasFreeOption: true }, { feature: "nope" }, "x"]);
  askBackgroundConsent([{ feature: "recap", model: "other", estCredits: 9 }, { feature: "cardAi", model: "m", estCredits: null, hasFreeOption: true }]);
  const asks = useBackgroundConsentStore.getState().asks;
  assert.deepEqual(asks.map((a) => a.feature), ["recap", "cardAi"]);
  assert.equal(asks[0]!.estCredits, 0.4, "the first question stands");
  assert.equal(asks[1]!.hasFreeOption, false, "a card AI has no free stand-in, whatever the wire says");
  closeBackgroundConsent();
  assert.deepEqual(useBackgroundConsentStore.getState().asks, []);
});

test("the profile's waiting notes ask only for AIs without an answer", () => {
  closeBackgroundConsent();
  askPendingBackgroundConsent({
    backgroundChargePending: { recap: { model: "a", estCredits: 0.3 }, memory: { model: "b" } },
    backgroundCharges: { features: { recap: "free" } },
  });
  assert.deepEqual(useBackgroundConsentStore.getState().asks.map((a) => a.feature), ["memory"]);
  closeBackgroundConsent();
  askPendingBackgroundConsent({ backgroundChargePending: { memory: { model: "b" } }, backgroundCharges: { allowAll: true } });
  assert.deepEqual(useBackgroundConsentStore.getState().asks, [], "\"don't ask again\" answers everything");
});

test("answers: decline means the free model where there is one, else not this time; don't ask again allows all", () => {
  assert.equal(declinedChoice({ hasFreeOption: true }), "free");
  assert.equal(declinedChoice({ hasFreeOption: false }), "snooze");
  assert.deepEqual(nextBackgroundChargePrefs({ features: { memory: "skip" } }, { recap: "allow" }), { features: { memory: "skip", recap: "allow" } });
  assert.deepEqual(nextBackgroundChargePrefs({ features: { memory: "skip" } }, { recap: "allow" }, true), { allowAll: true, features: { memory: "skip", recap: "allow" } });
  assert.deepEqual(nextBackgroundChargePrefs({ allowAll: true, features: { recap: "free" } }, { recap: "ask" }), { allowAll: true, features: {} }, "\"ask\" removes an answer");
  assert.deepEqual(nextBackgroundChargePrefs({ allowAll: true }, {}, false), { features: {} }, "turning off don't-ask-again");
});

test("not this time: the AI waits a day, then is asked again; a real answer ends the wait", () => {
  const now = Date.now();
  const dayLater = new Date(now + 24 * 3600_000).toISOString();
  const snoozed = nextBackgroundChargePrefs({ features: { recap: "free" } }, { cardAi: "snooze" }, undefined, now);
  assert.deepEqual(snoozed, { features: { recap: "free" }, snoozedUntil: { cardAi: dayLater } });
  assert.equal(backgroundChargeDecision({ backgroundCharges: snoozed }, "cardAi", now + 60_000), "skip", "inside the window it does not run");
  assert.equal(backgroundChargeDecision({ backgroundCharges: snoozed }, "cardAi", now + 25 * 3600_000), "undecided", "after a day it asks again");
  assert.deepEqual(nextBackgroundChargePrefs(snoozed, { cardAi: "allow" }, undefined, now), { features: { recap: "free", cardAi: "allow" } });
  assert.deepEqual(nextBackgroundChargePrefs(snoozed, {}, undefined, now + 25 * 3600_000), { features: { recap: "free" } }, "an ended window is dropped");
  closeBackgroundConsent();
  askPendingBackgroundConsent({ backgroundChargePending: { cardAi: { model: "m" } }, backgroundCharges: snoozed });
  assert.deepEqual(useBackgroundConsentStore.getState().asks, [], "a waiting note is not shown inside the window");
  assert.equal(readBackgroundChargePrefs({ backgroundCharges: { snoozedUntil: { cardAi: "2099-01-01T00:00:00.000Z" } } }).snoozedUntil, undefined, "a client cannot snooze for years");
});
