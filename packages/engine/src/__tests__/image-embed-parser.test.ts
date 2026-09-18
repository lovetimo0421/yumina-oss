import { describe, it, expect } from "vitest";
import { parseImageEmbeds, renderImageEmbedHtml } from "../parser/image-embed-parser.js";

describe("image-embed-parser", () => {
  it("parses simple [image:url] directives", () => {
    const parsed = parseImageEmbeds("Hello\n[image:https://example.com/a.png]\nWorld");
    expect(parsed.embeds).toHaveLength(1);
    expect(parsed.embeds[0]?.url).toBe("https://example.com/a.png");
    expect(parsed.embeds[0]?.size).toBe("md");
    expect(parsed.embeds[0]?.placement).toBe("center");
    expect(parsed.cleanText).toContain("\x00IM0\x00");
  });

  it("parses metadata fields", () => {
    const parsed = parseImageEmbeds(
      "[image:https://example.com/a.png|alt=Scene|caption=Dark forest|size=lg|placement=right]"
    );
    expect(parsed.embeds[0]).toEqual({
      url: "https://example.com/a.png",
      alt: "Scene",
      caption: "Dark forest",
      size: "lg",
      placement: "right",
    });
  });

  it("ignores non-https image directives", () => {
    const parsed = parseImageEmbeds("[image:http://example.com/a.png] [image:javascript:alert(1)]");
    expect(parsed.embeds).toHaveLength(0);
    expect(parsed.cleanText).toContain("[image:http://example.com/a.png]");
    expect(parsed.cleanText).toContain("[image:javascript:alert(1)]");
  });

  it("renders html card with escaped text", () => {
    const html = renderImageEmbedHtml({
      url: "https://example.com/a.png",
      alt: "A <scene>",
      caption: "Caption & text",
      size: "sm",
      placement: "left",
    });
    expect(html).toContain("https://example.com/a.png");
    expect(html).toContain("A &lt;scene&gt;");
    expect(html).toContain("Caption &amp; text");
  });
});
