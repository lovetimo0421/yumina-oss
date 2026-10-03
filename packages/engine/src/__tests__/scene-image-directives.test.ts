import { describe, it, expect } from "vitest";
import {
  getAiSceneImages,
  resolveSceneImageDirectives,
  sceneImageEmbed,
  reclaimCopiedSceneImages,
  hasSceneImageHandle,
  buildSceneImagePromptBlock,
  hasImageVariable,
} from "../parser/scene-image-directives.js";
import { parseImageEmbeds, isImageEmbedSource, renderImageEmbedHtml } from "../parser/image-embed-parser.js";
import { ResponseParser } from "../parser/response-parser.js";
import { StructuredResponseParser } from "../parser/structured-response-parser.js";
import { PromptBuilder } from "../prompts/prompt-builder.js";
import type { SceneImage, WorldDefinition } from "../types/index.js";

const ASSET = "@asset:0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b";

const images: SceneImage[] = [
  { id: "img1", name: "Minyu startled", url: ASSET, scene: "The cat Minyu is surprised", hint: "W-What the meow?!" },
  { id: "img2", name: "Rainy window", url: "https://cdn.example.com/rain.png", scene: "Rain against the window at night" },
  { id: "img3", name: "Unsourced", url: "", scene: "never shows" },
  { id: "img4", name: "Manual only", url: ASSET, scene: "author-triggered", allowAiControl: false },
  { id: "img5", name: "Opening B only", url: ASSET, scene: "only in opening B", greetingIds: ["greet-b"] },
];

describe("getAiSceneImages", () => {
  it("drops unsourced and manual-only images and respects opening scope", () => {
    expect(getAiSceneImages(images).map((i) => i.id)).toEqual(["img1", "img2"]);
    expect(getAiSceneImages(images, "greet-b").map((i) => i.id)).toEqual(["img1", "img2", "img5"]);
    expect(getAiSceneImages(images, "greet-a").map((i) => i.id)).toEqual(["img1", "img2"]);
  });
});

describe("resolveSceneImageDirectives", () => {
  it("expands a handle into the shared embed syntax and reports what was shown", () => {
    const { text, shown } = resolveSceneImageDirectives("She jumped.\n[image: img1]\nThen laughed.", images);
    expect(text).toBe(`She jumped.\n[image:${ASSET}|alt=Minyu startled|scene=img1]\nThen laughed.`);
    expect(shown.map((i) => i.id)).toEqual(["img1"]);
  });

  it("matches case-insensitively and by name, drops unknown handles, dedupes repeats", () => {
    const { text, shown } = resolveSceneImageDirectives(
      "[image: IMG2] a [image:Minyu startled] b [image: nope] c [image: img2]",
      images,
    );
    expect(text).toContain("alt=Rainy window|scene=img2]");
    expect(text).toContain("alt=Minyu startled|scene=img1]");
    expect(text).not.toContain("nope");
    expect(text.match(/scene=img2/g)).toHaveLength(1);
    expect(shown.map((i) => i.id)).toEqual(["img2", "img1"]);
  });

  it("leaves already-expanded render directives untouched", () => {
    const src = `Look: [image:https://x.test/a.png|alt=A|size=lg] and [image:${ASSET}]`;
    expect(resolveSceneImageDirectives(src, images).text).toBe(src);
  });

  it("drops handles whose image has no source", () => {
    expect(resolveSceneImageDirectives("x [image: img3] y", images).text).toBe("x  y");
  });

  it("is a no-op on text without image directives", () => {
    const { text, shown } = resolveSceneImageDirectives("plain [hp: -1] text", images);
    expect(text).toBe("plain [hp: -1] text");
    expect(shown).toEqual([]);
  });
});

describe("sceneImageEmbed", () => {
  it("strips characters that would break the option tokenizer", () => {
    const embed = sceneImageEmbed({ id: "img9", name: "A|B]C", url: ASSET, scene: "" });
    expect(embed).toBe(`[image:${ASSET}|alt=A B C|scene=img9]`);
    const parsed = parseImageEmbeds(embed);
    expect(parsed.embeds[0]).toMatchObject({ url: ASSET, alt: "A B C", scene: "img9" });
  });
});

