import assert from "node:assert/strict";
import test from "node:test";
import { stripTurnVideos, turnClipLost, turnFilmNotesKey, turnVideoEmbed, turnVideoKeyOf, turnVideoPath } from "./turn-clip.js";
import { stripTurnImages } from "../per-turn-image/illustrate.js";

const key = (dir: string) => Buffer.from(`users/u1/${dir}/c1.mp4`, "utf8").toString("base64url");

test("a message's clip is one video embed that the strip removes, leaving the story", () => {
  const embed = turnVideoEmbed("users/u1/turn-videos/c1.mp4");
  assert.equal(embed, `[video:/cdn/key/${key("turn-videos")}|sound]`);
  assert.equal(stripTurnVideos(`她回头看了你一眼。\n\n${embed}`), "她回头看了你一眼。");
});

test("a creator's own video and the per-turn picture stay; only clips are stripped", () => {
  const creatorVideo = `[video:/cdn/key/${key("worlds")}|loop]`;
  const picture = `[image:/cdn/key/${Buffer.from("users/u1/turn-images/p1.jpg").toString("base64url")}|alt=x]`;
  const clip = turnVideoEmbed("users/u1/turn-videos/c1.mp4");
  const text = `开场。\n\n${creatorVideo}\n\n${picture}\n\n${clip}`;
  assert.equal(stripTurnVideos(text), `开场。\n\n${creatorVideo}\n\n${picture}`);
  // Both strips together leave the creator's video alone.
  assert.equal(stripTurnImages(stripTurnVideos(text)), `开场。\n\n${creatorVideo}`);
});

test("a rendering clip whose server stopped beating is lost; a beating one is not", () => {
  const now = 10_000_000;
  const job = (beat: number) => ({ status: "rendering" as const, userId: "u1", startedAt: now - 600_000, beat });
  assert.equal(turnClipLost(job(now - 30_000), now), false);
  assert.equal(turnClipLost(job(now - 5 * 60_000), now), true);
  // A job written before heartbeats counts from its start.
  assert.equal(turnClipLost({ status: "rendering", userId: "u1", startedAt: now - 10 * 60_000 }, now), true);
  assert.equal(turnClipLost({ status: "failed", userId: "u1", reason: "busy" }, now), false);
});

test("a film's notes sit beside its shots", () => {
  assert.equal(turnFilmNotesKey("users/u1/turn-videos/f1-ab-3.mp4"), "users/u1/turn-videos/f1-ab.json");
  assert.equal(turnVideoEmbed("users/u1/turn-videos/f1-0.mp4"), `[video:${turnVideoPath("users/u1/turn-videos/f1-0.mp4")}|sound]`);
  assert.equal(turnVideoKeyOf(turnVideoPath("users/u1/turn-videos/f1-0.mp4")), "users/u1/turn-videos/f1-0.mp4");
  assert.equal(turnVideoKeyOf(turnVideoPath("users/u1/turn-images/p.jpg")), null);
});
