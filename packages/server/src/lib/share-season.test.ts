import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { SHARE_GRADES, SHARE_TRACKS, gradeOf, gradePlan, gradesJson, shareSeasonActive, shareSeasonJudging, shareSeasonWindow } from "./share-season.js";

describe("share season window", () => {
  beforeEach(() => { delete process.env.SHARE_SEASON_STARTS_AT; delete process.env.SHARE_SEASON_ENDS_AT; process.env.SHARE_SEASON_ENABLED = "1"; });

  it("is closed until it is switched on", () => {
    delete process.env.SHARE_SEASON_ENABLED;
    assert.equal(shareSeasonActive(new Date("2026-11-20T00:00:00Z")), false);
    assert.equal(shareSeasonJudging(new Date("2026-11-20T00:00:00Z")), false);
  });

  it("runs one month, Nov 10 04:00 to Dec 10 04:00 Asia/Shanghai", () => {
    const { startsAt, endsAt } = shareSeasonWindow();
    assert.equal(startsAt.toISOString(), "2026-11-09T20:00:00.000Z");
    assert.equal(endsAt.toISOString(), "2026-12-09T20:00:00.000Z");
    assert.equal(shareSeasonActive(new Date("2026-11-09T19:59:59Z")), false);
    assert.equal(shareSeasonActive(new Date("2026-11-20T00:00:00Z")), true);
    assert.equal(shareSeasonActive(new Date("2026-12-09T20:00:00Z")), false);
  });

  it("judging goes on two weeks past the last day, so a share on the last day still gets its week", () => {
    assert.equal(shareSeasonJudging(new Date("2026-11-09T19:00:00Z")), false);
    assert.equal(shareSeasonJudging(new Date("2026-12-20T00:00:00Z")), true);
    assert.equal(shareSeasonJudging(new Date("2026-12-23T20:00:00Z")), false);
  });

  it("env overrides move it for testing; garbage falls back", () => {
    process.env.SHARE_SEASON_STARTS_AT = "2026-10-01T00:00:00Z";
    process.env.SHARE_SEASON_ENDS_AT = "nonsense";
    const { startsAt, endsAt } = shareSeasonWindow();
    assert.equal(startsAt.toISOString(), "2026-10-01T00:00:00.000Z");
    assert.equal(endsAt.toISOString(), "2026-12-09T20:00:00.000Z");
  });
});

describe("share season grades", () => {
  it("three tracks, three grades, each grade higher than the last", () => {
    assert.deepEqual([...SHARE_TRACKS], ["bundle", "audio", "voice"]);
    assert.deepEqual(SHARE_GRADES.map((g) => g.id), ["pick", "fine", "best"]);
    assert.deepEqual(SHARE_GRADES.map((g) => g.reward), [1000, 3000, 8000]);
  });

  it("a grade carries its membership with it: the two upper ones a month each, the first none", () => {
    assert.equal(gradePlan(gradeOf("pick")!), null);
    assert.deepEqual(gradePlan(gradeOf("fine")!), { name: "Gold", days: 30 });
    assert.deepEqual(gradePlan(gradeOf("best")!), { name: "Platinum", days: 30 });
    assert.equal(gradesJson().length, 3);
  });

  it("only a known grade is a grade", () => {
    for (const id of ["", "none", "top", "u50", "bundle_first"]) assert.equal(gradeOf(id), null, id);
  });
});
