import test from "node:test";
import assert from "node:assert/strict";
import { sliceSource } from "./source-slice";

/** The slicer reads real card code, which is written by AI and by strangers.
 *  Every case below is a shape that would make a naive angle-bracket counter
 *  run to the end of the file — and a slice that runs away is a slice that
 *  hands the agent someone else's component to edit. */

const SOURCE = [
  /* 1 */ 'import React from "react";',
  /* 2 */ "",
  /* 3 */ "export default function HudCard() {",
  /* 4 */ "  const ratio = hp < max ? hp / max : 1;",
  /* 5 */ "  return (",
  /* 6 */ '    <div className="root">',
  /* 7 */ '      <div className="hp-bar">',
  /* 8 */ '        <span className="label">HP</span>',
  /* 9 */ '        <i style={{ width: `${ratio * 100}%` }} />',
  /* 10 */ "      </div>",
  /* 11 */ "    </div>",
  /* 12 */ "  );",
  /* 13 */ "}",
].join("\n");

test("a nested element slices to its own closing tag, not the parent's", () => {
  const slice = sliceSource(SOURCE, "index.tsx", 7);
  assert.equal(slice.startLine, 7);
  assert.equal(slice.endLine, 10);
  assert.equal(slice.truncated, false);
  assert.match(slice.text, /^ {6}<div className="hp-bar">/);
  assert.match(slice.text, /<\/div>$/);
});

test("a one-line element is one line", () => {
  const slice = sliceSource(SOURCE, "index.tsx", 8);
  assert.equal(slice.startLine, 8);
  assert.equal(slice.endLine, 8);
});

test("a self-closing element terminates on its own line", () => {
  // Line 9 also contains a `<` inside a template literal — neutralization is
  // what keeps that from opening a phantom element.
  const slice = sliceSource(SOURCE, "index.tsx", 9);
  assert.equal(slice.endLine, 9);
});

test("`<` as less-than does not open an element", () => {
  const src = ["<div>", "  {a < b ? x : y}", "</div>"].join("\n");
  const slice = sliceSource(src, "a.tsx", 1);
  assert.equal(slice.endLine, 3);
});

test("angle brackets inside strings and comments are ignored", () => {
  const src = [
    "<div>",
    '  <p title="</div> not really">x</p>',
    "  {/* </div> */}",
    "</div>",
  ].join("\n");
  const slice = sliceSource(src, "a.tsx", 1);
  assert.equal(slice.endLine, 4);
});

test("the enclosing component is named, and locals are not mistaken for it", () => {
  assert.equal(sliceSource(SOURCE, "index.tsx", 8).component, "HudCard");
  // `ratio` sits between the JSX and the function — a lowercase binding is a
  // local, and reporting it would point the agent at nothing.
  assert.notEqual(sliceSource(SOURCE, "index.tsx", 8).component, "ratio");
});

test("an unclosed element is capped and says so instead of eating the file", () => {
  const src = ["<div>", ...Array.from({ length: 200 }, () => "  <span>")].join("\n");
  const slice = sliceSource(src, "a.tsx", 1);
  assert.equal(slice.truncated, true);
  assert.ok(slice.endLine - slice.startLine < 61);
});

test("a line past the end of the file resolves instead of throwing", () => {
  const slice = sliceSource(SOURCE, "index.tsx", 9999);
  assert.equal(slice.startLine, 13);
});
