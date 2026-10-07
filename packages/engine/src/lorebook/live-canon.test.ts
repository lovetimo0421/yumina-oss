import { expect, test } from "vitest";
import type { WorldDefinition } from "../types/index.js";
import { variableSchema, worldEntrySchema } from "../world/schema.js";
import { resolveLiveCanonOverlay } from "./live-canon.js";

function world(): WorldDefinition {
  return {
    id: "world",
    name: "World",
    description: "",
    author: "",
    version: "21.0.0",
    settings: {},
    variables: [],
    rules: [],
    reactions: [],
    components: [],
    customUI: [],
    audioTracks: [],
    entries: [
      {
        id: "editable",
        name: "Faction",
        content: "Old canon",
        role: "lore",
        apiRole: "system",
        alwaysSend: true,
        keywords: [],
        conditions: [],
        conditionLogic: "all",
        enabled: true,
        position: 2,
        section: "system-presets",
        sessionEditPolicy: "content",
      },
      {
        id: "locked",
        name: "Secret",
        content: "Author canon",
        role: "lore",
        alwaysSend: true,
        keywords: [],
        conditions: [],
        conditionLogic: "all",
        enabled: true,
        position: 3,
        section: "system-presets",
      },
      {
        id: "system-entry",
        name: "System instructions",
        content: "Author instructions",
        role: "system",
        alwaysSend: true,
        keywords: [],
        conditions: [],
        conditionLogic: "all",
        enabled: true,
        position: 4,
        section: "system-presets",
        sessionEditPolicy: "content",
      },
    ],
  };
}

test("Lore Shift replaces only approved content and never mutates the source", () => {
  const source = world();
  const resolved = resolveLiveCanonOverlay(source, {
    basePatches: [
      { baseEntryId: "editable", content: "Session canon" },
      { baseEntryId: "locked", content: "Bypass attempt" },
      { baseEntryId: "system-entry", content: "Authority bypass attempt" },
    ],
    createdEntries: [],
  });

  expect(source.entries[0]?.content).toBe("Old canon");
  expect(resolved.entries[0]?.content).toBe("Session canon");
  expect(resolved.entries[0]?.apiRole).toBe("user");
  expect(resolved.entries[1]?.content).toBe("Author canon");
  expect(resolved.entries[2]?.content).toBe("Author instructions");
});

test("session-created lore is normalized to lower-trust post-history content", () => {
  const resolved = resolveLiveCanonOverlay(world(), {
    basePatches: [],
    createdEntries: [{
      id: "row-id",
      name: "Treaty",
      content: "A treaty now exists.",
      enabled: true,
      alwaysSend: false,
      keywords: ["treaty"],
      matchWholeWords: true,
    }],
  });
  const entry = resolved.entries.at(-1)!;

  expect(entry.id).toBe("live-canon:row-id");
  expect(entry.apiRole).toBe("user");
  expect(entry.section).toBe("post-history");
  expect(entry.preventRecursion).toBe(true);
  expect(entry.worldbookId).toBeUndefined();
});

test("legacy worlds fail closed while explicit author permissions survive parsing", () => {
  const lockedVariable = variableSchema.parse({
    id: "age",
    name: "Age",
    type: "number",
    defaultValue: 18,
  });
  const editableVariable = variableSchema.parse({
    id: "age",
    name: "Age",
    type: "number",
    defaultValue: 18,
    liveCanonEditable: true,
  });
  const lockedEntry = worldEntrySchema.parse({
    id: "history",
    name: "History",
    content: "Canon",
    role: "lore",
    section: "system-presets",
  });
  const editableEntry = worldEntrySchema.parse({
    id: "history",
    name: "History",
    content: "Canon",
    role: "lore",
    section: "system-presets",
    sessionEditPolicy: "content",
  });

  expect(lockedVariable.liveCanonEditable).toBe(false);
  expect(editableVariable.liveCanonEditable).toBe(true);
  expect(lockedEntry.sessionEditPolicy).toBe("locked");
  expect(editableEntry.sessionEditPolicy).toBe("content");
});
