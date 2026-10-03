import assert from "node:assert/strict";
import test from "node:test";
import {
  isReservedUsername,
  parseProfileAddress,
  parseWorldAddress,
  profileAddressPath,
  slugifyWorldName,
  worldAddressPath,
} from "../dist/index.js";

test("names become readable slugs; scripts other than Latin keep their characters", () => {
  assert.equal(slugifyWorldName("After the Bell"), "after-the-bell");
  assert.equal(slugifyWorldName("ONE PIECE: The Great Pirate Era"), "one-piece-the-great-pirate-era");
  assert.equal(slugifyWorldName("Oncin, the Weaver"), "oncin-the-weaver");
  assert.equal(slugifyWorldName("不想当魔法少女！"), "不想当魔法少女");
  assert.equal(slugifyWorldName("「星期三」·亞當斯"), "星期三-亞當斯");
  assert.equal(slugifyWorldName("★★★"), "world");
  assert.equal(slugifyWorldName(""), "world");
  assert.equal(slugifyWorldName("followers"), "followers-world");
  assert.ok(slugifyWorldName("word ".repeat(40)).length <= 80);
});

test("a world address is built from handle, name and permanent id, and read back by the id", () => {
  const path = worldAddressPath({ username: "WindowSeat", name: "After the Bell", publicId: "27483DFF" });
  assert.equal(path, "/@windowseat/after-the-bell-27483dff");
  assert.deepEqual(parseWorldAddress(path), { handle: "windowseat", slug: "after-the-bell", publicId: "27483dff" });
  // A stale name or a renamed creator still resolves to the same id.
  assert.deepEqual(parseWorldAddress("/@OldName/some-old-title-27483dff/"), { handle: "oldname", slug: "some-old-title", publicId: "27483dff" });
  // Percent-encoded Chinese arrives decoded.
  assert.deepEqual(parseWorldAddress("/@haimian/%E4%B8%8D%E6%83%B3-abcdef12"), { handle: "haimian", slug: "不想", publicId: "abcdef12" });
  assert.equal(parseWorldAddress("/@user/no-id-here"), null);
  assert.equal(parseWorldAddress("/app/hub/27483dff-e14f-49ec-864c-37bd85d7d9c4"), null);
  assert.equal(worldAddressPath({ username: "x", name: "y", publicId: null }), null);
});

test("creator addresses", () => {
  assert.equal(profileAddressPath("WindowSeat"), "/@windowseat");
  assert.equal(parseProfileAddress("/@WindowSeat/"), "windowseat");
  assert.equal(parseProfileAddress("/@a/b"), null);
  assert.equal(parseProfileAddress("/login"), null);
});

test("platform-sounding handles are reserved", () => {
  assert.equal(isReservedUsername("Yumina"), true);
  assert.equal(isReservedUsername("admin"), true);
  assert.equal(isReservedUsername("windowseat"), false);
});
