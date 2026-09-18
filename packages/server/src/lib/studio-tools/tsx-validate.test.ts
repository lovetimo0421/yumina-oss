import test from "node:test";
import assert from "node:assert/strict";
import { validateTsx, formatTsxIssue, buildSnippet } from "./tsx-validate.js";

test("validateTsx: clean TSX returns no issues", () => {
  const code = `function MyWorld() {\n  return <div>hi</div>;\n}\nexport default MyWorld;`;
  assert.deepEqual(validateTsx(code), []);
});

test("validateTsx: empty/whitespace is not a syntax error", () => {
  assert.deepEqual(validateTsx(""), []);
  assert.deepEqual(validateTsx("   \n  "), []);
});

test("validateTsx: unclosed brace reports a line + snippet", () => {
  // MyWorld's return is never closed (the reported 4532-line failure class, minified).
  const lines = Array.from({ length: 30 }, (_, i) => `  const x${i} = ${i};`);
  const code = `function MyWorld() {\n${lines.join("\n")}\n  return (\n    <div>\n      {x1}\n  ); // missing closing brace for MyWorld\n`;
  const issues = validateTsx(code);
  assert.equal(issues.length, 1);
  assert.ok(issues[0]!.line > 0, "should have a line number");
  assert.ok(issues[0]!.snippet.includes("|"), "snippet should be a numbered code window");
  assert.ok(issues[0]!.snippet.includes(">"), "snippet should mark the error line");
});

test("buildSnippet: an error reported past EOF still yields a window (clamps to last line)", () => {
  const code = "line1\nline2\nline3";
  const snippet = buildSnippet(code, 99, 0); // line beyond EOF (unclosed-bracket-at-EOF case)
  assert.ok(snippet.length > 0, "must not be empty");
  assert.ok(snippet.includes("line3"), "should window the last real line");
  assert.ok(snippet.includes(">"), "should mark a focus line");
});

test("formatTsxIssue: includes the head and the snippet", () => {
  const issues = validateTsx(`const a = (;`);
  assert.equal(issues.length, 1);
  const formatted = formatTsxIssue(issues[0]!);
  assert.ok(formatted.startsWith("syntax error at line"));
});
