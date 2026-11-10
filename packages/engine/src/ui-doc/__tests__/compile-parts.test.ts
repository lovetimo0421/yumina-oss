import { describe, it, expect } from "vitest";
import { compileUiDoc } from "../compile.js";
import { validateUiDoc } from "../schema.js";
import { addElement, newElement, removePage } from "../edit.js";
import { uiDocVariableRefs } from "../variable-refs.js";
import type { UiDoc, UiElement } from "../types.js";

const doc = (elements: UiElement[]): UiDoc => ({
  version: 1,
  entryPageId: "p1",
  pages: [
    { id: "p1", name: "Main", height: 812, elements },
    { id: "p2", name: "Two", height: 812, elements: [] },
  ],
});
const src = (elements: UiElement[]) => compileUiDoc(doc(elements)).files["index.tsx"]!;
const box = { x: 18, y: 100, w: 339, h: 300 };

const choice = (over: Partial<Extract<UiElement, { type: "choice" }>> = {}): UiElement => ({
  id: "pick", type: "choice", ...box, layout: "grid", columns: 2, variableId: "opening",
  options: [
    { id: "a", title: "Dawn", subtitle: "Quiet start", tags: ["calm"], actions: [
      { kind: "switch-greeting", index: 1 },
      { kind: "set-variable", variableId: "hero", op: "set", value: "{{choice}}" },
      { kind: "go-page", pageId: "p2" },
    ] },
    { id: "b", title: "Storm", value: "storm", image: { kind: "asset", ref: "@asset:storm" } },
  ],
  ...over,
});

