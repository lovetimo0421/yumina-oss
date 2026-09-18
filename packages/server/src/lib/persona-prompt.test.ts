import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appendPersonaSystemMessage,
  buildPersonaSystemMessage,
  type PersonaPromptMessage,
} from "./persona-prompt.js";

describe("buildPersonaSystemMessage", () => {
  it("explicitly binds a name-only persona as the user's spoken name", () => {
    const prompt = buildPersonaSystemMessage({ name: "Alex" });

    assert.equal(
      prompt,
      [
        "[User Persona]",
        "User's roleplay name: Alex",
      ].join("\n"),
    );
  });

  it("does not require descriptive persona fields before injecting the name", () => {
    const prompt = buildPersonaSystemMessage({ name: "Alex" });

    assert.ok(prompt?.includes("User's roleplay name: Alex"));
    assert.doesNotMatch(prompt ?? "", /use this exact name/i);
    assert.doesNotMatch(prompt ?? "", /Appearance:/);
  });

  it("includes optional persona details after the name binding", () => {
    const prompt = buildPersonaSystemMessage({
      name: "Alex",
      appearance: "silver hair",
      personality: "reserved",
      backstory: "from the old city",
    });

    assert.match(prompt ?? "", /^\[User Persona\]/);
    assert.ok(prompt?.includes("User's roleplay name: Alex"));
    assert.ok(prompt?.includes("Appearance: silver hair"));
    assert.ok(prompt?.includes("Personality: reserved"));
    assert.ok(prompt?.includes("Backstory: from the old city"));
  });

  it("adds nothing at all to the outgoing prompt when personas are disabled", () => {
    const messages: PersonaPromptMessage[] = [
      { role: "system", content: "World rules only." },
      { role: "user", content: "Continue the story." },
    ];

    appendPersonaSystemMessage(messages, null);

    assert.deepEqual(messages, [
      { role: "system", content: "World rules only." },
      { role: "user", content: "Continue the story." },
    ]);
    assert.doesNotMatch(messages.map((message) => message.content).join("\n"), /persona/i);
  });
});
