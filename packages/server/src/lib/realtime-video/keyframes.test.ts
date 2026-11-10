import assert from "node:assert/strict";
import test from "node:test";
import { keyframePrompt, pictureStyle, plateRefGraph, plateRefPrompt, silentShot, softBlush, withoutPlayer } from "./keyframes.js";

test("a keyframe's prompt carries no spoken lines, so no subtitles get drawn", () => {
  const shot = "Medium shot: she gestures toward the chest and says softly: 「待っていたわ。」 She smiles. All dialogue is spoken in Japanese only. No subtitles, captions or on-screen text.";
  const quiet = silentShot(shot);
  assert.ok(!quiet.includes("待っていた"));
  assert.ok(!/dialogue|subtitle/i.test(quiet));
  assert.ok(quiet.includes("gestures toward the chest"));
  assert.ok(quiet.includes("She smiles."));
  assert.ok(keyframePrompt(shot, ["Mira"]).includes("Image 2 is a character reference of Mira, who is not in image 1 yet"));
});

test("a burning red blush becomes a faint pink one, not a glowing red patch", () => {
  const quiet = silentShot("A blazing crimson blush spreads rapidly from her earlobes down to her pale neck.");
  assert.ok(quiet.includes("A faint pink blush spreads"));
  assert.ok(!/crimson|blazing/i.test(quiet));
  assert.ok(silentShot("Vivid crimson flushes down the tips of her pale ears.").startsWith("faint pink flushes"));
  assert.ok(silentShot("Her ears turn bright red.").includes("turn faint pink"));
});

test("a picture's style keeps what the look is and drops its 'Not …' sentence", () => {
  const look = "Visual style: high-quality digital anime illustration with soft cel-shading. Not a gritty sketch, not a 3D model.";
  assert.equal(pictureStyle(look), "Visual style: high-quality digital anime illustration with soft cel-shading.");
});

test("a plate drawn from portraits treats each as a reference sheet; the cover only stands in without them", () => {
  const prompt = plateRefPrompt("Visual style: anime.", "A train compartment at sunset. Draconia Malfoy stands in the doorway.", false, ["Draconia Malfoy"]);
  assert.ok(prompt.startsWith("Image 1 is a character reference sheet of Draconia Malfoy"));
  assert.ok(prompt.includes("and for the art style"));
  assert.ok(prompt.includes("Draconia Malfoy appears exactly once"));
  assert.ok(prompt.includes("Do not copy the reference sheets' poses"));
  const two = plateRefPrompt("Visual style: anime.", "A hall.", false, ["Mira", "Ren"]);
  assert.ok(two.includes("Image 2 is a character reference sheet of Ren"));
  assert.ok(two.includes("each of Mira, Ren appears exactly once"));
  const cover = plateRefPrompt("Visual style: anime.", "A hall.", true, []);
  assert.ok(cover.includes("Image 1 is only a style sample: none of its people"));
  const text = plateRefPrompt("Visual style: anime. Not 3D.", "A hall.", false, []);
  assert.ok(text.startsWith("Visual style: anime."));
  assert.ok(!text.includes("Not 3D"));
  const g = plateRefGraph(["mira.png", "ren.png"], two, 1);
  assert.equal(g.img1?.inputs.image, "mira.png");
  assert.equal(g.img2?.inputs.image, "ren.png");
  assert.deepEqual(g.posraw?.inputs.image2, ["img2", 0]);
});

test("red skin in any wording becomes a faint pink, for keyframes and the video model alike", () => {
  assert.equal(softBlush("She looks up, ears blazing red as she mutters."), "She looks up, ears faintly pink as she mutters.");
  assert.equal(softBlush("her earlobes flush crimson"), "her earlobes flush faint pink");
  assert.equal(softBlush("a red scarf"), "a red scarf");
  assert.equal(softBlush("her red-rimmed eyes wide with dread"), "her teary eyes wide with dread");
  assert.ok(keyframePrompt("Close-up on her.").includes("Everyone appears exactly once and nobody new is added."));
});

test("the player named in a shot becomes the camera, so no picture draws them", () => {
  const quiet = silentShot("Draconia Malfoy stands near the sliding door, facing Harry (player's first-person perspective), her hand held out.");
  assert.ok(quiet.includes("facing the camera, her hand held out."));
  assert.ok(!quiet.includes("Harry"));
});

