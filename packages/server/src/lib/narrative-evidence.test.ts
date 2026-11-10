import assert from "node:assert/strict";
import { test } from "node:test";
import { stripNarrativeReasoning } from "./narrative-evidence.js";

for (const tag of ["think", "thinking", "reasoning", "thought", "reflect"]) {
  test(`remove closed and unfinished ${tag} blocks without erasing fictional identities`, () => {
    const fact = "Nova is explicitly a fictional AI. The human player met Nova.";
    assert.equal(stripNarrativeReasoning(`<${tag}>The player might be a chatbot.</${tag}>${fact}`), fact);
    assert.equal(stripNarrativeReasoning(`${fact}<${tag}>Unfinished speculation`), fact);
    assert.equal(stripNarrativeReasoning(`<${tag}>Only private reasoning`), "");
    assert.equal(stripNarrativeReasoning(fact), fact);
  });
}
