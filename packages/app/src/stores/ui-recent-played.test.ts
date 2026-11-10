import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { useUiStore } from "./ui";

const server = [
  { id: "a", name: "A", thumbnailUrl: null, playedAt: "2026-10-17T00:51:15.184Z" },
  { id: "b", name: "B", thumbnailUrl: null, playedAt: "2026-09-26T23:14:55.199Z" },
];

beforeEach(() => {
  useUiStore.setState({ recentPlayedWorlds: [], recentPlayedSeeded: false });
});

test("an empty list on a new browser fills from the server once", () => {
  useUiStore.getState().seedRecentPlayedWorlds(server);
  assert.deepEqual(useUiStore.getState().recentPlayedWorlds.map((w) => w.id), ["a", "b"]);
  assert.equal(useUiStore.getState().recentPlayedSeeded, true);
});

test("a list this browser already kept is left alone", () => {
  useUiStore.getState().recordRecentPlayedWorld({ id: "c", name: "C" });
  useUiStore.getState().seedRecentPlayedWorlds(server);
  assert.deepEqual(useUiStore.getState().recentPlayedWorlds.map((w) => w.id), ["c"]);
});

test("a list the player emptied stays empty", () => {
  useUiStore.getState().recordRecentPlayedWorld({ id: "c", name: "C" });
  useUiStore.getState().removeRecentPlayedWorld("c");
  useUiStore.getState().seedRecentPlayedWorlds(server);
  assert.deepEqual(useUiStore.getState().recentPlayedWorlds, []);
});
