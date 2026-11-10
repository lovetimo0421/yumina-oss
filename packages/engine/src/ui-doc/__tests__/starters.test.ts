import { describe, expect, it } from "vitest";
import ts from "typescript";
import { compileUiDoc } from "../compile.js";
import { elementActions, removePage } from "../edit.js";
import { currentUiLook } from "../looks.js";
import { validateUiDoc } from "../schema.js";
import { UI_STARTERS, getUiStarter } from "../starters.js";
import { UI_CANVAS_W, UI_DESKTOP_H, UI_DESKTOP_W } from "../types.js";
import type { UiDoc } from "../types.js";
import { uiDocVariableRefs } from "../variable-refs.js";

const build = (id: string, strings: Record<string, string> = {}) => getUiStarter(id)!.build({ strings });
const elements = (doc: UiDoc) => doc.pages.flatMap((p) => p.elements);

describe("starters", () => {
  it("ships the four", () => {
    expect(UI_STARTERS.map((s) => s.id)).toEqual(["openings", "character-setup", "adventure-panel", "collection"]);
    // Four starters, four different looks — they must read as four things.
    expect(new Set(UI_STARTERS.map((s) => s.theme.id)).size).toBe(4);
  });

  for (const starter of UI_STARTERS) {
    describe(starter.id, () => {
      const doc = starter.build({ strings: {} });

      it("is a valid document that compiles to parseable TSX", () => {
        const valid = validateUiDoc(doc);
        expect(valid.ok ? [] : valid.errors).toEqual([]);
        const src = compileUiDoc(doc).files["index.tsx"]!;
        const out = ts.transpileModule(src, { reportDiagnostics: true, compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020 } });
        expect(out.diagnostics ?? []).toEqual([]);
      });

      it("binds only the variables it declares", () => {
        const declared = new Set(starter.variables.map((v) => v.id));
        const refs = uiDocVariableRefs(doc);
        for (const id of [...refs.reads, ...refs.writes]) expect(declared, `undeclared ${id}`).toContain(id);
      });

      it("switches only between the openings it declares", () => {
        const indices = elements(doc).flatMap((el) => elementActions(el))
          .flatMap((a) => (a.kind === "switch-greeting" ? [a.index] : []));
        for (const i of indices) expect(i).toBeLessThan(starter.greetings);
      });

      it("keeps every part on both canvases", () => {
        for (const page of doc.pages) {
          for (const el of page.elements) {
            const phoneOff = el.w === 0 && el.h === 0;
            if (!phoneOff) {
              expect(el.x, `${el.id} x`).toBeGreaterThanOrEqual(0);
              expect(el.x + el.w, `${el.id} right`).toBeLessThanOrEqual(UI_CANVAS_W);
              expect(el.y + el.h, `${el.id} bottom`).toBeLessThanOrEqual(page.height);
            }
            // Every part says where it goes on the wide canvas, or that it is
            // not there — "same as the phone" is never right on a 1024 canvas.
            expect(el.desktop, `${el.id} desktop`).not.toBeUndefined();
            if (el.desktop) {
              expect(el.desktop.x + el.desktop.w, `${el.id} desktop right`).toBeLessThanOrEqual(UI_DESKTOP_W);
              expect(el.desktop.y + el.desktop.h, `${el.id} desktop bottom`).toBeLessThanOrEqual(page.desktopHeight ?? UI_DESKTOP_H);
            }
          }
        }
      });

      it("ends in a conversation", () => {
        const types = new Set(elements(doc).map((el) => el.type));
        expect(types.has("messages") || types.has("chat")).toBe(true);
        expect(types.has("composer") || types.has("chat")).toBe(true);
      });

      it("speaks only through the strings it was given", () => {
        const withWords = starter.build({ strings: new Proxy({}, { get: (_t, key) => `«${String(key)}»` }) as Record<string, string> });
        const texts = JSON.stringify(withWords);
        // Nothing in the document is a CJK literal the caller could not translate.
        const bare = JSON.stringify(withWords.pages.map((p) => p.elements.map((el) => ({ ...el, css: undefined }))))
          .replace(/«[^»]*»/g, "");
        expect(bare).not.toMatch(/[一-鿿]/);
        expect(texts).toContain("«");
      });
    });
  }

  it("openings: each card switches to its own opening and goes to the chat, and the picker gives way once the chat starts", () => {
    const doc = build("openings");
    const pick = elements(doc).find((el) => el.type === "choice")!;
    if (pick.type !== "choice") throw new Error("no choice");
    expect(pick.options.map((o) => o.actions?.[0])).toEqual([0, 1, 2, 3].map((index) => ({ kind: "switch-greeting", index })));
    expect(pick.options.every((o) => o.actions?.some((a) => a.kind === "go-page" && a.pageId === "chat"))).toBe(true);
    expect(doc.entryPageId).toBe("open");
    expect(doc.pages[0]!.leaveWhen).toEqual({ when: { variableId: "$chat.started", operator: "eq", value: true }, pageId: "chat" });
    expect(currentUiLook(pick)).toBe("choice-cover");
    expect(compileUiDoc(doc).files["index.tsx"]).toContain('"open": function (api, vars) { return looseEq(chatStarted(api), JSON.parse("true")) ? "chat" : null; }');
  });

  it("character setup: the start button waits for a name and a role, then introduces the player", () => {
    const doc = build("character-setup", { introMessage: "我叫{{player_name}}，是{{identity}}。{{about}}" });
    const start = elements(doc).find((el) => el.id === "form-start")!;
    if (start.type !== "button") throw new Error("no button");
    expect(start.requires).toEqual(["player_name", "identity"]);
    expect(start.actions.map((a) => a.kind)).toEqual(["go-page", "send-message"]);
    const fields = elements(doc).filter((el) => el.type === "field");
    expect(fields.map((f) => (f.type === "field" ? f.variableId : ""))).toEqual(["player_name", "identity", "about"]);
  });

  it("adventure panel: the bag is a card list over the bag variable and the popup watches new_item", () => {
    const doc = build("adventure-panel");
    const lists = elements(doc).filter((el) => el.type === "list");
    expect(lists.length).toBe(2);
    for (const list of lists) if (list.type === "list") expect(list.source).toEqual({ kind: "variable", variableId: "bag" });
    const popup = elements(doc).find((el) => el.type === "popup");
    expect(popup && popup.type === "popup" ? popup.variableId : null).toBe("new_item");
  });

  it("collection: rows are locked until their id is in unlocked", () => {
    const doc = build("collection");
    const album = elements(doc).find((el) => el.id === "album-list")!;
    if (album.type !== "list") throw new Error("no list");
    expect(album.card?.lockedUnless).toEqual({ variableId: "unlocked", field: "id" });
    expect(album.source.kind === "static" ? album.source.items.length : 0).toBe(8);
  });
});

