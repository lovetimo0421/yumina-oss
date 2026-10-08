import test from "node:test";
import assert from "node:assert/strict";
import { appendVariableAudit, buildVariableAudit } from "./variable-audit.js";
import type { ChangeTrace } from "./change-trace.js";

const fixture = () => ({
  path: "send" as const, state: { variables: { aff: 2, location: "town", confessed: true }, turnCount: 2 },
  changes: [
    { variableId: "aff", oldValue: 0, newValue: 3 },
    { variableId: "location", oldValue: "road", newValue: "town" },
    { variableId: "aff", oldValue: 3, newValue: 2 },
  ],
  trace: {
    version: 1, sources: [{ kind: "judge" }, { kind: "ai", via: "repair" }, { kind: "rule", ids: ["reset"] }],
    dropped: [], rejected: [], aiWrote: ["location"],
    judge: [
      { variableId: "aff", chosen: 3, confidence: 0.9, applied: true },
      { variableId: "confessed", chosen: false, confidence: 0.99, applied: true },
    ], asked: [{ key: "var__confessed", kind: "boolean", question: "Has a confession ever been accepted?",
      options: [], chosen: false, confidence: 0.99, applied: true }],
  } as ChangeTrace,
  continuity: { ran: true, audit: { status: "completed" as const, model: "judge" } },
  repair: { ran: true, flagged: { location: 0.95 }, effects: [{ variableId: "location", operation: "set" as const, value: "town" }],
    audit: { status: "repaired" as const, checked: { location: 0.95, aff: 0.1 } } },
  blocked: [{ variableId: "confessed", reason: "once-true", attemptedValue: false, phase: "ai" as const }],
  at: "2026-10-08T21:00:00.000Z",
});

test("durable evidence distinguishes judgement, repair, later rule overwrite and committed value", () => {
  const args = fixture();
  const audit = buildVariableAudit(args);
  assert.deepEqual(audit.changes.map(c => c.source), args.trace.sources);
  assert.equal(audit.changes[0]!.newValue.value, 3);
  assert.equal(audit.changes[2]!.oldValue.value, 3);
  assert.equal(audit.committed.find(c => c.variableId === "aff")!.value.value, 2);
  assert.deepEqual(audit.repair.applied, ["location"]);
  assert.equal(audit.judge.decisions[1]!.proposed, true);
  assert.equal(audit.judge.decisions[1]!.applied, false, "blocked proposal is not a successful update");
  assert.equal(audit.judge.asked[0]!.proposed, true);
  assert.equal(audit.judge.asked[0]!.applied, false, "question evidence must agree with the actual decision outcome");
  assert.deepEqual(audit.blocked[0]!.attemptedValue, { value: false });
  args.trace.sources[0]!.kind = "rule";
  assert.equal(audit.changes[0]!.source!.kind, "judge", "saved evidence must not retain mutable references");
});

test("continuation keeps segment history; regeneration starts a separate record", () => {
  const send = appendVariableAudit(undefined, buildVariableAudit(fixture()));
  const continued = appendVariableAudit(send, buildVariableAudit({ ...fixture(), path: "continue" }));
  const regen = appendVariableAudit(undefined, buildVariableAudit({ ...fixture(), path: "regenerate" }));
  assert.deepEqual(continued.segments.map(s => s.path), ["send", "continue"]);
  assert.deepEqual(regen.segments.map(s => s.path), ["regenerate"]);
  assert.equal(send.segments.length, 1);
  let many = send;
  for (let i = 0; i < 20; i++) many = appendVariableAudit(many, buildVariableAudit({ ...fixture(), path: "continue" }));
  assert.equal(many.segments.length, 8);
  assert.equal(many.omittedSegments, 13);
});

test("large variable values are bounded, omissions explicit, and negative decisions retained", () => {
  const args = fixture();
  const huge = { history: "长".repeat(1_000_000) };
  const changes = Array.from({ length: 256 }, (_, i) => ({ variableId: String(i), oldValue: huge, newValue: huge }));
  const audit = buildVariableAudit({ ...args, changes, trace: { ...args.trace, sources: changes.map(() => ({ kind: "ai" })) } });
  assert.ok(Buffer.byteLength(JSON.stringify(audit)) <= 64 * 1024);
  assert.ok(audit.omitted.changes > 0);
  assert.equal(audit.changes[0]!.oldValue.truncated, true);
  assert.equal(audit.repair.audit!.checked.aff, 0.1);
});
