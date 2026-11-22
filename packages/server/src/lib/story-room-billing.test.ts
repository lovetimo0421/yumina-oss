import assert from "node:assert/strict";
import test from "node:test";
import { chargeRoomReply } from "./story-room-billing.js";
import { splitShares } from "./story-rooms.js";

test("a split round charges each agreed player an equal share; the host pays the rest", () => {
  const agreed = new Set(["a", "b"]);
  assert.deepEqual(splitShares({ cost: 30, hostUserId: "h", actorIds: ["h", "a", "b"], agreed }), [
    { userId: "a", amount: 10 },
    { userId: "b", amount: 10 },
  ]);
  assert.deepEqual(splitShares({ cost: 30, hostUserId: "h", actorIds: ["a", "a", "c"], agreed }), [{ userId: "a", amount: 15 }], "c never agreed: their half stays with the host");
  assert.deepEqual(splitShares({ cost: 0, hostUserId: "h", actorIds: ["a"], agreed }), []);
});

test("chargeRoomReply: host-pays charges the host; split charges shares first and clamps to what players have", async () => {
  const calls: Array<[string, number, string]> = [];
  const balances: Record<string, number> = { h: 100, a: 100, b: 4 };
  const deduct = async (userId: string, credits: number, ref: string) => {
    const paid = Math.min(credits, balances[userId] ?? 0);
    balances[userId] = (balances[userId] ?? 0) - paid;
    calls.push([userId, credits, ref]);
    return { creditsDeducted: paid, newBalance: balances[userId]!, newAddonBalance: 0, transactionId: ref };
  };
  const turn = { costMode: "split" as const, hostUserId: "h", actorIds: ["h", "a", "b"], splitAgreed: ["a", "b"] };
  const host = await chargeRoomReply({ turn, hostUserId: "h", cost: 30, usageLogId: "u1", description: "m", deduct: deduct as never });
  assert.deepEqual(calls, [["a", 10, "u1:a"], ["b", 10, "u1:b"], ["h", 16, "u1"]], "b had 4: the host covers the other 6");
  assert.equal(host?.creditsDeducted, 16);
  calls.length = 0;
  await chargeRoomReply({ turn: { ...turn, costMode: "host" }, hostUserId: "h", cost: 30, usageLogId: "u2", description: "m", deduct: deduct as never });
  assert.deepEqual(calls, [["h", 30, "u2"]]);
});
