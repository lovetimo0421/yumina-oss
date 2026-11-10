import { describe, it, expect } from "vitest";
import {
  activeBackgroundId,
  aiSelectableBackgrounds,
  nextBackgroundId,
  resolveBackground,
  BACKGROUND_VARIABLE,
  BACKGROUND_METADATA_KEY,
  DEFAULT_BLUR,
  DEFAULT_DIM,
  DEFAULT_OPACITY,
} from "./background.js";
import { COVER_BACKGROUND_URL, type BackgroundImage } from "../types/index.js";
import type { BackgroundStateSlice } from "./background.js";

const bg = (over: Partial<BackgroundImage> & { id: string }): BackgroundImage => ({
  name: over.id,
  url: `https://example.test/${over.id}.jpg`,
  ...over,
});

const state = (variables: Record<string, unknown>): BackgroundStateSlice => ({ variables });

describe("activeBackgroundId", () => {
  it("is null when the card has none", () => {
    expect(activeBackgroundId({ backgrounds: [] }, null)).toBeNull();
    expect(activeBackgroundId({}, null)).toBeNull();
  });

  it("prefers the handle the state names", () => {
    const world = { backgrounds: [bg({ id: "bg1", isDefault: true }), bg({ id: "bg2" })] };
    expect(activeBackgroundId(world, state({ [BACKGROUND_VARIABLE]: "bg2" }))).toBe("bg2");
  });

  it("reads the platform's metadata slot", () => {
    const world = { backgrounds: [bg({ id: "bg1", isDefault: true }), bg({ id: "bg2" })] };
    expect(activeBackgroundId(world, { metadata: { [BACKGROUND_METADATA_KEY]: "bg2" } })).toBe("bg2");
  });

  it("lets metadata win over a card's own currentBg variable", () => {
    // A custom-UI card that already drove its own background keeps working,
    // but a `[bg: id]` the platform just handled is the newer instruction.
    const world = { backgrounds: [bg({ id: "bg1" }), bg({ id: "bg2" })] };
    expect(activeBackgroundId(world, {
      metadata: { [BACKGROUND_METADATA_KEY]: "bg2" },
      variables: { [BACKGROUND_VARIABLE]: "bg1" },
    })).toBe("bg2");
  });

  it("falls through when the named handle no longer exists", () => {
    // Deleting a picture must not leave old sessions staring at nothing.
    const world = { backgrounds: [bg({ id: "bg1", isDefault: true })] };
    expect(activeBackgroundId(world, state({ [BACKGROUND_VARIABLE]: "deleted" }))).toBe("bg1");
  });

  it("uses the opening's own background before the default", () => {
    const world = {
      backgrounds: [bg({ id: "bg1", isDefault: true }), bg({ id: "bg2", greetingIds: ["g-classroom"] })],
    };
    expect(activeBackgroundId(world, null, "g-classroom")).toBe("bg2");
    expect(activeBackgroundId(world, null, "g-other")).toBe("bg1");
  });

  it("never lets an opening-scoped picture become the card-wide fallback", () => {
    const world = { backgrounds: [bg({ id: "bg1", greetingIds: ["g-one"] }), bg({ id: "bg2" })] };
    expect(activeBackgroundId(world, null, null)).toBe("bg2");
  });

  it("returns null when every background is scoped to some other opening", () => {
    const world = { backgrounds: [bg({ id: "bg1", greetingIds: ["g-one"] })] };
    expect(activeBackgroundId(world, null, "g-two")).toBeNull();
  });

  it("takes the flagged default over document order", () => {
    const world = { backgrounds: [bg({ id: "bg1" }), bg({ id: "bg2", isDefault: true })] };
    expect(activeBackgroundId(world, null)).toBe("bg2");
  });
});

describe("resolveBackground", () => {
  it("fills the treatment an author never touched", () => {
    const world = { backgrounds: [bg({ id: "bg1" })] };
    expect(resolveBackground(world, null)).toEqual({
      id: "bg1",
      url: "https://example.test/bg1.jpg",
      blur: DEFAULT_BLUR,
      dim: DEFAULT_DIM / 100,
      opacity: DEFAULT_OPACITY / 100,
      position: "center",
    });
  });

  it("clamps out-of-range treatment and reports dim as a multiplier", () => {
    const world = { backgrounds: [bg({ id: "bg1", blur: 99, dim: 99 })] };
    const resolved = resolveBackground(world, null);
    expect(resolved?.blur).toBe(20);
    expect(resolved?.dim).toBe(0.8);
  });

  it("substitutes the cover sentinel", () => {
    const world = { backgrounds: [bg({ id: "bg1", url: COVER_BACKGROUND_URL })] };
    expect(resolveBackground(world, null, { coverUrl: "https://cdn.test/cover.png" })?.url)
      .toBe("https://cdn.test/cover.png");
  });

  it("paints nothing when the cover-backed background has no cover yet", () => {
    const world = { backgrounds: [bg({ id: "bg1", url: COVER_BACKGROUND_URL })] };
    expect(resolveBackground(world, null, { coverUrl: null })).toBeNull();
  });
});

describe("aiSelectableBackgrounds", () => {
  it("only offers the ones with a sentence and permission", () => {
    const world = {
      backgrounds: [
        bg({ id: "bg1", scene: "rainy night" }),
        bg({ id: "bg2" }),
        bg({ id: "bg3", scene: "dawn", allowAiControl: false }),
      ],
    };
    expect(aiSelectableBackgrounds(world).map((b) => b.id)).toEqual(["bg1"]);
  });

  it("drops ones scoped to a different opening", () => {
    const world = {
      backgrounds: [
        bg({ id: "bg1", scene: "a", greetingIds: ["g-one"] }),
        bg({ id: "bg2", scene: "b" }),
      ],
    };
    expect(aiSelectableBackgrounds(world, "g-two").map((b) => b.id)).toEqual(["bg2"]);
    expect(aiSelectableBackgrounds(world, "g-one").map((b) => b.id)).toEqual(["bg1", "bg2"]);
  });
});

describe("nextBackgroundId", () => {
  it("fills the first free slot", () => {
    expect(nextBackgroundId([])).toBe("bg1");
    expect(nextBackgroundId([{ id: "bg1" }, { id: "bg3" }])).toBe("bg2");
  });
});

describe("opacity", () => {
  it("is the picture's own alpha, separate from dim, and never reaches zero", () => {
    const one = (extra: Partial<BackgroundImage>): BackgroundImage =>
      ({ id: "bg1", name: "a", url: "https://x/a.png", ...extra });

    const resolved = resolveBackground({ backgrounds: [one({ dim: 40, opacity: 25 })] }, null)!;
    expect(resolved.opacity).toBe(0.25);
    // dim is untouched by it: black over the area, not the picture's alpha.
    expect(resolved.dim).toBe(0.4);

    // Unset is fully there — an author who never finds the slider loses nothing.
    expect(resolveBackground({ backgrounds: [one({})] }, null)!.opacity).toBe(1);

    // A background dragged to nothing looks broken; "I do not want one" is a
    // delete, not a slider.
    expect(resolveBackground({ backgrounds: [one({ opacity: 0 })] }, null)!.opacity).toBe(0.1);
  });
});