describe("parts compile", () => {
  it("leaves a card without parts exactly as it was — no parts runtime, no parts CSS", () => {
    const out = src([{ id: "t", type: "text", x: 0, y: 0, w: 10, h: 10, text: { template: "hi" } }]);
    expect(out).not.toContain("function UiChoice");
    expect(out).not.toContain(".yp-card");
  });

  it("compiles a choice to the parts component with its cards as data and its steps as code", () => {
    const out = src([choice()]);
    expect(out).toContain("function UiChoice(props)");
    expect(out).toContain("<UiChoice");
    expect(out).toContain('elId={"pick"}');
    expect(out).toContain('layout={"grid"}');
    expect(out).toContain('variableId={"opening"}');
    expect(out).toContain('title: "Dawn"');
    expect(out).toContain('image: api.resolveAssetUrl("@asset:storm")');
    // Theme-derived defaults ship with the card.
    expect(out).toContain("--yp-accent:var(--yc-send-bg");
    expect(out).toContain(".yp-card[aria-pressed=\\\"true\\\"]");
    // A pick's steps always wait for the opening switch, even as the last step,
    // because the part writes its variable again after them.
    expect(out).toMatch(/async function \(vars, choice\) \{\n\s+await settle\(api\.switchGreeting && api\.switchGreeting\(1\), 600, 15000\);/);
    // {{choice}} in a set value reads the pick.
    expect(out).toContain('vars["hero"] = interpolate(vars, bindText("{{choice}}", "choice", choice))');
    expect(out).toContain('go("p2");');
    expect(out).toContain("sw: true");
    // An option with no steps runs nothing.
    expect(out).toMatch(/id: "b", title: "Storm", value: "storm", image: [^\n]+, run: null \}/);
  });

  it("multi pick with a cap and a confirm button", () => {
    const out = src([choice({ multi: true, maxPick: 2, confirm: { label: { template: "Start" }, actions: [{ kind: "toast", text: { template: "you took {{choice}}" } }] } })]);
    expect(out).toContain("multi={true}");
    expect(out).toContain("maxPick={2}");
    expect(out).toContain('confirm={{ label: interpolate(vars, "Start")');
    expect(out).toContain('api.showToast(interpolate(vars, bindText("you took {{choice}}", "choice", choice)))');
    // Multi writes an array: the runtime passes the whole pick list.
    expect(out).toContain("api.setVariable(variableId, multi ? next : next.length ? next[0] : \"\")");
  });

  it("a carousel and a list layout", () => {
    expect(src([choice({ layout: "carousel" })])).toContain('layout={"carousel"}');
    const list = src([choice({ layout: "list" })]);
    expect(list).toContain('layout={"list"}');
    expect(list).toContain("imageRatio={1}");
  });

  it("compiles each field kind with its label, bounds and theme-styled input", () => {
    const out = src([
      { id: "f1", type: "field", x: 0, y: 0, w: 300, h: 74, kind: "text", variableId: "name", label: { template: "Name?" }, placeholder: "Rin" },
      { id: "f2", type: "field", x: 0, y: 80, w: 300, h: 74, kind: "slider", variableId: "courage", min: 0, max: 10, step: 1 },
      { id: "f3", type: "field", x: 0, y: 160, w: 300, h: 74, kind: "chips", variableId: "cls", options: ["Knight", "Mage", ""], allowCustom: true },
    ]);
    expect(out).toContain("function UiField(props)");
    expect(out).toContain('kind={"text"}');
    expect(out).toContain('label={interpolate(vars, "Name?")}');
    expect(out).toContain('placeholder={"Rin"}');
    expect(out).toContain('kind={"slider"}');
    expect(out).toMatch(/min=\{0\}\s+max=\{10\}\s+step=\{1\}/);
    expect(out).toContain('options={["Knight","Mage"]}');
    expect(out).toContain("allowCustom={true}");
    expect(out).toContain("htmlFor=");
    expect(out).toContain(".yp-input:focus");
  });

  it("compiles a popup that clears its variable on close unless told not to", () => {
    const pop = (clearOnClose?: boolean): UiElement => ({
      id: "pop", type: "popup", x: 40, y: 200, w: 300, h: 260, z: 3, variableId: "clue",
      title: { template: "Found: {{value.name}}" }, body: { template: "{{value}}" }, buttonLabel: { template: "OK" },
      ...(clearOnClose === undefined ? {} : { clearOnClose }),
    });
    const out = src([pop()]);
    expect(out).toContain("function UiPopup(props)");
    expect(out).toContain("clearOnClose={true}");
    expect(out).toContain("z={1003}");
    expect(out).toContain('title={"Found: {{value.name}}"}');
    expect(out).toContain('role="dialog"');
    expect(out).toContain("@keyframes ypRise");
    expect(src([pop(false)])).toContain("clearOnClose={false}");
  });

  it("a button that requires variables is disabled and dimmed until they are filled", () => {
    const out = src([{ id: "go", type: "button", x: 0, y: 0, w: 100, h: 40, label: { template: "Start" }, actions: [], requires: ["name", "cls"] }]);
    expect(out).toContain('disabled={!hasAll(vars, ["name","cls"])}');
    expect(out).toContain('opacity: (hasAll(vars, ["name","cls"]) ? 1 : 0.4)');
    const hasAll = new Function(`${helper(out, "readVar")}\n${helper(out, "filled")}\n${helper(out, "hasAll")}\nreturn hasAll;`)() as (v: unknown, ids: string[]) => boolean;
    expect(hasAll({ name: "Rin", cls: "Mage" }, ["name", "cls"])).toBe(true);
    expect(hasAll({ name: "  ", cls: "Mage" }, ["name", "cls"])).toBe(false);
    expect(hasAll({ name: "Rin", cls: [] }, ["name", "cls"])).toBe(false);
    expect(hasAll({ name: "Rin", cls: null }, ["name", "cls"])).toBe(false);
    expect(hasAll({ n: 0 }, ["n"])).toBe(true);
    // Combined with a last-message step, both must hold.
    const both = src([{ id: "go", type: "button", x: 0, y: 0, w: 100, h: 40, label: { template: "Redo" }, actions: [{ kind: "regenerate" }], requires: ["name"] }]);
    expect(both).toContain('disabled={!(canActOnLast(api) && hasAll(vars, ["name"]))}');
  });

  it("a choice's cards-per-row reaches the part as set, and unset stays unset (auto)", () => {
    // The part reads `columns` straight through; 0 is "auto" — two on the
    // phone, as many as fit on the wide canvas. A set count used to be
    // overridden on the desktop (3 per row still drew 4).
    expect(src([choice({ columns: 3 })])).toContain("columns={3}");
    const { columns: _c, ...unset } = choice() as Extract<UiElement, { type: "choice" }>;
    expect(src([unset])).toContain("columns={0}");
    const runtime = src([choice()]);
    expect(runtime).toContain("const set = props.columns > 0 ? props.columns : 0;");
    expect(runtime).toMatch(/const cols = set \? set\s*: !grid \? 1\s*: props\.wide && width \? Math\.max\(2, Math\.min\(shown\.length, Math\.floor\(width \/ 170\)\)\)\s*: 2;/);
  });

  it("a list draws record rows as cards, locks rows, and runs row steps with {{item}}", () => {
    const out = src([{
      id: "l", type: "list", x: 0, y: 0, w: 339, h: 400,
      source: { kind: "static", items: [{ id: "ring", title: "Ring", image: "@asset:ring" }, "plain"] },
      item: { template: "{{item.title}}" },
      card: { title: { template: "{{item.title}}" }, imageField: "image", imageRatio: 1, lockedUnless: { variableId: "found", field: "id" }, lockedText: { template: "???" } },
      rowActions: [{ kind: "send-message", text: { template: "I look at the {{item.title}}" } }],
      direction: "row", columns: 3,
    }]);
    expect(out).toContain("<UiCardList");
    expect(out).toContain('rows={[{"id":"ring","title":"Ring","image":"@asset:ring"},"plain"]}');
    expect(out).toContain('lockVar={"found"}');
    expect(out).toContain('lockField={"id"}');
    expect(out).toContain("columns={3}");
    expect(out).toContain('api.sendMessage(interpolate(vars, itemText("I look at the {{item.title}}", item, index)))');
  });

  it("a plain list keeps its rows, and becomes pressable only when it has row steps", () => {
    const plain = src([{ id: "l", type: "list", x: 0, y: 0, w: 200, h: 100, source: { kind: "static", items: ["a", "b"] }, item: { template: "{{item}}" } }]);
    expect(plain).toContain('const rows = ["a","b"];');
    expect(plain).not.toContain("yp-rowbtn");
    const pressable = src([{ id: "l", type: "list", x: 0, y: 0, w: 200, h: 100, source: { kind: "static", items: ["a"] }, item: { template: "{{item}}" }, rowActions: [{ kind: "toast", text: { template: "{{item}}" } }] }]);
    expect(pressable).toContain('className="yp-rowbtn"');
    expect(pressable).toContain("runSteps(onRow, [Object.assign({}, vars), item, i])");
  });

  it("the switch step answers with a promise when the host gives one, and falls back to a pause", async () => {
    const out = src([choice()]);
    const settle = new Function(`${helper(out, "settle")}\nreturn settle;`)() as (r: unknown, ms?: number, cap?: number) => Promise<void> | undefined;
    let resolved = false;
    const p = new Promise<void>((r) => setTimeout(() => { resolved = true; r(); }, 20));
    await settle(p, 600, 15000);
    expect(resolved).toBe(true);
    // A host that never answers is capped.
    const started = Date.now();
    await settle(new Promise(() => {}), 600, 30);
    expect(Date.now() - started).toBeLessThan(500);
    expect(settle(undefined, 0, 15000)).toBeUndefined();
  });

  it("bindText resolves a scope's own tokens and leaves the rest for the variable pass", () => {
    const out = src([choice()]);
    const bindText = new Function(`${helper(out, "bindText")}\nreturn bindText;`)() as (t: string, name: string, v: unknown) => string;
    expect(bindText("{{choice}} / {{hp}}", "choice", "dawn")).toBe("dawn / {{hp}}");
    expect(bindText("{{value.name}} at {{value.place.city}}", "value", { name: "Rin", place: { city: "Oslo" } })).toBe("Rin at Oslo");
    expect(bindText("{{value}}", "value", ["a", "b"])).toBe("a, b");
    expect(bindText("{{value.missing}}!", "value", {})).toBe("!");
  });

  it("a button that sets a text with a macro stores the text as it reads now", () => {
    const out = src([{ id: "b", type: "button", x: 0, y: 0, w: 1, h: 1, label: { template: "Go" }, actions: [
      { kind: "set-variable", variableId: "msg", op: "set", value: "hi {{name}}" },
      { kind: "set-variable", variableId: "plain", op: "set", value: "no macro" },
    ] }]);
    expect(out).toContain('vars["msg"] = interpolate(vars, "hi {{name}}")');
    expect(out).toContain('vars["plain"] = "no macro"');
  });

  it("is deterministic with parts on the page", () => {
    const d = doc([choice(), { id: "pop", type: "popup", x: 0, y: 0, w: 1, h: 1, variableId: "x", body: { template: "b" } }]);
    expect(compileUiDoc(d).files["index.tsx"]).toBe(compileUiDoc(d).files["index.tsx"]);
  });
});

