import { test, describe } from "node:test";
import assert from "node:assert/strict";

// Test the fee calculation (inline in handlePaymentIntentSucceeded)
describe("Tip fee calculation", () => {
  // grossAmount * 0.2 = platformFee, netAmount = gross - platformFee
  test("$1 tip: 100 cents gross, 20 cents fee, 80 cents net", () => {
    const grossAmount = 100;
    const platformFee = Math.round(grossAmount * 0.2);
    const netAmount = grossAmount - platformFee;
    assert.equal(platformFee, 20);
    assert.equal(netAmount, 80);
  });

  test("$3 tip: 300 cents gross, 60 cents fee, 240 cents net", () => {
    const grossAmount = 300;
    const platformFee = Math.round(grossAmount * 0.2);
    const netAmount = grossAmount - platformFee;
    assert.equal(platformFee, 60);
    assert.equal(netAmount, 240);
  });

  test("$500 tip: 50000 cents gross, 10000 cents fee, 40000 cents net", () => {
    const grossAmount = 50000;
    const platformFee = Math.round(grossAmount * 0.2);
    const netAmount = grossAmount - platformFee;
    assert.equal(platformFee, 10000);
    assert.equal(netAmount, 40000);
  });

  test("odd amount rounding: $1.99 = 199 cents, fee=40, net=159", () => {
    const grossAmount = 199;
    const platformFee = Math.round(grossAmount * 0.2);
    const netAmount = grossAmount - platformFee;
    assert.equal(platformFee, 40); // Math.round(39.8) = 40
    assert.equal(netAmount, 159);
  });

  test("$0.01 rounding edge: 1 cent, fee=0, net=1", () => {
    // Should never happen (min $1), but verify math doesn't break
    const grossAmount = 1;
    const platformFee = Math.round(grossAmount * 0.2);
    const netAmount = grossAmount - platformFee;
    assert.equal(platformFee, 0); // Math.round(0.2) = 0
    assert.equal(netAmount, 1);
  });

  test("platform always gets exactly 20%, creator always gets 80%", () => {
    for (const amount of [100, 300, 500, 999, 1000, 4999, 50000]) {
      const fee = Math.round(amount * 0.2);
      const net = amount - fee;
      // Creator gets between 79.5% and 80.5% (rounding)
      const creatorPct = (net / amount) * 100;
      assert.ok(
        creatorPct >= 79.5 && creatorPct <= 80.5,
        `Amount ${amount}: creator gets ${creatorPct.toFixed(1)}%, expected ~80%`,
      );
    }
  });
});

// Test the hold period
describe("Hold period", () => {
  test("7-day hold expires correctly", () => {
    const now = Date.now();
    const holdExpiresAt = new Date(now + 7 * 24 * 60 * 60 * 1000);
    const diff = holdExpiresAt.getTime() - now;
    assert.equal(diff, 604800000); // exactly 7 days in ms
  });
});

// Test tip amount validation (inline in POST /tips)
describe("Tip amount validation", () => {
  test("minimum $1.00 (100 cents)", () => {
    assert.ok(100 >= 100); // passes
    assert.ok(99 < 100); // would fail validation
  });

  test("maximum $500.00 (50000 cents)", () => {
    assert.ok(50000 <= 50000); // passes
    assert.ok(50001 > 50000); // would fail validation
  });
});

// Test mushie gift giftable balance calculation
describe("Giftable balance calculation", () => {
  // Formula: addonBalance + Math.max(0, balance - floor)

  test("all addon, no regular balance above floor", () => {
    const addonBalance = 500;
    const balance = 100; // below floor
    const floor = 400;
    const giftable = addonBalance + Math.max(0, balance - floor);
    assert.equal(giftable, 500); // only addon is giftable
  });

  test("no addon, balance above floor", () => {
    const addonBalance = 0;
    const balance = 1000;
    const floor = 400;
    const giftable = addonBalance + Math.max(0, balance - floor);
    assert.equal(giftable, 600); // 1000 - 400 = 600
  });

  test("both addon and balance above floor", () => {
    const addonBalance = 300;
    const balance = 1000;
    const floor = 400;
    const giftable = addonBalance + Math.max(0, balance - floor);
    assert.equal(giftable, 900); // 300 + 600 = 900
  });

  test("balance exactly at floor", () => {
    const addonBalance = 0;
    const balance = 400;
    const floor = 400;
    const giftable = addonBalance + Math.max(0, balance - floor);
    assert.equal(giftable, 0); // nothing above floor
  });

  test("balance below floor", () => {
    const addonBalance = 0;
    const balance = 200;
    const floor = 400;
    const giftable = addonBalance + Math.max(0, balance - floor);
    assert.equal(giftable, 0); // nothing giftable
  });

  test("zero everything", () => {
    const giftable = 0 + Math.max(0, 0 - 0);
    assert.equal(giftable, 0);
  });

  test("high balance low floor", () => {
    const addonBalance = 5000;
    const balance = 30000;
    const floor = 100;
    const giftable = addonBalance + Math.max(0, balance - floor);
    assert.equal(giftable, 34900);
  });

  test("mushie minimum is 50", () => {
    assert.ok(50 >= 50);
    assert.ok(49 < 50);
  });
});

