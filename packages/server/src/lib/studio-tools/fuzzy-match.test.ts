import test from "node:test";
import assert from "node:assert/strict";
import { fuzzyFindUnique, nearestRegion, resolveUniqueMatch } from "./fuzzy-match.js";

const FILE = `function MyWorld() {
  const greeting = "hello world";
  return (
    <div className="root">
      {greeting}
    </div>
  );
}`;

test("fuzzyFindUnique: exact substring returns its span", () => {
  const span = fuzzyFindUnique(FILE, `const greeting = "hello world";`);
  assert.ok(span);
  assert.equal(FILE.slice(span!.start, span!.end), `const greeting = "hello world";`);
});

test("fuzzyFindUnique: tolerates indentation/whitespace drift", () => {
  // model reproduced the line with different leading whitespace + collapsed spaces
  const span = fuzzyFindUnique(FILE, `const   greeting =    "hello world";`);
  assert.ok(span, "should still match despite whitespace differences");
  assert.equal(FILE.slice(span!.start, span!.end), `const greeting = "hello world";`);
});

test("fuzzyFindUnique: returns null when not present", () => {
  assert.equal(fuzzyFindUnique(FILE, `const farewell = "goodbye cruel world";`), null);
});

test("fuzzyFindUnique: returns null on ambiguous (multiple) matches", () => {
  const dup = `a();\n  a();\n  a();`;
  // "a();" normalized appears 3x -> ambiguous (and also too short, so doubly null)
  assert.equal(fuzzyFindUnique(dup, `a();`), null);
});

test("fuzzyFindUnique: refuses very short needles", () => {
  assert.equal(fuzzyFindUnique(FILE, `div`), null);
});

test("nearestRegion: surfaces the closest current region as a numbered window", () => {
  const hint = nearestRegion(FILE, `const greeting = "HELLO";\nsomethingElse();`);
  assert.ok(hint);
  assert.ok(hint!.includes("greeting"), "should anchor on the greeting line");
  assert.ok(/\d+ \|/.test(hint!), "should be a numbered window");
});

// ── resolveUniqueMatch (opencode-style replacer cascade) ──

test("resolveUniqueMatch: exact unique match returns its span", () => {
  const m = resolveUniqueMatch(FILE, `const greeting = "hello world";`);
  assert.equal(m.ok, true);
  if (m.ok) assert.equal(FILE.slice(m.span.start, m.span.end), `const greeting = "hello world";`);
});

test("resolveUniqueMatch: indentation-flexible multi-line block (model dropped indent)", () => {
  const src = [
    "function f() {",
    "        if (ready) {",
    "                doThing();",
    "        }",
    "}",
  ].join("\n");
  // model reproduced the block with shallow 2-space indent
  const find = ["if (ready) {", "  doThing();", "}"].join("\n");
  const m = resolveUniqueMatch(src, find);
  assert.equal(m.ok, true);
  if (m.ok) {
    const matched = src.slice(m.span.start, m.span.end);
    assert.ok(matched.includes("doThing();"));
    assert.ok(matched.startsWith("        if (ready) {"), "maps back to the real indented text");
  }
});

test("resolveUniqueMatch: block-anchor tolerates a near-miss middle line", () => {
  const src = [
    "<Panel>",
    "  <Row a={1} />",
    "  <Row b={2} />",
    "  <Row c={3} />",
    "</Panel>",
  ].join("\n");
  // middle line slightly wrong, anchors (first/last) exact
  const find = [
    "<Panel>",
    "  <Row a={1} />",
    "  <Row b={999} />",
    "  <Row c={3} />",
    "</Panel>",
  ].join("\n");
  const m = resolveUniqueMatch(src, find);
  assert.equal(m.ok, true);
  if (m.ok) assert.equal(src.slice(m.span.start, m.span.end), src);
});

test("resolveUniqueMatch: whitespace-normalized single line (collapsed runs)", () => {
  const src = `const   x   =   5;`;
  const m = resolveUniqueMatch(src, `const x = 5;`);
  assert.equal(m.ok, true);
  if (m.ok) assert.equal(src.slice(m.span.start, m.span.end), `const   x   =   5;`);
});

test("resolveUniqueMatch: escape-normalized (model emitted literal \\n)", () => {
  const src = `a();\nb();`;
  const m = resolveUniqueMatch(src, `a();\\nb();`);
  assert.equal(m.ok, true);
  if (m.ok) assert.equal(src.slice(m.span.start, m.span.end), `a();\nb();`);
});

test("resolveUniqueMatch: not-found", () => {
  const m = resolveUniqueMatch(FILE, `const farewell = "totally absent line";`);
  assert.equal(m.ok, false);
  if (!m.ok) assert.equal(m.reason, "not-found");
});

test("resolveUniqueMatch: ambiguous when the block appears twice", () => {
  const src = `doThing(1);\ndoThing(1);`;
  const m = resolveUniqueMatch(src, `doThing(1);`);
  assert.equal(m.ok, false);
  if (!m.ok) assert.equal(m.reason, "ambiguous");
});

test("resolveUniqueMatch: replacement preserves the following line break", () => {
  const src = [
    "const a = 1;",
    "const b = 2;",
    "const c = 3;",
  ].join("\n");
  // match the middle line with indentation drift via line-trimmed path
  const m = resolveUniqueMatch(src, `const b = 2;`);
  assert.equal(m.ok, true);
  if (m.ok) {
    const replaced = src.slice(0, m.span.start) + "const b = 20;" + src.slice(m.span.end);
    assert.equal(replaced, "const a = 1;\nconst b = 20;\nconst c = 3;");
  }
});