describe("image embed parser accepts asset refs and cdn paths", () => {
  it("accepts https, @asset and /cdn sources only", () => {
    expect(isImageEmbedSource("https://a.test/x.png")).toBe(true);
    expect(isImageEmbedSource(ASSET)).toBe(true);
    expect(isImageEmbedSource("/cdn/abc")).toBe(true);
    expect(isImageEmbedSource("http://a.test/x.png")).toBe(false);
    expect(isImageEmbedSource("data:image/png;base64,AAAA")).toBe(false);
    expect(isImageEmbedSource("img1")).toBe(false);
  });

  it("renders the scene id as a data attribute and resolves the src through the mapper", () => {
    const { embeds } = parseImageEmbeds(`[image:${ASSET}|alt=Minyu|scene=img1]`);
    const html = renderImageEmbedHtml(embeds[0]!, (u) => u.replace("@asset:", "/cdn/"));
    expect(html).toContain('data-scene-image="img1"');
    expect(html).toContain('src="/cdn/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b"');
  });
});

describe("ResponseParser leaves [image:…] intact", () => {
  const parser = new ResponseParser();

  it("keeps the bare scene handle and the render form, still extracts real directives", () => {
    const raw = `She gasped.\n[image: img1]\n[image:https://x.test/a.png|alt=A]\n[hp: -10] [audio: bgm1 play]`;
    const result = parser.parse(raw);
    expect(result.cleanText).toContain("[image: img1]");
    expect(result.cleanText).toContain("[image:https://x.test/a.png|alt=A]");
    expect(result.effects).toEqual([{ variableId: "hp", operation: "subtract", value: 10 }]);
    expect(result.audioEffects).toEqual([{ trackId: "bgm1", action: "play" }]);
  });

  it("still treats a real `image` variable directive as a directive", () => {
    const result = parser.parse(`x [image: set "portrait.png"]`);
    expect(result.cleanText).toBe("x");
    expect(result.effects).toEqual([{ variableId: "image", operation: "set", value: "portrait.png" }]);
  });
});

describe("StructuredResponseParser sceneImages", () => {
  it("turns a sceneImages handle list into [image: handle] lines", () => {
    const parser = new StructuredResponseParser();
    const result = parser.parse(JSON.stringify({ narrative: "Boo.", stateChanges: [], sceneImages: ["img1", " img2 ", 3] }));
    expect(result.cleanText).toBe("Boo.\n\n[image: img1]\n[image: img2]");
  });
});

describe("PromptBuilder scene image block", () => {
  const world = {
    id: "w", version: "1", name: "W", description: "", author: "",
    entries: [], variables: [], rules: [], components: [], audioTracks: [], customUI: [],
    sceneImages: images,
    // The narrator places images only when the author hands them back to it.
    continuity: { images: false },
    settings: { maxTokens: 100, temperature: 1 },
  } as unknown as WorldDefinition;

  it("says nothing about images while the continuity judge places them", () => {
    const builder = new PromptBuilder();
    const judged = { ...world, continuity: {} } as WorldDefinition;
    expect(builder.buildStaticFormatBlock(judged, { activeGreetingId: "greet-b" })).toBe("");
    // Judge switched off for the whole world: the narrator gets them back.
    const judgeOff = { ...world, continuity: { enabled: false } } as WorldDefinition;
    expect(builder.buildStaticFormatBlock(judgeOff)).toContain("<scene-images>");
  });

  it("lists only AI-visible images for the current opening and teaches the directive", () => {
    const builder = new PromptBuilder();
    const block = builder.buildStaticFormatBlock(world, { activeGreetingId: "greet-b" });
    expect(block).toContain("<scene-images>");
    expect(block).toContain("[image: id]");
    expect(block).toContain("  - img1: The cat Minyu is surprised");
    expect(block).toContain("  - img5: only in opening B");
    expect(block).not.toContain("img3");
    expect(block).not.toContain("img4");
    const unscoped = builder.buildStaticFormatBlock(world);
    expect(unscoped).not.toContain("img5");
  });

  it("emits nothing for a world with no usable images and no variables", () => {
    const builder = new PromptBuilder();
    const bare = { ...world, sceneImages: [images[2]!] } as WorldDefinition;
    expect(builder.buildStaticFormatBlock(bare)).toBe("");
  });

  it("formats the block deterministically", () => {
    expect(buildSceneImagePromptBlock([images[0]!])).toMatchInlineSnapshot(`
      "<scene-images>
      The author attached images to this story. Each line is an image id followed by
      the author's rule for when to send it. Follow each rule exactly as written: a
      rule like "every reply" or "always" means you send that image in every reply;
      a rule naming a moment or condition means you send it in every reply where that
      holds, even if it was sent before. Send an image by writing [image: id] on its
      own line at the point the reader should see it.

        - img1: The cat Minyu is surprised

      Send every image whose rule this reply meets and none whose rule it does not.
      Never use an id that is not listed. Do not describe the image or mention that
      you are sending one; just let it appear.
      </scene-images>"
    `);
  });

  it("treats each description as the author's rule, not a one-off scene match", () => {
    const block = buildSceneImagePromptBlock([{ id: "img9", name: "Cup", url: "u", scene: "任何情况下，每次回复后，发送这个图片" }]);
    expect(block).toContain("img9: 任何情况下，每次回复后，发送这个图片");
    expect(block).toMatch(/every reply/);
    expect(block).not.toMatch(/at most\s+one per reply/);
    expect(block).not.toMatch(/clearly matches/);
  });
});