// The prod bathroom film (2026-10-19): the ghost took the heroine's face, a headband she had lost in
// the story came back on a second her, a boy stood in the doorway, and the mirror held a stranger.
const BATHROOM = "A dim girls' bathroom with a cracked mirror over the sink. Draconia Malfoy stands facing you near the sink, wand raised, her hair disheveled without her headband. Moaning Myrtle floats near an open stall. You stand near the doorway with your school bag slung over your shoulder.";
const MYRTLE = { name: "Moaning Myrtle", look: "ghost girl, about 14, translucent pearly silver, black pigtails, thick round glasses" };

test("someone with no portrait is described, and nobody else gets the portrait's face", () => {
  const plate = plateRefPrompt("Visual style: anime.", BATHROOM, false, ["Draconia Malfoy"], [MYRTLE]);
  assert.ok(plate.includes("Moaning Myrtle looks like this: ghost girl, about 14, translucent pearly silver, black pigtails, thick round glasses."));
  assert.ok(plate.includes("Only Draconia Malfoy has the face of the reference picture; everyone else has their own clearly different face"));
  assert.ok(plate.includes("each of Draconia Malfoy, Moaning Myrtle appears exactly once"));
});

test("a keyframe says who is who in the plate instead of adding portraits, which drew people twice", () => {
  const DRACO = { name: "Draconia Malfoy", look: "girl, about 16, long platinum-blonde hair, black headband" };
  const key = keyframePrompt("Medium shot of Moaning Myrtle drifting down beside the sink as Draconia Malfoy trembles.", [], [DRACO, MYRTLE]);
  assert.ok(key.startsWith("A new camera angle of the same scene as image 1"));
  assert.ok(key.includes("Who is who in image 1: Draconia Malfoy is the girl who looks like this: girl, about 16"));
  assert.ok(key.includes("Moaning Myrtle is the ghost girl who looks like this"));
  assert.ok(key.includes("nobody takes on another person's glasses"));
  assert.ok(key.includes("nobody new is added"));
  assert.ok(key.includes("Mirrors, windows and water never show the player."));
  assert.ok(!key.includes("Image 2"));
  assert.ok(keyframePrompt("Ren walks in.", ["Ren"]).includes("nobody else is added"));
});

test("the story's changes to hair and accessories win over the reference sheet", () => {
  const plate = plateRefPrompt("Visual style: anime.", BATHROOM, false, ["Draconia Malfoy"]);
  assert.ok(plate.includes("hairstyle, accessories and clothing as in the sheet unless the scene says otherwise, and then as the scene says"));
  assert.ok(plate.includes("without her headband"));
});

test("where the player stands stays out of a plate, and the player has no reflection", () => {
  assert.ok(!withoutPlayer(BATHROOM).includes("school bag"));
  assert.ok(withoutPlayer(BATHROOM).includes("Draconia Malfoy stands facing you"));
  assert.ok(!plateRefPrompt("Visual style: anime.", BATHROOM, false, ["Draconia Malfoy"]).includes("school bag"));
  const mirror = silentShot("Her grey eyes widen in shock through the glass as she catches your direct reflection in the shadows behind her.");
  assert.ok(!/reflection/.test(mirror));
  assert.ok(mirror.includes("catches you in the shadows"));
  assert.equal(silentShot("Her voice cracking in Japanese: 「来ないで」 while your hand twitches."), "Her voice cracking while your hand twitches.");
});

test("a line that ends its sentence leaves the shot's action behind, not an empty picture prompt", () => {
  const shot = "Close-up on Draconia Malfoy as her rotating wand abruptly halts in her grip, her tone hardening in Japanese: 「三つ目、詮索は一切なし。」 All dialogue is spoken in Japanese only, never English. Spoken lines are heard, never shown: no subtitles, captions or on-screen text.";
  assert.equal(silentShot(shot), "Close-up on Draconia Malfoy as her rotating wand abruptly halts in her grip, her tone hardening.");
  assert.equal(silentShot("Myrtle calls out 「あら、ハリー！」 Draconia snaps without turning: 「黙りなさい！」 The stall door slams."), "Myrtle calls out. Draconia snaps without turning. The stall door slams.");
  assert.equal(silentShot("She murmurs 「いいよ」 as she turns away."), "She murmurs as she turns away.");
  const key = keyframePrompt("She sits.", [], [{ name: "Draconia Malfoy", look: "A slender sixteen-year-old girl with pale skin, grey eyes" }]);
  assert.ok(key.includes("Draconia Malfoy is the slender sixteen-year-old girl with pale skin who looks like this"));
});