describe("pages that give way, and remixing", () => {
  it("keeps desktopHeight and leaveWhen through validation, and checks leaveWhen's target", () => {
    const doc = build("openings");
    doc.pages[1]!.desktopHeight = 720;
    const ok = validateUiDoc(doc);
    expect(ok.ok && ok.doc.pages[1]!.desktopHeight).toBe(720);
    expect(ok.ok && ok.doc.pages[0]!.leaveWhen?.pageId).toBe("chat");
    const broken = { ...doc, pages: [{ ...doc.pages[0]!, leaveWhen: { when: doc.pages[0]!.leaveWhen!.when, pageId: "nowhere" } }, doc.pages[1]!] };
    const bad = validateUiDoc(broken);
    expect(bad.ok ? [] : bad.errors.join()).toContain('leaveWhen points at missing page "nowhere"');
  });

  it("never gives way in the editor, and a card without leaveWhen compiles as before", () => {
    const src = compileUiDoc(build("openings")).files["index.tsx"]!;
    expect(src).toContain("const __to = __leave && !editorGhosts() ? __leave(api, vars) : null;");
    expect(src).toContain('{__page === "open" ?');
    const plain = compileUiDoc(build("collection")).files["index.tsx"]!;
    expect(plain).not.toContain("PAGE_LEAVE");
    expect(plain).toContain('{page === "chat" ?');
  });

  it("removing the page a page gives way to leaves the page in place", () => {
    const doc = removePage(build("openings"), "chat");
    expect(doc.pages[0]!.leaveWhen).toBeUndefined();
  });

  it("remixes by adding parts: the sign-in page dropped into the openings card is still a valid card", () => {
    const openings = build("openings");
    const form = build("character-setup").pages.find((p) => p.id === "form")!;
    const remixed: UiDoc = { ...openings, pages: [...openings.pages, { ...form, id: "form" }] };
    const valid = validateUiDoc(remixed);
    expect(valid.ok ? [] : valid.errors).toEqual([]);
    const reads = uiDocVariableRefs(remixed).reads;
    expect(reads).toEqual(expect.arrayContaining(["opening", "player_name", "identity"]));
  });
});
