import test from "node:test";
import assert from "node:assert/strict";
import type { RootComponent, UiDoc } from "@yumina/engine";
import {
  REPLACED_FILE,
  checkPlayability,
  classifyInterface,
  setAsideHandwritten,
  startingUiDoc,
  takeoverNeedsConfirmation,
} from "./ui-doc-takeover.js";

const rc = (files: Record<string, string>, over: Partial<RootComponent> = {}): RootComponent => ({
  id: "rc",
  name: "Interface",
  entryFile: "index.tsx",
  files,
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const withElements = (
  elements: UiDoc["pages"][number]["elements"],
  theme?: UiDoc["theme"],
): UiDoc => ({
  version: 1,
  entryPageId: "p1",
  pages: [{ id: "p1", name: "Main", height: 812, elements }],
  theme,
});

test("a card with no rootComponent is unowned", () => {
  assert.equal(classifyInterface(undefined), "none");
});

test("the scaffolding 96 cards carry is a shell, not somebody's work", () => {
  // Median stored shell is 56 characters. Asking these creators to confirm an
  // irreversible replacement of nothing teaches them to click through the
  // dialog that actually matters.
  assert.equal(classifyInterface(rc({ "index.tsx": "export default function App() { return null; }" })), "shell");
  assert.equal(takeoverNeedsConfirmation(rc({ "index.tsx": "export default () => null;" })), false);
});

test("a real frontend is hand-written, and the takeover is gated on it", () => {
  const handwritten = rc({ "index.tsx": `// a real card\n${"const x = 1;\n".repeat(200)}` });
  assert.equal(classifyInterface(handwritten), "handwritten");
  assert.equal(takeoverNeedsConfirmation(handwritten), true);
});

test("whitespace does not count toward being a real frontend", () => {
  assert.equal(classifyInterface(rc({ "index.tsx": " ".repeat(5000) })), "shell");
});

test("a small frontend that actually renders is not a shell", () => {
  // Found by auditing the library: one stored card reads variables and draws
  // with them in 182 characters. Size alone would have overwritten it with no
  // confirmation, and there is no getting it back.
  const tiny = rc({
    "index.tsx": 'export default function App({ api }) { return <div>{api.variables.hp}</div>; }',
  });
  assert.equal(classifyInterface(tiny), "handwritten");
  assert.equal(takeoverNeedsConfirmation(tiny), true);
});

test("each rendering signal on its own is enough", () => {
  const signals = [
    "items.map(x => x)",
    "<img src={u} />",
    "onClick={go}",
    "api.setVariable('a', 1)",
    "api.sendMessage('hi')",
    "React.useState(0)",
  ];
  for (const signal of signals) {
    assert.equal(classifyInterface(rc({ "index.tsx": signal })), "handwritten", signal);
  }
});

test("the compiler regenerates its own output without asking", () => {
  const generated = rc({ "index.tsx": "x".repeat(50000) }, { generatedFrom: "uiDoc" });
  assert.equal(classifyInterface(generated), "generated");
  assert.equal(takeoverNeedsConfirmation(generated), false);
});

test("a replaced frontend is kept, not deleted", () => {
  const files = setAsideHandwritten(rc({ "index.tsx": "REAL CODE", "helper.tsx": "HELPER" }));
  assert.equal(files[REPLACED_FILE], "REAL CODE");
  assert.equal(files["index.tsx"], undefined);
  // Siblings stay: the backup still references them, and moving them is what
  // would actually lose the code.
  assert.equal(files["helper.tsx"], "HELPER");
});

test("setting aside is a no-op when there was no entry source to keep", () => {
  assert.deepEqual(setAsideHandwritten(rc({ "other.tsx": "X" })), { "other.tsx": "X" });
});

test("a second takeover never eats the first backup", () => {
  // The path that would: convert a hand-written card, export it back to code,
  // convert again. The second pass sets the GENERATED file aside, and writing
  // it to the same name would destroy the original author's code — the one
  // thing this whole gate exists to keep.
  const first = setAsideHandwritten(rc({ "index.tsx": "THE AUTHOR'S CODE" }));
  assert.equal(first[REPLACED_FILE], "THE AUTHOR'S CODE");

  const second = setAsideHandwritten(rc({ ...first, "index.tsx": "GENERATED" }));
  assert.equal(second[REPLACED_FILE], "THE AUTHOR'S CODE");
  assert.equal(second["_replaced-by-interface-2.tsx.bak"], "GENERATED");

  const third = setAsideHandwritten(rc({ ...second, "index.tsx": "GENERATED AGAIN" }));
  assert.equal(third[REPLACED_FILE], "THE AUTHOR'S CODE");
  assert.equal(third["_replaced-by-interface-3.tsx.bak"], "GENERATED AGAIN");
});

test("a new document starts playable — the story already has somewhere to appear", () => {
  const doc = startingUiDoc();
  const types = doc.pages[0]!.elements.map((e) => e.type);
  assert.ok(types.includes("messages"));
  assert.ok(types.includes("composer"));
  assert.deepEqual(checkPlayability(doc), []);
});

test("a card nobody can type into or read is flagged", () => {
  const codes = checkPlayability(withElements([])).map((w) => w.code);
  assert.ok(codes.includes("no-input"));
  assert.ok(codes.includes("no-transcript"));
});

test("the one-block chat counts as both halves", () => {
  assert.deepEqual(
    checkPlayability(withElements([{ id: "c", type: "chat", x: 0, y: 0, w: 375, h: 700 }])),
    [],
  );
});

test("a composer too short to type in is flagged", () => {
  const warnings = checkPlayability(
    withElements([
      { id: "m", type: "messages", x: 0, y: 0, w: 375, h: 700 },
      { id: "c", type: "composer", x: 0, y: 780, w: 375, h: 12 },
    ]),
  );
  assert.deepEqual(warnings, [{ code: "input-too-small", elementId: "c" }]);
});

test("free CSS that takes the composer out of play is flagged", () => {
  const hidden = checkPlayability(
    withElements(
      [
        { id: "m", type: "messages", x: 0, y: 0, w: 375, h: 700 },
        { id: "c", type: "composer", x: 0, y: 716, w: 375, h: 90 },
      ],
      { css: ".play-composer-card { display: none; }" },
    ),
  );
  assert.ok(hidden.map((w) => w.code).includes("input-hidden"));
});

test("opacity: 0.5 is not read as opacity: 0", () => {
  const warnings = checkPlayability(
    withElements(
      [
        { id: "m", type: "messages", x: 0, y: 0, w: 375, h: 700 },
        { id: "c", type: "composer", x: 0, y: 716, w: 375, h: 90 },
      ],
      { css: ".play-composer-card { opacity: 0.5; }" },
    ),
  );
  assert.deepEqual(warnings, []);
});

test("a deliberately button-driven card stays savable, with a warning", () => {
  // Never a block: refusing to save this would be the tool overruling the
  // creator about their own design.
  const warnings = checkPlayability(
    withElements([
      { id: "m", type: "messages", x: 0, y: 0, w: 375, h: 700 },
      { id: "b", type: "button", x: 0, y: 720, w: 100, h: 40, label: { template: "继续" }, actions: [] },
    ]),
  );
  assert.deepEqual(
    warnings.map((w) => w.code),
    ["no-input"],
  );
});
