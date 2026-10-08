import assert from "node:assert/strict";
import test from "node:test";
import { stripTurnVideos, turnFilmNotesPath, turnVideoPaths } from "./turn-video-embeds";

const path = (key: string) => `/cdn/key/${Buffer.from(key).toString("base64url")}`;

test("a film's shots are read in order, and its notes sit beside the first", () => {
  const text = `她回头看了你一眼。\n\n[video:${path("users/u1/turn-videos/f1-0.mp4")}|sound]\n[video:${path("users/u1/turn-videos/f1-1.mp4")}|sound]`;
  assert.deepEqual(turnVideoPaths(text), [path("users/u1/turn-videos/f1-0.mp4"), path("users/u1/turn-videos/f1-1.mp4")]);
  assert.equal(turnFilmNotesPath(turnVideoPaths(text)[0]!), path("users/u1/turn-videos/f1.json"));
  assert.equal(stripTurnVideos(text), "她回头看了你一眼。");
});
