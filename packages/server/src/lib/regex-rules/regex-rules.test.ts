import { test } from "node:test";
import assert from "node:assert/strict";
import { applyRegexRules, makeTextRule, parseSillyTavernRegex, regexRuleSchema, type RegexRule } from "@yumina/shared";

const regex = (find: string, extra: Partial<RegexRule> = {}): RegexRule => ({
  id: find, find, replace: "", isRegex: true, ai: true, user: false, display: true, prompt: true, enabled: true, ...extra,
});

test("a plain-text rule replaces the words literally, whatever they contain", () => {
  const rule = { ...makeTextRule("vanguard"), flags: "i" };
  assert.equal(applyRegexRules("The vanguard and the Vanguard.", [rule], { role: "assistant", where: "display" }), "The  and the .");
  const dollars = { ...makeTextRule("$5 (cheap)"), replace: "$&" };
  assert.equal(applyRegexRules("Only $5 (cheap).", [dollars], { role: "assistant", where: "display" }), "Only $&.");
});

test("a regex rule can capture, and {{match}} means the whole match as in SillyTavern", () => {
  const rule = regex("(\\w+)@(\\w+)", { replace: "$2 at $1" });
  assert.equal(applyRegexRules("mail kate@home", [rule], { role: "assistant", where: "prompt" }), "mail home at kate");
  const wrap = regex("Elara", { replace: "<b>{{match}}</b>" });
  assert.equal(applyRegexRules("Elara smiled", [wrap], { role: "assistant", where: "display" }), "<b>Elara</b> smiled");
});

test("rules apply only to the messages and places chosen", () => {
  const rules = [
    regex("x", { replace: "A", display: true, prompt: false }),
    regex("y", { replace: "B", ai: false, user: true }),
    regex("z", { replace: "C", minDepth: 2 }),
    regex("w", { replace: "D", enabled: false }),
  ];
  assert.equal(applyRegexRules("xyzw", rules, { role: "assistant", where: "display", depth: 0 }), "Ayzw");
  assert.equal(applyRegexRules("xyzw", rules, { role: "assistant", where: "prompt", depth: 3 }), "xyCw");
  assert.equal(applyRegexRules("xyzw", rules, { role: "user", where: "prompt", depth: 0 }), "xBzw");
  // A pattern that does not compile is skipped, never thrown.
  assert.equal(applyRegexRules("abc", [regex("(")], { role: "assistant", where: "display" }), "abc");
});

test("SillyTavern exports import: placement, display-only, prompt-only, depth and disabled", () => {
  const { rules, skipped } = parseSillyTavernRegex({
    regex: [
      { id: "a", scriptName: "Hide status", findRegex: "/<status>[\\s\\S]*?<\\/status>/gi", replaceString: "", placement: [2], promptOnly: true, minDepth: 2 },
      { scriptName: "Pretty", findRegex: "/\\*([^*]+)\\*/g", replaceString: "<i>$1</i>", placement: [1, 2], markdownOnly: true },
      { scriptName: "Off", findRegex: "foo", replaceString: "bar", placement: [2], disabled: true },
      { scriptName: "Broken", findRegex: "/(/g", placement: [2] },
    ],
  });
  assert.deepEqual(skipped, ["Broken"]);
  assert.equal(rules.length, 3);
  assert.deepEqual([rules[0]!.display, rules[0]!.prompt, rules[0]!.minDepth, rules[0]!.flags], [false, true, 2, "i"]);
  assert.deepEqual([rules[1]!.user, rules[1]!.ai, rules[1]!.display, rules[1]!.prompt], [true, true, true, false]);
  assert.equal(rules[2]!.enabled, false);
  for (const r of rules) assert.ok(regexRuleSchema.safeParse(r).success);
  assert.equal(applyRegexRules("hi <status>HP 3</status> there", rules, { role: "assistant", where: "prompt", depth: 5 }), "hi  there");
  assert.equal(applyRegexRules("hi <status>HP 3</status> there", rules, { role: "assistant", where: "prompt", depth: 0 }), "hi <status>HP 3</status> there");
});

test("history: rules rewrite what the AI is sent, and a runaway regex never stalls the server", async () => {
  process.env.DATABASE_URL ??= "postgres://unused";
  const runner = await import("./runner.js");
  const rows = [
    { id: "1", role: "user", content: "hello" },
    { id: "2", role: "assistant", content: "The vanguard rides. " + "a".repeat(40) + "!" },
  ];
  const { applyRegexRules: apply } = await import("@yumina/shared");
  // The worker uses the same engine; check its contract directly with a fast rule...
  assert.equal(apply(rows[1]!.content, [makeTextRule("vanguard ")], { role: "assistant", where: "prompt" }).startsWith("The rides."), true);
  // ...and that the time limit holds with a catastrophic one, through the real worker (warmed up first, as in
  // a running server: start-up has its own, longer allowance).
  assert.ok(await runner.applyRegexRulesInWorkerForTest(rows, [makeTextRule("zzz")]));
  // The limit that cut it off is read from the runner's warning, not a wall clock: on a loaded CI machine the
  // main thread's timer can fire late, which says nothing about which limit applied.
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  let out: string[] | null;
  try {
    out = await runner.applyRegexRulesInWorkerForTest(rows, [regex("(a+)+$")]);
  } finally {
    console.warn = warn;
  }
  assert.equal(out, null, "a runaway rule is abandoned");
  assert.ok(warnings.some((w) => w.includes("took over 400ms")), `the running worker's short limit applied: ${warnings.join(" | ")}`);
  const ok = await runner.applyRegexRulesInWorkerForTest(rows, [makeTextRule("vanguard ")]);
  assert.deepEqual(ok, ["hello", "The rides. " + "a".repeat(40) + "!"], "the next turn gets a fresh worker");
});
