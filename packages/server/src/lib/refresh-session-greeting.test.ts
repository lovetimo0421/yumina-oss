import "../test/database-fixture.js";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { PromptBuilder } from "@yumina/engine";
import type { WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import { messages, playSessions, user, userPersonas, worlds } from "../db/schema.js";
import { applyPersonaMetadataToState } from "./persona-metadata.js";
import { refreshSessionGreeting } from "./refresh-session-greeting.js";

after(async () => { await (db as unknown as { $client: { close(): Promise<void> } }).$client.close(); });

test("opening refresh preserves authored history and each scenario swipe", async t => {
  for (const mode of ["multiple", "manual-content", "manual-swipe", "played", "disabled-persona", "preset-variable", "wrong-owner"] as const) {
    await t.test(mode, async () => {
      const userId = randomUUID();
      await db.insert(user).values({ id: userId, name: "Account", email: `${userId}@example.test` });
      try {
        if (mode !== "disabled-persona") await db.insert(userPersonas).values({ userId, name: "New", backstory: "New facts", isActive: true });
        const worldDef = { id: randomUUID(), name: "Opening", entries: [0, 1].map(index => ({ id: `g${index}`, role: "greeting", enabled: true, position: index,
          content: `Opening ${index}: {{user}} {{persona_backstory}}${mode === "preset-variable" ? " {{hp}}" : ""}`, initialVariables: { hp: 20 + index } })),
          variables: [{ id: "hp", name: "hp", type: "number", defaultValue: 10 }], rules: [], components: [], settings: {} } as unknown as WorldDefinition;
        const [world] = await db.insert(worlds).values({ creatorId: userId, name: "Opening", schema: worldDef as unknown as Record<string, unknown> }).returning();
        const baseState = { worldId: world!.id, variables: { hp: 10 }, turnCount: 0, metadata: {} };
        applyPersonaMetadataToState(baseState, { name: "Old", backstory: "Old facts" }, { name: "Account" });
        const rendered = new PromptBuilder().buildGreetings(worldDef, baseState);
        const swipes = rendered.map((content, index) => ({ content, createdAt: new Date().toISOString(), stateSnapshot: { ...structuredClone(baseState), activeGreetingId: `g${index}`, variables: { hp: 20 + index } } }));
        if (mode === "manual-swipe") swipes[0]!.content = "My manually edited inactive opening";
        const [session] = await db.insert(playSessions).values({ userId, worldId: world!.id, state: swipes[1]!.stateSnapshot }).returning();
        const [opening] = await db.insert(messages).values({ sessionId: session!.id, role: "assistant", content: mode === "manual-content" ? "My custom text" : swipes[1]!.content,
          swipes, activeSwipeIndex: 1, stateSnapshot: swipes[1]!.stateSnapshot }).returning();
        if (mode === "played") await db.insert(messages).values({ sessionId: session!.id, role: "user", content: "Continue" });
        const result = await refreshSessionGreeting(session!.id, mode === "wrong-owner" ? "other-user" : userId, worldDef);
        const [saved] = await db.select().from(messages).where(eq(messages.id, opening!.id));
        if (["manual-content", "played", "wrong-owner"].includes(mode)) {
          assert.equal(result, null);
          assert.equal(saved!.content, opening!.content);
          assert.deepEqual(saved!.swipes, opening!.swipes);
          return;
        }
        assert.ok(result, "an untouched opening must refresh");
        assert.equal(saved!.activeSwipeIndex, 1);
        assert.ok(!saved!.content.includes("Old"), "old identity must not survive in the active opening");
        assert.ok(saved!.content.includes(mode === "disabled-persona" ? "Account" : "New"));
        assert.deepEqual((saved!.stateSnapshot as { variables: unknown }).variables, { hp: 21 });
        assert.deepEqual((saved!.swipes![0]!.stateSnapshot as { variables: unknown }).variables, { hp: 20 });
        if (mode === "manual-swipe") assert.equal(saved!.swipes![0]!.content, swipes[0]!.content);
        else assert.ok(!saved!.swipes![0]!.content.includes("Old"));
      } finally { await db.delete(user).where(eq(user.id, userId)); }
    });
  }
});
