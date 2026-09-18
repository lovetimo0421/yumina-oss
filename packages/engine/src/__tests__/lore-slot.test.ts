import { describe, it, expect } from "vitest";
import { extractLoreSlotsFromFiles } from "../lorebook/lore-slot-scan.js";
import { resolveLoreSlotContent } from "../lorebook/lore-slot.js";
import { createMockEntry, createMockGameState, createMockCondition } from "./test-utils.js";

describe("extractLoreSlotsFromFiles", () => {
  it("finds LoreSlot ids across files", () => {
    const slots = extractLoreSlotsFromFiles({
      "index.tsx": `export default function App() {\n  return <LoreSlot id="world-bible" />;\n}`,
      "panel.tsx": `<LoreSlot id={'side-lore'} />`,
    });
    expect(slots).toHaveLength(2);
    expect(slots.map((s) => s.slotId).sort()).toEqual(["side-lore", "world-bible"]);
  });

  it("skips non-string file values", () => {
    const slots = extractLoreSlotsFromFiles({
      "index.tsx": `<LoreSlot id="ok" />`,
      "broken.tsx": undefined as unknown as string,
    });
    expect(slots).toHaveLength(1);
    expect(slots[0]?.slotId).toBe("ok");
  });

  it("detects high-level <LoreButton slotId> controls", () => {
    const slots = extractLoreSlotsFromFiles({
      "index.tsx": `<LoreButton slotId="magic-lore" label="魔法" variant="card" />`,
    });
    expect(slots.map((s) => s.slotId)).toEqual(["magic-lore"]);
  });

  it("detects <LoreSwitch slotId> (explicit on/off) controls", () => {
    const slots = extractLoreSlotsFromFiles({
      "index.tsx": `<LoreSwitch slotId="secret-codex" onLabel="开启" offLabel="关闭" />`,
    });
    expect(slots.map((s) => s.slotId)).toEqual(["secret-codex"]);
  });

  it("pulls ids out of a multi-line <LoreGroup slots={[...]}>", () => {
    const slots = extractLoreSlotsFromFiles({
      "index.tsx": `<LoreGroup\n  slots={[\n    { id: "focus-history", label: "历史" },\n    { id: "focus-tactics", label: "战术" },\n  ]}\n/>`,
    });
    expect(slots.map((s) => s.slotId).sort()).toEqual([
      "focus-history",
      "focus-tactics",
    ]);
  });

  it("dedupes a slot referenced by both a control and a raw LoreSlot", () => {
    const slots = extractLoreSlotsFromFiles({
      "index.tsx": `<LoreButton slotId="x" />\n{active && <LoreSlot id="x" />}`,
    });
    expect(slots).toHaveLength(1);
    expect(slots[0]?.slotId).toBe("x");
  });
});

describe("resolveLoreSlotContent", () => {
  it("returns bound entry content when entry conditions pass", () => {
    const entry = createMockEntry({
      id: "e1",
      content: "Full world bible",
      conditions: [],
    });
    const bindings = [{ slotId: "world-bible", entryId: "e1", conditions: [], conditionLogic: "all" as const }];
    const state = createMockGameState({ variables: { scene: "town" } });
    const resolved = resolveLoreSlotContent("world-bible", bindings, [entry], state);
    expect(resolved.content).toBe("Full world bible");
  });

  it("respects entry-level variable conditions", () => {
    const entry = createMockEntry({
      id: "e1",
      content: "Secret lore",
      conditions: [createMockCondition({ variableId: "unlocked", operator: "eq", value: 1 })],
    });
    const bindings = [{
      slotId: "secret",
      entryId: "e1",
      conditions: [],
      conditionLogic: "all" as const,
    }];
    const locked = resolveLoreSlotContent(
      "secret",
      bindings,
      [entry],
      createMockGameState({ variables: { unlocked: 0 } }),
    );
    expect(locked.content).toBe("");
    const unlocked = resolveLoreSlotContent(
      "secret",
      bindings,
      [entry],
      createMockGameState({ variables: { unlocked: 1 } }),
    );
    expect(unlocked.content).toBe("Secret lore");
  });
});
