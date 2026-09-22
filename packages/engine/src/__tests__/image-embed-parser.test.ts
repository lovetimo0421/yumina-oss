import { describe, it, expect } from "vitest";
import {
  isImageEmbedSource,
  parseImageEmbeds,
  renderImageEmbedHtml,
} from "../parser/image-embed-parser.js";

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

  // Creators point an embed at a picture in their own library — that is what
  // the editor's insert button writes. Refusing `@asset:` left the author with
  // a directive that reached players as literal text.
  it("accepts library asset refs and same-origin cdn paths", () => {
    const asset = "@asset:c4100969-1efb-4fb0-9850-595dcc625da7";
    const parsed = parseImageEmbeds(`[image:${asset}|alt=Hall] and [image:/cdn/abc123]`);
    expect(parsed.embeds.map((e) => e.url)).toEqual([asset, "/cdn/abc123"]);
    expect(parsed.embeds[0]?.alt).toBe("Hall");
  });

  it("still refuses asset refs that are not a full uuid", () => {
    const parsed = parseImageEmbeds("[image:@asset:not-a-uuid] [image:@asset:../../etc]");
    expect(parsed.embeds).toHaveLength(0);
  });

  it("draws the source line at exactly the three safe shapes", () => {
    expect(isImageEmbedSource("https://example.com/a.png")).toBe(true);
    expect(isImageEmbedSource("@asset:c4100969-1efb-4fb0-9850-595dcc625da7")).toBe(true);
    expect(isImageEmbedSource("/cdn/c4100969")).toBe(true);
    expect(isImageEmbedSource("http://example.com/a.png")).toBe(false);
    expect(isImageEmbedSource("data:image/png;base64,AAA")).toBe(false);
    expect(isImageEmbedSource("javascript:alert(1)")).toBe(false);
    expect(isImageEmbedSource("//evil.example.com/a.png")).toBe(false);
  });

  it("renders through the caller's url resolver when one is given", () => {
    const html = renderImageEmbedHtml(
      {
        url: "@asset:c4100969-1efb-4fb0-9850-595dcc625da7",
        size: "md",
        placement: "center",
      },
      (url) => url.replace(/^@asset:/, "/cdn/"),
    );
    expect(html).toContain('src="/cdn/c4100969-1efb-4fb0-9850-595dcc625da7"');
    expect(html).not.toContain("@asset:");
  });

  it("leaves the source alone when no resolver is given", () => {
    const html = renderImageEmbedHtml({
      url: "@asset:c4100969-1efb-4fb0-9850-595dcc625da7",
      size: "md",
      placement: "center",
    });
    expect(html).toContain('src="@asset:c4100969-1efb-4fb0-9850-595dcc625da7"');
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