describe("openings expand scene image handles", () => {
  it("resolves [image: id] inside a greeting the author wrote", () => {
    const world = {
      id: "w", version: "1", name: "W", description: "", author: "",
      entries: [{ id: "g1", name: "Opening", role: "greeting", section: "greeting", content: "Welcome.\n[image: img1]\nLook around.", enabled: true, keywords: [], position: 0 }],
      variables: [], rules: [], components: [], audioTracks: [], customUI: [],
      sceneImages: images,
      settings: { maxTokens: 100, temperature: 1 },
    } as unknown as WorldDefinition;
    const [greeting] = new PromptBuilder().buildGreetings(world, { variables: {} } as never);
    expect(greeting).toBe(`Welcome.\n[image:${ASSET}|alt=Minyu startled|scene=img1]\nLook around.`);
  });
});


describe("cards without scene images keep their old [image: …] behaviour", () => {
  const base = {
    id: "w", version: "1", name: "W", description: "", author: "",
    rules: [], components: [], audioTracks: [], customUI: [],
    settings: { maxTokens: 100, temperature: 1 },
  };

  it("leaves an opening untouched when the card has no scene images", () => {
    const world = {
      ...base,
      entries: [{ id: "g1", name: "Opening", role: "greeting", section: "greeting", content: "Hi.\n[image: forest]", enabled: true, keywords: [], position: 0 }],
      variables: [],
    } as unknown as WorldDefinition;
    const [greeting] = new PromptBuilder().buildGreetings(world, { variables: {} } as never);
    expect(greeting).toBe("Hi.\n[image: forest]");
  });

  it("still writes a card's own `image` variable when the parser is told not to shield", () => {
    const world = { ...base, entries: [], variables: [{ id: "image", name: "image", type: "string", defaultValue: "" }] } as unknown as WorldDefinition;
    expect(hasImageVariable(world)).toBe(true);
    expect(hasImageVariable({ ...world, variables: [] })).toBe(false);
    const res = new ResponseParser().parse("She smiles. [image: https://cdn.example.com/a.png]", undefined, { shieldImages: !hasImageVariable(world) });
    expect(res.effects).toEqual([expect.objectContaining({ variableId: "image" })]);
    expect(res.cleanText).not.toContain("[image:");
  });
});

describe("scene image embeds copied out of history", () => {
  const copied = sceneImageEmbed(images[0]!);
  const reply = `She laughs.\n\n${copied}\n\nThe rain keeps falling.`;

  it("strip mode removes the copy without leaving a blank gap", () => {
    expect(reclaimCopiedSceneImages(reply, images, "strip")).toBe("She laughs.\n\nThe rain keeps falling.");
    expect(reclaimCopiedSceneImages(`${copied}\n\nShe laughs.`, images, "strip")).toBe("She laughs.");
  });

  it("handle mode turns the copy back into a directive that expands and registers", () => {
    const back = reclaimCopiedSceneImages(reply, images, "handle");
    expect(back).toBe("She laughs.\n\n[image: img1]\n\nThe rain keeps falling.");
    const out = resolveSceneImageDirectives(back, images);
    expect(out.shown.map((i) => i.id)).toEqual(["img1"]);
    expect(out.text).toContain(copied);
  });

  it("leaves foreign embeds alone and only counts bare handles as the model's own directive", () => {
    const foreign = "[image:https://x.example/a.png|alt=A|scene=other]";
    expect(reclaimCopiedSceneImages(foreign, images, "strip")).toBe(foreign);
    expect(hasSceneImageHandle(reply)).toBe(false);
    expect(hasSceneImageHandle("[image:/cdn/key/abc|alt=x]")).toBe(false);
    expect(hasSceneImageHandle("Text\n[image: img2]")).toBe(true);
  });
});
