import { describe, it, expect } from "vitest";
import { PromptBuilder } from "../prompts/prompt-builder.js";
import { GameStateManager } from "../state/game-state-manager.js";
import { ResponseParser } from "../parser/response-parser.js";
import { createMockWorld, createMockVariable, createMockGameState } from "./test-utils.js";

/**
 * Regression: the engine supported `append` on strings but never told the model
 * it existed — the injected <directive-format> block documented only `set` for
 * strings. A card whose string variable is a running list (e.g. a "、"-joined
 * debuff list) left the model no legal way to extend it, so it emitted
 * `[var: add "..."]`, which applyEffects drops on the floor for a string. The
 * variable then never moves, with zero feedback to player or creator.
 */
describe("directive-format documents append for strings", () => {
  const world = createMockWorld({
    variables: [
      createMockVariable({ id: "hp", name: "hp", type: "number", defaultValue: 100 }),
      createMockVariable({ id: "debuff", name: "debuff", type: "string", defaultValue: "" }),
    ],
  });

  it("advertises append in the directive-format block", () => {
    // The block is assembled once per world and cached by the server — every
    // send/regen/continue path goes through buildStaticFormatBlock.
    const prompt = new PromptBuilder().buildStaticFormatBlock(world);
    const block = prompt.slice(prompt.indexOf("<directive-format>"), prompt.indexOf("</directive-format>"));
    expect(block).toContain("append");
  });

  it("warns that add is a no-op on strings — the exact trap that was hit", () => {
    // The block is assembled once per world and cached by the server — every
    // send/regen/continue path goes through buildStaticFormatBlock.
    const prompt = new PromptBuilder().buildStaticFormatBlock(world);
    expect(prompt).toMatch(/`add` only works on numbers/);
  });

  it("the advertised append syntax actually round-trips through the engine", () => {
    // Guards against documenting a form the parser/state manager won't honor.
    const gsm = new GameStateManager(
      world,
      createMockGameState({ worldId: world.id, variables: { hp: 100, debuff: "袜子A" } }),
    );
    const { effects } = new ResponseParser().parse('[debuff: append "、袜子B"]');
    gsm.applyEffects(effects);
    expect(gsm.get("debuff")).toBe("袜子A、袜子B");
  });

  it("documents that the separator goes inside the value (append does not add one)", () => {
    const gsm = new GameStateManager(
      world,
      createMockGameState({ worldId: world.id, variables: { hp: 100, debuff: "袜子A" } }),
    );
    const { effects } = new ResponseParser().parse('[debuff: append "袜子B"]');
    gsm.applyEffects(effects);
    // Bare concatenation — this is why the block tells the model to include the
    // separator itself, and why coercing `add`→`append` would corrupt lists.
    expect(gsm.get("debuff")).toBe("袜子A袜子B");
  });

  it("still drops add-on-string (documenting append is the fix, not coercion)", () => {
    const gsm = new GameStateManager(
      world,
      createMockGameState({ worldId: world.id, variables: { hp: 100, debuff: "袜子A" } }),
    );
    const { effects } = new ResponseParser().parse('[debuff: add "袜子B"]');
    const changes = gsm.applyEffects(effects);
    expect(changes).toEqual([]);
    expect(gsm.get("debuff")).toBe("袜子A");
  });
});
