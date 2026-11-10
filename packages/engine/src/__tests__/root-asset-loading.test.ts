import { describe, expect, it } from "vitest";
import { rootComponentSchema, worldDefinitionSchema } from "../world/schema.js";
import { mergeWorldDefinition } from "../world/merge.js";
import { createMockWorld } from "./test-utils.js";

type Mode = "automatic" | "on-demand";
const root = (assetLoading?: Mode) => ({
  id: "root", name: "Root", entryFile: "index.tsx",
  files: { "index.tsx": "export default () => null" }, updatedAt: "2026-10-07",
  ...(assetLoading === undefined ? {} : { assetLoading }),
});
const world = (mode?: Mode) => createMockWorld({ id: "world", rootComponent: root(mode) });

describe("root asset loading schema", () => {
  it.each([undefined, "automatic", "on-demand"] as const)("retains %s through world parse and JSON clone", (mode) => {
    const parsed = worldDefinitionSchema.parse(JSON.parse(JSON.stringify(world(mode))));
    expect(parsed.rootComponent?.assetLoading).toBe(mode);
    expect(rootComponentSchema.parse(parsed.rootComponent).assetLoading).toBe(mode);
    if (mode === undefined) expect(parsed.rootComponent).not.toHaveProperty("assetLoading");
  });

  it.each(["lazy", "", null, false, 1, {}, []].map(mode => ({ mode })))("rejects malformed mode $mode", ({ mode }) => {
    expect(rootComponentSchema.safeParse({ ...root(), assetLoading: mode }).success).toBe(false);
  });
});

describe("root asset loading three-way merge", () => {
  it.each([
    ["automatic", "automatic", "on-demand", "on-demand"],
    ["on-demand", "on-demand", "automatic", "automatic"],
    [undefined, undefined, "on-demand", "on-demand"],
    ["automatic", "on-demand", "automatic", "on-demand"],
    ["on-demand", "automatic", "on-demand", "automatic"],
    ["on-demand", undefined, "on-demand", undefined],
    ["on-demand", "on-demand", undefined, undefined],
    [undefined, "on-demand", "on-demand", "on-demand"],
  ] as const)("base=%s local=%s server=%s retains %s without conflict", (base, local, server, expected) => {
    const inputs = [world(base), world(local), world(server)] as const;
    const before = structuredClone(inputs);
    const result = mergeWorldDefinition(...inputs);
    expect(result.merged.rootComponent?.assetLoading).toBe(expected);
    expect(result.conflicts).toEqual([]);
    expect(inputs).toEqual(before);
  });

  it("keeps a local edit and reports the conflicting server mode", () => {
    const result = mergeWorldDefinition(world(), world("on-demand"), world("automatic"));
    expect(result.merged.rootComponent?.assetLoading).toBe("on-demand");
    expect(result.conflicts).toEqual([{ collection: "rootComponent", id: "assetLoading", reason: "both-edited" }]);
  });
});
