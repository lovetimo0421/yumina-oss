import { describe, expect, it } from "vitest";
import { worldDefinitionSchema } from "../world/schema";

const mobile = { x: 12, y: -9, zoom: .7, fit: "cover" as const };
const desktop = { x: -21, y: 14, zoom: .4, fit: "cover" as const };
describe("gallery device crop persistence", () => {
  it("preserves both frames through world save, JSON and reload", () => {
    const value = { id: "test", name: "Crop test", description: "", author: "", settings: {}, landscapeCoverCrop: { ...mobile, desktop }, galleryCoverCrop: { ...mobile, desktop } };
    const first = worldDefinitionSchema.parse(value);
    const reloaded = worldDefinitionSchema.parse(JSON.parse(JSON.stringify(first)));
    expect(reloaded.landscapeCoverCrop).toEqual({ ...mobile, desktop });
    expect(reloaded.galleryCoverCrop).toEqual({ ...mobile, desktop });
  });
  it("keeps the shape a banner crop was framed in, and leaves an older crop without one", () => {
    const framed = { ...desktop, aspect: 21 / 9 };
    const value = { id: "test", name: "Crop test", description: "", author: "", settings: {}, landscapeCoverCrop: { ...mobile, desktop: framed }, galleryCoverCrop: { ...mobile, desktop } };
    const reloaded = worldDefinitionSchema.parse(JSON.parse(JSON.stringify(worldDefinitionSchema.parse(value))));
    expect(reloaded.landscapeCoverCrop).toEqual({ ...mobile, desktop: framed });
    expect(reloaded.galleryCoverCrop).toEqual({ ...mobile, desktop });
    expect(worldDefinitionSchema.safeParse({ ...value, landscapeCoverCrop: { ...mobile, desktop: { ...desktop, aspect: 0 } } }).success).toBe(false);
  });
  it("rejects invalid desktop coordinates", () => {
    expect(worldDefinitionSchema.safeParse({ id: "test", name: "Crop test", description: "", author: "", settings: {}, landscapeCoverCrop: { ...mobile, desktop: { ...desktop, x: 99 } } }).success).toBe(false);
  });
});
