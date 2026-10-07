import { describe, expect, it } from "vitest";
import * as actorContext from "../prompts/actor-context.js";
import { createEmptyRuleState } from "../rules/rule-state.js";
import { createMockEntry, createMockGameState, createMockVariable, createMockWorld } from "./test-utils.js";

const entry = (id: string, overrides: Parameters<typeof createMockEntry>[0] = {}) => createMockEntry({ id, name: id, content: `${id} direction`, role: "style", alwaysSend: true, ...overrides });

describe("actor context", () => {
  it("inherits ordinary Style, shared and requested actor entries, excluding unrelated prose", () => {
    const world = createMockWorld({ entries: [entry("style"), entry("shared", { tags: ["actor:shared"] }), entry("voice", { tags: ["actor:voice"] }), entry("director", { tags: ["actor:director"] }), entry("narrator", { role: "character" }), entry("format", { section: "post-history" }), entry("player", { audience: "player" })] });
    const voice = actorContext.assembleActorContext({ actor: "voice", world, state: createMockGameState() });
    expect(voice.receipt.entryIds).toEqual(["style", "shared", "voice"]);
    expect(voice.receipt.omittedEntryIds).toEqual(["director", "narrator", "format", "player"]);
    expect(voice.instructions).toContain("style direction");
    expect(voice.instructions).not.toContain("director direction");
    expect(actorContext.assembleActorContext({ actor: "director", world, state: createMockGameState() }).receipt.entryIds).toEqual(["style", "shared", "director"]);
  });

  it("honors runtime entry/worldbook toggles, greetings, keyword conditions and recursive retrieval", () => {
    const world = createMockWorld({ entries: [entry("off"), entry("on", { enabled: false }), entry("book-off", { worldbookId: "manual" }), entry("greeting-book", { worldbookId: "opening" }), entry("keyword", { alwaysSend: false, keywords: ["stairs"], content: "landing" }), entry("recursive", { alwaysSend: false, keywords: ["landing"] }), entry("missing", { alwaysSend: false, keywords: ["unspoken"] }), entry("condition", { alwaysSend: false, conditions: [{ variableId: "phase", operator: "eq", value: "inspection" }] })], settings: { maxTokens: 1000, temperature: 1, lorebookRecursionDepth: 1 }, worldbooks: [{ id: "manual", name: "Manual", activation: { mode: "manual" }, order: 0 }, { id: "opening", name: "Opening", activation: { mode: "greeting", greetingIds: ["wake"] }, order: 1 }] });
    const state = createMockGameState({ activeGreetingId: "wake", variables: { phase: "inspection" }, ruleState: { ...createEmptyRuleState(), toggledEntries: { off: false, on: true }, toggledWorldbooks: { manual: false } } });
    const result = actorContext.assembleActorContext({ actor: "voice", world, state, recentMessages: [{ role: "user", content: "the stairs" }] });
    expect(result.receipt.entryIds).toEqual(["on", "greeting-book", "keyword", "recursive", "condition"]);
    expect(result.receipt.omittedEntries).toContainEqual({ id: "book-off", reason: "inactive-worldbook" });
  });

  it("never expands private, internal, undeclared or inactive values or persisted persona/history metadata", () => {
    const variables = [createMockVariable({ id: "public", type: "string", defaultValue: "published", aiAccess: "read" }), createMockVariable({ id: "diary", aiAccess: "none" }), createMockVariable({ id: "internal", internal: true }), createMockVariable({ id: "inactive", enabled: false })];
    const world = createMockWorld({ variables, settings: { maxTokens: 1000, temperature: 1, playerName: "6079" }, entries: [entry("safe", { content: "{{public}} {{diary}} {{internal}} {{inactive}} {{undeclared}} {{user}} {{persona}} {{persona_name}} {{persona_backstory}} {{lastMessage}} {{model}}" })] });
    const state = createMockGameState({ variables: { public: "published", diary: "DIARY_SENTINEL", internal: "INTERNAL_SENTINEL", inactive: "INACTIVE_SENTINEL", undeclared: "UNDECLARED_SENTINEL" }, metadata: { personaName: "REAL_NAME_SENTINEL", personaBackstory: "BACKSTORY_SENTINEL", lastMessage: "PRIVATE_HISTORY_SENTINEL" } });
    const before = JSON.stringify(state);
    const result = actorContext.assembleActorContext({ actor: "voice", world, state, model: "test-model", recentMessages: [{ role: "user", content: "PUBLIC_WORDS" }] });
    expect(result.instructions).toContain("published");
    expect(result.instructions).toContain("6079");
    expect(result.instructions).toContain("PUBLIC_WORDS");
    expect(result.instructions).toContain("test-model");
    expect(JSON.stringify(result)).not.toContain("SENTINEL");
    expect(result.receipt.personaPolicy).toBe("world-player-name-only");
    expect(JSON.stringify(state)).toBe(before);
  });

  it("keeps lore UI activation gates and only expands matching actor character names", () => {
    const world = createMockWorld({ entries: [entry("private-character", { role: "character", name: "OTHER_ACTOR", tags: ["actor:director"] }), entry("voice-character", { role: "character", name: "Official", tags: ["actor:voice"] }), entry("slot", { content: "SECRET_SLOT {{char}}" }), entry("line", { content: "{{char}} speaks" })], loreUiBindings: [{ entryId: "slot", slotId: "secret" }] });
    const result = actorContext.assembleActorContext({ actor: "voice", world, state: createMockGameState() });
    expect(result.instructions).toContain("Official speaks");
    expect(result.instructions).not.toContain("OTHER_ACTOR");
    expect(result.instructions).not.toContain("SECRET_SLOT");
  });

  it("applies enabled system user presets with safe macros and reports unsupported message placements", () => {
    const result = actorContext.assembleActorContext({ actor: "director", world: createMockWorld(), state: createMockGameState(), userPrompts: [
      { id: "style", name: "Style", content: "restrained {{user}}", enabled: true, section: "system-presets" },
      { id: "prefill", name: "Prefill", content: "I narrate", enabled: true, section: "post-history", apiRole: "assistant" },
      { id: "off", name: "Off", content: "OFF", enabled: false, section: "system-presets" },
    ] });
    expect(result.receipt.userPromptIds).toEqual(["style"]);
    expect(result.receipt.omittedUserPromptIds).toEqual(["prefill", "off"]);
    expect(result.instructions).toContain("restrained Player");
    expect(result.instructions).not.toContain("I narrate");
  });

  it("fails explicitly instead of clipping oversized instruction contracts", () => {
    const world = createMockWorld({ entries: [entry("oversize", { content: "x".repeat(9001) })] });
    expect(() => actorContext.assembleActorContext({ actor: "voice", world, state: createMockGameState() })).toThrow(/9000/);
  });

  it("uses the world's recent-message scan depth without importing older keyword evidence", () => {
    const world = createMockWorld({ settings: { maxTokens: 1000, temperature: 1, lorebookScanDepth: 1 }, entries: [entry("old-keyword", { alwaysSend: false, keywords: ["stairs"] }), entry("recent-keyword", { alwaysSend: false, keywords: ["door"] })] });
    const result = actorContext.assembleActorContext({ actor: "voice", world, state: createMockGameState(), recentMessages: [{ role: "user", content: "stairs" }, { role: "assistant", content: "door" }] });
    expect(result.receipt.entryIds).toEqual(["recent-keyword"]);
  });

  it("bounds diagnostic identifier lengths as well as list counts", () => {
    const world = createMockWorld({ entries: Array.from({ length: 250 }, (_, i) => entry(`${i}-${"x".repeat(1000)}`, { enabled: false })) });
    const result = actorContext.assembleActorContext({ actor: "voice", world, state: createMockGameState() });
    expect(result.receipt.omittedEntryCount).toBe(250);
    expect(result.receipt.omittedEntryIds).toHaveLength(200);
    expect(result.receipt.omittedEntryIds.every(id => id.length <= 128)).toBe(true);
    expect(JSON.stringify(result.receipt).length).toBeLessThan(65000);
    expect(result.receipt.receiptTruncated).toBe(true);
  });
});