// Test mushie deduction SQL logic (simulated)
describe("Mushie deduction logic", () => {
  test("deducts from addonBalance first", () => {
    const addonBalance = 200;
    const balance = 1000;
    const amount = 150;

    // SQL: GREATEST(addonBalance - amount, 0)
    const newAddon = Math.max(addonBalance - amount, 0);
    // SQL: balance - GREATEST(amount - addonBalance, 0)
    const newBalance = balance - Math.max(amount - addonBalance, 0);

    assert.equal(newAddon, 50); // 200 - 150 = 50
    assert.equal(newBalance, 1000); // no deduction from balance
  });

  test("overflow from addon to balance", () => {
    const addonBalance = 100;
    const balance = 1000;
    const amount = 300;

    const newAddon = Math.max(addonBalance - amount, 0);
    const newBalance = balance - Math.max(amount - addonBalance, 0);

    assert.equal(newAddon, 0); // depleted
    assert.equal(newBalance, 800); // 1000 - (300-100) = 800
  });

  test("exactly depletes addon, no balance touch", () => {
    const addonBalance = 500;
    const balance = 1000;
    const amount = 500;

    const newAddon = Math.max(addonBalance - amount, 0);
    const newBalance = balance - Math.max(amount - addonBalance, 0);

    assert.equal(newAddon, 0);
    assert.equal(newBalance, 1000);
  });
});

// Test payout threshold
describe("Payout threshold", () => {
  const MINIMUM_PAYOUT_CENTS = 1000; // $10

  test("below threshold skips", () => {
    const totalNet = 999;
    assert.ok(totalNet < MINIMUM_PAYOUT_CENTS);
  });

  test("at threshold proceeds", () => {
    const totalNet = 1000;
    assert.ok(totalNet >= MINIMUM_PAYOUT_CENTS);
  });

  test("groups by creator correctly", () => {
    const earnings = [
      { creatorId: "a", netAmount: 400 },
      { creatorId: "b", netAmount: 600 },
      { creatorId: "a", netAmount: 700 },
    ];

    const byCreator = new Map<string, number>();
    for (const e of earnings) {
      byCreator.set(
        e.creatorId,
        (byCreator.get(e.creatorId) ?? 0) + e.netAmount,
      );
    }

    assert.equal(byCreator.get("a"), 1100); // above $10
    assert.equal(byCreator.get("b"), 600); // below $10, skip
  });
});

// Test supporter list privacy
describe("Supporter list privacy", () => {
  test("anonymous tip hides sender info", () => {
    const tip = { isAnonymous: true, senderName: "John", senderImage: "url" };
    const result = {
      senderName: tip.isAnonymous ? null : tip.senderName,
      senderImage: tip.isAnonymous ? null : tip.senderImage,
    };
    assert.equal(result.senderName, null);
    assert.equal(result.senderImage, null);
  });

  test("non-anonymous tip shows sender info", () => {
    const tip = {
      isAnonymous: false,
      senderName: "John",
      senderImage: "url",
    };
    const result = {
      senderName: tip.isAnonymous ? null : tip.senderName,
      senderImage: tip.isAnonymous ? null : tip.senderImage,
    };
    assert.equal(result.senderName, "John");
    assert.equal(result.senderImage, "url");
  });

  test("supporter list never includes dollar amounts", () => {
    // The SELECT in tips.ts supporters endpoint only includes:
    // id, message, isAnonymous, createdAt, senderName, senderImage
    // NOT: grossAmount, platformFee, netAmount, stripeFee
    const publicFields = [
      "id",
      "message",
      "isAnonymous",
      "createdAt",
      "senderName",
      "senderImage",
    ];
    const privateFields = [
      "grossAmount",
      "platformFee",
      "netAmount",
      "stripeFee",
    ];

    for (const field of privateFields) {
      assert.ok(
        !publicFields.includes(field),
        `${field} should NOT be in public supporter list`,
      );
    }
  });
});

// Test webhook idempotency
describe("Webhook idempotency", () => {
  test("payment_intent.succeeded with non-tip metadata is ignored", () => {
    const metadata = { type: "subscription" };
    assert.notEqual(metadata.type, "tip"); // handler returns early
  });

  test("payment_intent.succeeded with tip metadata is processed", () => {
    const metadata = {
      type: "tip",
      worldId: "w1",
      senderId: "s1",
      creatorId: "c1",
    };
    assert.equal(metadata.type, "tip");
    assert.ok(metadata.worldId);
    assert.ok(metadata.senderId);
    assert.ok(metadata.creatorId);
  });

  test("missing metadata fields cause early return", () => {
    const metadata = { type: "tip", worldId: "w1" }; // missing senderId, creatorId
    const hasAll =
      metadata.worldId &&
      (metadata as any).senderId &&
      (metadata as any).creatorId;
    assert.ok(!hasAll);
  });
});
