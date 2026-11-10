import { describe, it, expect } from "vitest";
import { compileUiDoc } from "../compile.js";
import { validateUiDoc } from "../schema.js";
import { addPage, newElement, removePage, renamePage, addElement } from "../edit.js";
import { UI_CHAT_STARTED, buttonActionsOf, type UiAction, type UiDoc, type UiElement } from "../types.js";
import { uiDocVariableRefs } from "../variable-refs.js";

const doc = (elements: UiElement[], over: Partial<UiDoc> = {}): UiDoc => ({
  version: 1,
  entryPageId: "p1",
  pages: [
    { id: "p1", name: "Main", height: 812, elements },
    { id: "p2", name: "Two", height: 812, elements: [] },
  ],
  ...over,
});

const button = (actions: UiAction[]): UiElement => ({
  id: "b", type: "button", x: 0, y: 0, w: 100, h: 40, label: { template: "Go" }, actions,
});

const src = (d: UiDoc) => compileUiDoc(d).files["index.tsx"]!;

/** A top-level helper of the generated file, lifted out so the test can run it. */
function helper(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`no helper ${name}`);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end + 2);
}

/** The body of the one button's click handler: its awaited steps, in order. */
function clickBody(source: string): string {
  const open = source.indexOf("onClick={async () => {");
  const tryAt = source.indexOf("try {", open);
  const catchAt = source.indexOf("} catch (err)", tryAt);
  return source.slice(tryAt + "try {".length, catchAt);
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<void>;

async function click(source: string, api: Record<string, unknown>, vars: Record<string, unknown>, go: (id: string) => void) {
  const prelude = ["readVar", "interpolate", "settle", "runBehavior", "rewindLast", "regenerateLast", "copyLast", "lastAssistant", "canActOnLast"]
    .map((name) => helper(source, name))
    .join("\n");
  // The generated file is TSX with its regexes escaped for a template literal;
  // what is lifted here is plain JS.
  const run = new AsyncFunction("api", "vars", "go", `${prelude}\n${clickBody(source)}`);
  await run(api, vars, go);
}

describe("button actions run in order", () => {
  it("runs every step in the listed order and waits for the opening switch before the next", async () => {
    const source = src(doc([button([
      { kind: "set-variable", variableId: "hp", op: "add", value: 5 },
      { kind: "switch-greeting", index: 2 },
      { kind: "set-variable", variableId: "hero", op: "set", value: "Aria" },
      { kind: "toast", text: { template: "picked {{hero}}" } },
      { kind: "go-page", pageId: "p2" },
    ])]));
    const log: string[] = [];
    let release!: () => void;
    const switched = new Promise<void>((r) => { release = r; });
    const api = {
      setVariable: (id: string, value: unknown) => { log.push(`set ${id}=${String(value)}`); },
      switchGreeting: (i: number) => { log.push(`switch ${i}`); return switched.then(() => { log.push("switch done"); }); },
      showToast: (text: string) => { log.push(`toast ${text}`); },
    };
    const live = { hp: 10, hero: "?" };
    const running = click(source, api, live, (id) => log.push(`go ${id}`));
    await new Promise((r) => setTimeout(r, 20));
    // Nothing after the switch may run while the switch is still in flight.
    expect(log).toEqual(["set hp=15", "switch 2"]);
    release();
    await running;
    expect(log).toEqual(["set hp=15", "switch 2", "switch done", "set hero=Aria", "toast picked Aria", "go p2"]);
    // A later step reads what an earlier one wrote, without the button
    // writing into the render's own variable bag.
    expect(live).toEqual({ hp: 10, hero: "?" });
  });

  it("waits a moment after a switch that does not say when it is done, but only if a step follows", () => {
    const withNext = src(doc([button([{ kind: "switch-greeting", index: 1 }, { kind: "go-page", pageId: "p2" }])]));
    expect(withNext).toMatch(/await settle\(api\.switchGreeting && api\.switchGreeting\(1\), [1-9]\d*, [1-9]\d*\);/);
    const alone = src(doc([button([{ kind: "switch-greeting", index: 1 }])]));
    expect(alone).toMatch(/await settle\(api\.switchGreeting && api\.switchGreeting\(1\), 0, [1-9]\d*\);/);
  });

  it("sets off a behaviour and waits for it before the next step", async () => {
    const steps: UiAction[] = [
      { kind: "run-behavior", actionId: "上楼" },
      { kind: "set-variable", variableId: "floor", op: "set", value: "二楼" },
    ];
    expect(validateUiDoc(doc([button(steps)])).ok).toBe(true);
    const source = src(doc([button(steps)]));
    const log: string[] = [];
    let release!: () => void;
    const applied = new Promise<void>((r) => { release = r; });
    const api = {
      executeActionAndWait: (id: string) => { log.push(`behavior ${id}`); return applied.then(() => { log.push("applied"); }); },
      setVariable: (id: string, value: unknown) => { log.push(`set ${id}=${String(value)}`); },
    };
    const running = click(source, api, {}, () => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(log).toEqual(["behavior 上楼"]);
    release();
    await running;
    expect(log).toEqual(["behavior 上楼", "applied", "set floor=二楼"]);
  });

  it("goes on to the next step where nothing can run a behaviour", async () => {
    const source = src(doc([button([
      { kind: "run-behavior", actionId: "上楼" },
      { kind: "toast", text: { template: "到了" } },
    ])]));
    const shown: string[] = [];
    // The editor's preview refuses; an older host has only the fire-and-forget call.
    await click(source, { executeActionAndWait: () => Promise.reject(new Error("Actions are unavailable in this view.")), showToast: (s: string) => shown.push(s) }, {}, () => {});
    const fired: string[] = [];
    await click(source, { executeAction: (id: string) => { fired.push(id); }, showToast: (s: string) => shown.push(s) }, {}, () => {});
    expect(shown).toEqual(["到了", "到了"]);
    expect(fired).toEqual(["上楼"]);
  });

  it("keeps a button with no steps a plain no-op", () => {
    const source = src(doc([button([])]));
    expect(source).toContain("/* no actions */");
    expect(source).not.toContain("onClick={async");
  });
});

describe("a list of the card's own entries", () => {
  it("reads one role or one folder, with a first line only from what the player may read", () => {
    const list = {
      id: "l", type: "list", x: 0, y: 0, w: 100, h: 100,
      source: { kind: "entries", role: "character" },
      item: { template: "{{item.title}}" },
      card: { title: { template: "{{item.title}}" }, imageField: "image" },
    } as unknown as UiElement;
    expect(validateUiDoc(doc([list])).ok).toBe(true);
    const source = src(doc([list]));
    expect(source).toContain('entryRows(api, "character", "")');
    const entryRows = new Function(`${helper(source, "entryRows")}\nreturn entryRows;`)() as (api: unknown, role: string, folder: string) => Array<Record<string, string>>;
    const api = { entries: [
      { id: "a", name: "沈霏", role: "character", content: "十九岁，美院退学生。\n她把手稿藏在二楼。", portrait: "https://x/a.png" },
      { id: "b", name: "账本", role: "lore", content: "藏在井里" },
      { id: "c", name: "沈砚", role: "character", content: "他知道账本在哪", audience: "ai" },
      { id: "d", name: "旧角色", role: "character", content: "x", enabled: false },
      { id: "e", name: "灯笼", role: "lore", content: "道具", folderId: "props" },
    ] };
    expect(entryRows(api, "character", "")).toEqual([
      { id: "a", title: "沈霏", body: "十九岁，美院退学生。", image: "https://x/a.png" },
      // Written only for the AI: its name is shown, never its text.
      { id: "c", title: "沈砚", body: "", image: "" },
    ]);
    expect(entryRows(api, "", "props").map((r) => r.title)).toEqual(["灯笼"]);
    expect(entryRows({}, "character", "")).toEqual([]);
  });
});

describe("the single-action spelling still works", () => {
  const legacy = {
    id: "b", type: "button", x: 0, y: 0, w: 100, h: 40, label: { template: "Go" },
    action: { kind: "go-page", pageId: "p2" },
  };

  it("validates as a one-step list", () => {
    const result = validateUiDoc({ ...doc([]), pages: [{ id: "p1", name: "M", height: 812, elements: [legacy] }, { id: "p2", name: "T", height: 812, elements: [] }] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const el = result.doc.pages[0]!.elements[0]!;
    expect(el.type === "button" && el.actions).toEqual([{ kind: "go-page", pageId: "p2" }]);
  });

  it("still catches a legacy jump to a missing page", () => {
    const result = validateUiDoc({ ...doc([]), pages: [{ id: "p1", name: "M", height: 812, elements: [{ ...legacy, action: { kind: "go-page", pageId: "nope" } }] }] });
    expect(result.ok).toBe(false);
  });

  it("compiles when handed straight to the compiler", () => {
    const source = src(doc([legacy as unknown as UiElement]));
    expect(source).toContain('go("p2");');
    expect(buttonActionsOf(legacy)).toEqual([{ kind: "go-page", pageId: "p2" }]);
  });
});

describe("the 还没开始聊 condition", () => {
  const text = (value: boolean): UiElement => ({
    id: "t", type: "text", x: 0, y: 0, w: 100, h: 20, text: { template: "pick one" },
    visibleWhen: { variableId: UI_CHAT_STARTED, operator: "eq", value },
  });

  it("reads the message list, not a variable", () => {
    const source = src(doc([text(false)]));
    expect(source).toContain("looseEq(chatStarted(api), JSON.parse(\"false\"))");
    expect(source).not.toContain(`readVar(vars, ${JSON.stringify(UI_CHAT_STARTED)})`);
  });

  it("is true only once the player has sent something", () => {
    const source = src(doc([text(false)]));
    const chatStarted = new Function(`${helper(source, "chatStarted")}\nreturn chatStarted;`)() as (api: unknown) => boolean;
    expect(chatStarted({ messages: [] })).toBe(false);
    expect(chatStarted({ messages: [{ role: "assistant", content: "greeting" }] })).toBe(false);
    expect(chatStarted({ messages: [{ role: "assistant" }, { role: "user" }] })).toBe(true);
    expect(chatStarted({})).toBe(false);
  });

  it("validates, and is not reported as a variable the card reads", () => {
    expect(validateUiDoc(doc([text(true)])).ok).toBe(true);
    const refs = uiDocVariableRefs(doc([
      text(false),
      { id: "u", type: "text", x: 0, y: 0, w: 1, h: 1, text: { template: "x" }, visibleWhen: { variableId: "route", operator: "eq", value: "a" } },
    ]));
    expect(refs.reads).toContain("route");
    expect(refs.reads).not.toContain(UI_CHAT_STARTED);
  });
});

describe("pages in the compiled card", () => {
  it("follows the editor's page and announces a jump", () => {
    const source = src(doc([button([{ kind: "go-page", pageId: "p2" }])]));
    expect(source).toContain('const PAGE_IDS = ["p1","p2"];');
    expect(source).toContain("editorPage(PAGE_IDS)");
    expect(source).toContain("announcePage(next)");
  });
});

describe("adding elements and pages", () => {
  it("places each addable type on the page, on top, without landing exactly on the last one", () => {
    let d = doc([]);
    const page = () => d.pages[0]!;
    for (const type of ["text", "button", "image", "box", "meter", "list"] as const) {
      const el = newElement(page(), { id: `n-${type}`, type, text: "hi", variableId: "hp" });
      expect(el.type).toBe(type);
      d = addElement(d, "p1", el);
    }
    const els = page().elements;
    expect(els).toHaveLength(6);
    const text = els[0]!;
    const buttonEl = els[1]!;
    expect(text.x + text.w).toBeLessThanOrEqual(375);
    expect(buttonEl.z).toBeGreaterThan(text.z ?? 0);
    // The second part does not land on the first.
    expect(buttonEl.y).toBeGreaterThanOrEqual(text.y + text.h);
    expect(validateUiDoc(d).ok).toBe(true);
    // Every element compiles to something real.
    const source = src(d);
    for (const el of els) expect(source).toContain(`data-ui-el=${JSON.stringify(el.id)}`);
  });

  it("adds, renames and removes pages, dropping jumps to a removed page", () => {
    let d = doc([button([{ kind: "go-page", pageId: "p3" }, { kind: "toast", text: { template: "x" } }])]);
    d = addPage(d, { id: "p3", name: "New" });
    expect(d.pages.map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
    d = renamePage(d, "p3", "Cast");
    expect(d.pages[2]!.name).toBe("Cast");
    d = removePage(d, "p3");
    expect(d.pages.map((p) => p.id)).toEqual(["p1", "p2"]);
    const el = d.pages[0]!.elements[0]!;
    expect(el.type === "button" && el.actions).toEqual([{ kind: "toast", text: { template: "x" } }]);
    expect(validateUiDoc(d).ok).toBe(true);
  });

  it("moves the entry off a removed entry page and never removes the last page", () => {
    let d = removePage(doc([]), "p1");
    expect(d.entryPageId).toBe("p2");
    expect(removePage(d, "p2")).toBe(d);
  });
});