describe("parts in the document", () => {
  it("adds each new part where it can be seen, and every one validates and compiles", () => {
    let d = doc([]);
    const page = () => d.pages[0]!;
    d = addElement(d, "p1", newElement(page(), {
      id: "c", type: "choice", variableId: "opening",
      options: [{ id: "o1", title: "One" }, { id: "o2", title: "Two" }],
    }));
    d = addElement(d, "p1", newElement(page(), { id: "f", type: "field", variableId: "name", label: "Name?", placeholder: "Rin" }));
    d = addElement(d, "p1", newElement(page(), { id: "p", type: "popup", variableId: "clue", label: "New clue", buttonLabel: "OK" }));
    const [c, f, p] = page().elements;
    expect(c!.type).toBe("choice");
    expect(c!.x).toBe(18);
    expect(c!.x + c!.w).toBe(357);
    expect(f!.type === "field" && f!.label?.template).toBe("Name?");
    // A popup is centred and sits over everything.
    expect(p!.type).toBe("popup");
    expect(Math.abs(p!.x + p!.w / 2 - 375 / 2)).toBeLessThanOrEqual(1);
    expect(p!.z!).toBeGreaterThan(1000);
    expect(p!.type === "popup" && p!.body.template).toBe("{{value}}");
    // The desktop box is its own shape, inside the wide canvas.
    expect(c!.desktop && c!.desktop.w).toBe(720);
    expect(validateUiDoc(d).ok).toBe(true);
    const out = compileUiDoc(d).files["index.tsx"]!;
    for (const id of ["c", "f", "p"]) expect(out).toContain(`elId={${JSON.stringify(id)}}`);
  });

  it("removing a page drops the jumps inside cards, confirm buttons and list rows too", () => {
    let d = doc([
      choice({ confirm: { label: { template: "Go" }, actions: [{ kind: "go-page", pageId: "p2" }] } }),
      { id: "l", type: "list", x: 0, y: 0, w: 1, h: 1, source: { kind: "static", items: ["a"] }, item: { template: "{{item}}" }, rowActions: [{ kind: "go-page", pageId: "p2" }, { kind: "toast", text: { template: "x" } }] },
    ]);
    expect(validateUiDoc({ ...d, pages: [d.pages[0]!] }).ok).toBe(false);
    d = removePage(d, "p2");
    const [c, l] = d.pages[0]!.elements;
    expect(c!.type === "choice" && c!.options[0]!.actions!.map((a) => a.kind)).toEqual(["switch-greeting", "set-variable"]);
    expect(c!.type === "choice" && c!.confirm?.actions).toEqual([]);
    expect(l!.type === "list" && l!.rowActions!.map((a) => a.kind)).toEqual(["toast"]);
    expect(validateUiDoc(d).ok).toBe(true);
  });

  it("reports the variables the parts write and read, and not their own tokens", () => {
    const refs = uiDocVariableRefs(doc([
      choice(),
      { id: "f", type: "field", x: 0, y: 0, w: 1, h: 1, kind: "text", variableId: "name" },
      { id: "pop", type: "popup", x: 0, y: 0, w: 1, h: 1, variableId: "clue", body: { template: "{{value.text}} {{place}}" } },
      { id: "keep", type: "popup", x: 0, y: 0, w: 1, h: 1, variableId: "note", body: { template: "x" }, clearOnClose: false },
      { id: "b", type: "button", x: 0, y: 0, w: 1, h: 1, label: { template: "Go" }, actions: [], requires: ["age"] },
      { id: "l", type: "list", x: 0, y: 0, w: 1, h: 1, source: { kind: "static", items: [] }, item: { template: "{{item.title}} #{{index}}" }, card: { lockedUnless: { variableId: "found", field: "id" } } },
    ]));
    expect(refs.writes.sort()).toEqual(["clue", "hero", "name", "opening"]);
    for (const id of ["opening", "name", "clue", "note", "place", "age", "found"]) expect(refs.reads).toContain(id);
    for (const token of ["choice", "value.text", "item.title", "index"]) expect(refs.reads).not.toContain(token);
  });
});

/** A top-level helper of the generated file, lifted out so the test can run it. */
function helper(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`no helper ${name}`);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end + 2);
}
