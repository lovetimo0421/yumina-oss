import { strict as assert } from "node:assert";
import { test } from "node:test";
import { gameScreenOf } from "./game-interface";

const world = (extra: Record<string, unknown>) => ({ id: "w", ...extra }) as never;

test("a game page card's screen is its page, played as the folder's index, with the cover beside it", () => {
  assert.deepEqual(gameScreenOf(world({ game: { path: "/pvz/" } })), { kind: "page", path: "/pvz/index.html", cover: "/pvz/cover.png" });
  assert.deepEqual(gameScreenOf(world({ game: { path: "/pvz/?lobby" } })), { kind: "page", path: "/pvz/index.html?lobby", cover: "/pvz/cover.png" });
  assert.deepEqual(gameScreenOf(world({ game: { path: "/games/x/play.html" } })), { kind: "page", path: "/games/x/play.html", cover: "/games/x/cover.png" });
});

test("only a same-origin path is a game page", () => {
  assert.equal(gameScreenOf(world({ game: { path: "//evil.example/pvz/" } })), null);
  assert.equal(gameScreenOf(world({ game: { path: "https://evil.example/" } })), null);
  assert.equal(gameScreenOf(world({ game: {} })), null);
});

test("a SpireTalk card's screen is the mod: the game's half of the conversation", () => {
  const screen = gameScreenOf(world({ spiretalk: { npc: "NEOW", kind: "ancient" } }));
  assert.equal(screen?.kind, "mod");
  if (screen?.kind === "mod") {
    assert.equal(screen.npc, "NEOW");
    assert.ok(screen.game.inputs.has("hp") && screen.game.outputs.has("action"));
  }
  assert.equal(gameScreenOf(world({})), null, "an ordinary card is a chat");
});

test("a card can declare its own game: the board reads it like SpireTalk's, and null switches it off", async () => {
  const { gameInterfaceOf, withGameSide } = await import("./game-interface");
  const declared = world({ game: { name: "Hades II", inputs: ["hp"], outputs: ["boon"] } });
  const game = gameInterfaceOf(declared);
  assert.equal(game?.declared, true);
  assert.equal(game?.gameName, "Hades II");
  assert.ok(game?.inputs.has("hp") && game.outputs.has("boon"));
  assert.equal(gameScreenOf(declared)?.kind, "mod", "its screen is the game's half of the conversation");
  assert.equal(gameInterfaceOf(world({ game: null })), null);
  assert.equal(gameInterfaceOf(world({ game: { path: "/pvz/", inputs: [] } })), null, "a game page is not a mod NPC");
  assert.deepEqual(withGameSide({ inputs: ["hp"], outputs: [] }, "hp", "out"), { inputs: [], outputs: ["hp"] }, "a variable is on one side");
  assert.deepEqual(withGameSide({ inputs: ["hp"], outputs: [] }, "hp", null), { inputs: [], outputs: [] });
});
