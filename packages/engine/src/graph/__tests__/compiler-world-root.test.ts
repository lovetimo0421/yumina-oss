import { describe, it, expect } from "vitest";
import { toGraph } from "../compiler.js";
import type { WorldEntry } from "../../types/index.js";

// The card itself is an object on the canvas, not an off-screen settings page.
// Its one wire is load-bearing: every opening belongs to this card, and
// switching openings is a real runtime move (switchGreeting).

function entry(overrides: Partial<WorldEntry> & { id: string }): WorldEntry {
  return {
    name: overrides.id, content: "", role: "lore", alwaysSend: false,
    keywords: [], conditions: [], conditionLogic: "all", enabled: true,
    position: 0, section: "system-presets",
    ...overrides,
  };
}

describe("toGraph — the card root node", () => {
  const world = {
    name: "Sakura Season",
    description: "A spring that will not end.",
    avatar: "https://cdn.example/cover.png",
    variables: [], rules: [],
    entries: [
      entry({ id: "g1", role: "greeting", name: "Morning" }),
      entry({ id: "g2", role: "greeting", name: "Night" }),
      entry({ id: "lore1" }),
    ],
  };
  const graph = toGraph(world);
  const node = (id: string) => graph.nodes.find((n) => n.id === id);

  it("projects the card as a world node carrying its identity", () => {
    const root = node("world:root");
    expect(root).toBeDefined();
    expect(root!.kind).toBe("world");
    expect(root!.title).toBe("Sakura Season");
    expect(root!.data.drillTarget).toBe("overview");
    expect(root!.data.coverUrl).toBe("https://cdn.example/cover.png");
    expect(root!.data.description).toBe("A spring that will not end.");
    expect(root!.parentId).toBeUndefined();
  });

  it("wires the card to every opening", () => {
    const wires = graph.edges.filter((e) => e.from === "world:root");
    expect(wires.map((e) => e.to).sort()).toEqual(["greeting:g1", "greeting:g2"]);
    expect(wires.every((e) => e.fromPort === "openings" && e.toPort === "opening")).toBe(true);
  });

  it("gives greetings an inbound opening port so the wire has somewhere to land", () => {
    expect(node("greeting:g1")!.ports.some((p) => p.id === "opening" && p.direction === "in")).toBe(true);
  });

  it("exists even for a card with no openings and no identity fields", () => {
    const bare = toGraph({ variables: [], rules: [], entries: [] });
    const root = bare.nodes.find((n) => n.id === "world:root");
    expect(root).toBeDefined();
    expect(root!.title).toBe("");
    expect(bare.edges.filter((e) => e.from === "world:root")).toHaveLength(0);
  });
});
