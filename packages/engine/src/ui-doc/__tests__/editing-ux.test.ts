import { describe, expect, it } from "vitest";
import {
  THEME_TEXT, boxOn, coveredOn, freeSpotOn, isOnCanvas, movePage, nameFromQuestion, newElement, presenceOf,
  setEntryPage, withAutoVariable, withoutAutoVariables, fitTextBox, fitTextOnPage, textHeightNeeded, textStyleAffectsHeight,
} from "../edit.js";
import { copyElements, pasteElements, pasteOffset } from "../arrange.js";
import { compileUiDoc } from "../compile.js";
import { validateUiDoc } from "../schema.js";
import { getUiStarter } from "../starters.js";
import type { UiDoc, UiElement, UiPage } from "../types.js";

const build = (id: string): UiDoc => getUiStarter(id)!.build({ strings: {} });
const pageOf = (doc: UiDoc, id: string) => doc.pages.find((p) => p.id === id)!;
type Box = { x: number; y: number; w: number; h: number };
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const loadBearing = (page: UiPage, canvas: "phone" | "desktop") => page.elements
  .filter((el) => el.type === "chat" || el.type === "messages" || el.type === "composer")
  .map((el) => boxOn(el, canvas))
  .filter((b): b is Box => !!b && b.w > 0 && b.h > 0);

describe("where a new part lands", () => {
  it("keeps clear of the conversation where the page has room for the part (the wide canvas)", () => {
    for (const starter of ["character-setup", "collection"]) {
      const doc = build(starter);
      const chat = pageOf(doc, "chat");
      const el = newElement(chat, { id: "new", type: "button", text: "Go" });
      for (const canvas of ["desktop"] as const) {
        const b = boxOn(el, canvas)!;
        for (const lb of loadBearing(chat, canvas)) expect(overlaps(b, lb), `${starter}/${canvas}`).toBe(false);
      }
    }
  });

  it("lands below the parts already placed, not on top of them", () => {
    const page: UiPage = {
      id: "p", name: "p", height: 812,
      elements: [
        { id: "title", type: "text", x: 20, y: 40, w: 335, h: 40, desktop: { x: 40, y: 40, w: 400, h: 40 }, text: { template: "Hi" } },
      ],
    };
    const first = newElement(page, { id: "a", type: "button", text: "A" });
    expect(first.y).toBeGreaterThanOrEqual(80);
    const second = newElement({ ...page, elements: [...page.elements, first] }, { id: "b", type: "button", text: "B" });
    expect(overlaps(boxOn(second, "phone")!, boxOn(first, "phone")!)).toBe(false);
    expect(overlaps(boxOn(second, "desktop")!, boxOn(first, "desktop")!)).toBe(false);
    expect(second.y).toBeGreaterThan(first.y);
  });

  it("ignores a full-page backdrop — everything sits on it", () => {
    const page: UiPage = {
      id: "p", name: "p", height: 812,
      elements: [{ id: "bg", type: "box", x: 0, y: 0, w: 375, h: 812 }],
    };
    const b = freeSpotOn(page, "phone", 160, 44);
    expect(b).toEqual({ x: Math.round((375 - 160) / 2), y: Math.round(812 * 0.3), w: 160, h: 44 });
  });

  it("finds the real empty space on the opening page — off the cards AND off the heading", () => {
    const doc = build("openings");
    const open = pageOf(doc, "open");
    const cards = open.elements.find((el) => el.type === "choice")!;
    const words = open.elements.filter((el) => el.type === "text");
    // Small parts fit: above the heading on the phone, beside it on the desktop.
    for (const type of ["button", "text", "meter"] as const) {
      const el = newElement(open, { id: "new", type, text: "Go" });
      for (const canvas of ["phone", "desktop"] as const) {
        const b = boxOn(el, canvas)!;
        expect(overlaps(b, boxOn(cards, canvas)!), `${type}/${canvas} on the cards`).toBe(false);
        for (const w of words) expect(overlaps(b, boxOn(w, canvas)!), `${type}/${canvas} on ${w.id}`).toBe(false);
        expect(coveredOn(open, canvas, b)).toEqual([]);
      }
    }
    // The desktop has room beside the heading even for a picture.
    const image = newElement(open, { id: "new", type: "image" });
    expect(coveredOn(open, "desktop", boxOn(image, "desktop")!)).toEqual([]);
  });

  it("with no empty space left, goes under the last content — never on the title — and says so", () => {
    const doc = build("openings");
    const open = pageOf(doc, "open");
    const title = open.elements.find((el) => el.id === "open-title")!;
    const sub = open.elements.find((el) => el.id === "open-sub")!;
    // A 160px picture has nowhere to go on a full phone page.
    const image = newElement(open, { id: "new", type: "image" });
    const b = boxOn(image, "phone")!;
    expect(overlaps(b, boxOn(title, "phone")!)).toBe(false);
    expect(overlaps(b, boxOn(sub, "phone")!)).toBe(false);
    // Near the end of the content rather than squeezed in under the heading.
    expect(b.y).toBeGreaterThan(400);
    expect(b.y + b.h).toBeLessThanOrEqual(812);
    // The editor reads this to tell the creator it had nowhere better to go.
    expect(coveredOn(open, "phone", b).length).toBeGreaterThan(0);
  });

  it("on a crowded chat page, lands under the header rather than on it", () => {
    for (const starter of ["openings", "character-setup", "collection"]) {
      const chat = pageOf(build(starter), "chat");
      const el = newElement(chat, { id: "new", type: "button", text: "Go" });
      for (const canvas of ["phone", "desktop"] as const) {
        const b = boxOn(el, canvas)!;
        for (const w of chat.elements.filter((e) => e.type === "text" && isOnCanvas(e, canvas))) {
          expect(overlaps(b, boxOn(w, canvas)!), `${starter}/${canvas} on ${w.id}`).toBe(false);
        }
      }
    }
  });

  it("still treats a big question list or form as something to keep clear of", () => {
    const page = {
      id: "p", name: "p", height: 812,
      elements: [
        { id: "bg", type: "image", x: 0, y: 0, w: 375, h: 812, src: { kind: "url", url: "" } },
        { id: "form", type: "list", x: 0, y: 200, w: 375, h: 600, items: [] },
      ],
    } as unknown as UiPage;
    const b = freeSpotOn(page, "phone", 160, 44);
    expect(overlaps(b, { x: 0, y: 200, w: 375, h: 600 })).toBe(false);
  });

  it("writes new words in the theme's text colour, not white", () => {
    const page: UiPage = { id: "p", name: "p", height: 812, elements: [] };
    const text = newElement(page, { id: "t", type: "text", text: "Hello" });
    expect(text.type === "text" && text.style?.color).toBe(THEME_TEXT);
    expect(THEME_TEXT.startsWith("var(--yc-text")).toBe(true);
    const list = newElement(page, { id: "l", type: "list", text: "a\nb" });
    expect(list.type === "list" && list.textStyle?.color).toBe(THEME_TEXT);
  });
});

describe("parts on one canvas only", () => {
  it("reads a null desktop box as phone-only and a zero phone box as desktop-only", () => {
    const doc = build("character-setup");
    const all = doc.pages.flatMap((p) => p.elements);
    const deskOnly = all.find((el) => el.id === "form-register")!;
    expect(presenceOf(deskOnly)).toBe("desktop");
    expect(isOnCanvas(deskOnly, "phone")).toBe(false);
    const phoneOnly = build("collection").pages.flatMap((p) => p.elements).find((el) => el.desktop === null)!;
    expect(presenceOf(phoneOnly)).toBe("phone");
    const both: UiElement = { id: "x", type: "box", x: 0, y: 0, w: 10, h: 10 };
    expect(presenceOf(both)).toBe("both");
  });
});

describe("pages: the first page and the order", () => {
  it("sets which page the card opens on, and the compiled card follows", () => {
    const doc = build("openings");
    expect(doc.entryPageId).toBe("open");
    const next = setEntryPage(doc, "chat");
    expect(next.entryPageId).toBe("chat");
    expect(validateUiDoc(next).ok).toBe(true);
    const src = compileUiDoc(next).files["index.tsx"]!;
    expect(src).toMatch(/return editorPage\(PAGE_IDS\) \|\| "chat"/);
    // Unknown page: nothing changes.
    expect(setEntryPage(doc, "nope")).toBe(doc);
  });

  it("reorders pages without touching the entry or any page's step-aside", () => {
    const doc = build("openings");
    const open = pageOf(doc, "open");
    expect(open.leaveWhen?.pageId).toBe("chat");
    const moved = movePage(doc, "chat", 0);
    expect(moved.pages.map((p) => p.id)).toEqual(["chat", "open"]);
    expect(moved.entryPageId).toBe("open");
    expect(pageOf(moved, "open").leaveWhen).toEqual(open.leaveWhen);
    expect(validateUiDoc(moved).ok).toBe(true);
    // The compiled card still opens on the entry and still steps aside.
    const src = compileUiDoc(moved).files["index.tsx"]!;
    expect(src).toMatch(/return editorPage\(PAGE_IDS\) \|\| "open"/);
    expect(src).toContain('"open": function (api, vars)');
    expect(src).toContain('? "chat" : null');
    // Clamped, and a no-op returns the same doc.
    expect(movePage(doc, "open", 99).pages.map((p) => p.id)).toEqual(["chat", "open"]);
    expect(movePage(doc, "open", 0)).toBe(doc);
  });

  it("keeps a moved first page first-to-open with leaveWhen still pointing by id", () => {
    const doc = setEntryPage(movePage(build("openings"), "chat", 0), "open");
    expect(doc.entryPageId).toBe("open");
    expect(pageOf(doc, "open").leaveWhen?.pageId).toBe("chat");
  });
});

describe("paste offset", () => {
  const doc = (): UiDoc => ({
    version: 1, entryPageId: "a",
    pages: [
      { id: "a", name: "A", height: 812, elements: [
        { id: "b1", type: "button", x: 40, y: 100, w: 120, h: 40, desktop: { x: 300, y: 100, w: 120, h: 40 }, label: { template: "Go" }, actions: [] },
      ] },
      { id: "b", name: "B", height: 812, elements: [] },
    ],
  });

  it("steps 12px on the page the original still sits on, then 24px", () => {
    const d = doc();
    const clip = copyElements(d, "a", ["b1"]);
    const once = pasteElements(d, "a", clip, "s1");
    const first = once.doc.pages[0]!.elements.find((el) => el.id === once.ids[0])!;
    expect([first.x, first.y]).toEqual([52, 112]);
    expect(first.desktop).toEqual({ x: 312, y: 112, w: 120, h: 40 });
    const twice = pasteElements(once.doc, "a", clip, "s2");
    const second = twice.doc.pages[0]!.elements.find((el) => el.id === twice.ids[0])!;
    expect([second.x, second.y]).toEqual([64, 124]);
  });

  it("does not step on another page, or after a cut", () => {
    const d = doc();
    const clip = copyElements(d, "a", ["b1"]);
    const other = pasteElements(d, "b", clip, "s1");
    const pasted = other.doc.pages[1]!.elements[0]!;
    expect([pasted.x, pasted.y]).toEqual([40, 100]);
    expect(pasted.desktop).toEqual({ x: 300, y: 100, w: 120, h: 40 });
    // The second paste onto that page steps, because now something is there.
    expect(pasteOffset(other.doc.pages[1]!, clip, "phone")).toBe(12);
    // Cut: the original is gone, so the paste lands where it was.
    const cut: UiDoc = { ...d, pages: [{ ...d.pages[0]!, elements: [] }, d.pages[1]!] };
    const back = pasteElements(cut, "a", clip, "s1");
    expect([back.doc.pages[0]!.elements[0]!.x, back.doc.pages[0]!.elements[0]!.y]).toEqual([40, 100]);
  });

  it("still honours an explicit offset on one canvas", () => {
    const d = doc();
    const clip = copyElements(d, "a", ["b1"]);
    const r = pasteElements(d, "b", clip, "s", "phone", 30);
    expect([r.doc.pages[1]!.elements[0]!.x, r.doc.pages[1]!.elements[0]!.y]).toEqual([70, 130]);
    expect(r.doc.pages[1]!.elements[0]!.desktop).toEqual({ x: 300, y: 100, w: 120, h: 40 });
  });
});

describe("variables the editor made for a part", () => {
  it("names a variable for what a question asks about", () => {
    expect(nameFromQuestion("今晚的暗号是？")).toBe("今晚的暗号");
    expect(nameFromQuestion("你的名字是？")).toBe("你的名字");
    expect(nameFromQuestion("你叫什么？")).toBe("你");
    expect(nameFromQuestion("最喜欢的颜色是什么?")).toBe("最喜欢的颜色");
    expect(nameFromQuestion("What is your name?")).toBe("your name");
    expect(nameFromQuestion("  あなたの名前は？ ")).toBe("あなたの名前は");
    expect(nameFromQuestion("{{player_name}}，你从哪里来？")).toBe("你从哪里来");
    expect(nameFromQuestion("？？")).toBe("");
    expect([...nameFromQuestion("一".repeat(60))].length).toBe(24);
  });

  it("remembers them on the doc and survives validation", () => {
    const base = build("collection");
    const marked = withAutoVariable(withAutoVariable(base, "v1"), "v2");
    expect(marked.autoVariables).toEqual(["v1", "v2"]);
    expect(withAutoVariable(marked, "v1")).toBe(marked);
    const parsed = validateUiDoc(marked);
    expect(parsed.ok && parsed.doc.autoVariables).toEqual(["v1", "v2"]);
    const dropped = withoutAutoVariables(marked, ["v1"]);
    expect(dropped.autoVariables).toEqual(["v2"]);
    expect("autoVariables" in withoutAutoVariables(dropped, ["v2"])).toBe(false);
  });
});

describe("the editor chooses the canvas", () => {
  it("compiles a stage that follows the editor's canvas flag and re-measures on it", () => {
    const src = compileUiDoc(build("openings")).files["index.tsx"]!;
    expect(src).toContain("function editorCanvas()");
    expect(src).toContain("__yuminaUiEditCanvas");
    expect(src).toContain('const mode = editorCanvas() || (rect.width / rect.height > 1.15 ? "desktop" : "phone");');
    expect(src).toContain('window.addEventListener("yumina:ui-edit-page", measure)');
  });
});

describe("text boxes grow with their words", () => {
  it("a title raised from 30 to 52 grows tall enough to show its letters", () => {
    const doc = build("openings");
    const title = pageOf(doc, "open").elements.find((el) => el.id === "open-title")!;
    expect(fitTextBox(title)).toBe(title);
    if (title.type !== "text") throw new Error("not text");
    const bigger = { ...title, style: { ...title.style, size: 52 } };
    const fitted = fitTextBox(bigger);
    expect(fitted.h).toBeGreaterThanOrEqual(Math.ceil(52 * (title.style?.lineHeight ?? 1.5)));
    expect(fitted.desktop).toEqual(title.desktop);
  });

  it("grows the wide canvas box by its own size, and never shrinks a box", () => {
    const el: UiElement = {
      id: "t", type: "text", x: 0, y: 0, w: 300, h: 200, desktop: { x: 0, y: 0, w: 600, h: 20 },
      text: { template: "Hello" }, style: { size: 14, desktopSize: 40, lineHeight: 1.2 },
    };
    const fitted = fitTextBox(el);
    expect(fitted.h).toBe(200);
    expect(fitted.desktop!.h).toBeGreaterThanOrEqual(48);
  });

  it("counts wrapped lines, and only reacts to style fields that change height", () => {
    const el: UiElement = {
      id: "t", type: "text", x: 0, y: 0, w: 100, h: 20,
      text: { template: "一二三四五六七八九十一二三四五六七八九十" }, style: { size: 20, lineHeight: 1 },
    };
    expect(textHeightNeeded(el, "phone")).toBeGreaterThanOrEqual(80);
    expect(textStyleAffectsHeight({ size: 3 })).toBe(true);
    expect(textStyleAffectsHeight({ color: "#fff" })).toBe(false);
  });
});

describe("a text box that grew pushes what is under it", () => {
  const zh = {
    openTitle: "从哪一刻开始？",
    openSub: "同一个人，四次不同的相遇。选一个，故事就从那里写起。",
    title: "潮音镇的渡船",
    chatSub: "和渡船船长沈砚",
  };
  const openPage = () => pageOf(getUiStarter("openings")!.build({ strings: zh }), "open");
  const chatPage = () => pageOf(getUiStarter("openings")!.build({ strings: zh }), "chat");
  const restyle = (page: UiPage, id: string, style: object): UiPage => {
    const before = page.elements.find((el) => el.id === id)!;
    const changed = { ...before, style: { ...(before as { style?: object }).style, ...style } } as UiElement;
    const withStyle = { ...page, elements: page.elements.map((el) => (el.id === id ? changed : el)) };
    return fitTextOnPage(withStyle, id, before);
  };
  const noOverlaps = (page: UiPage, ids: string[], canvas: "phone" | "desktop") => {
    for (const a of ids) for (const b of ids) {
      if (a >= b) continue;
      const ea = page.elements.find((el) => el.id === a)!;
      const eb = page.elements.find((el) => el.id === b)!;
      expect(overlaps(boxOn(ea, canvas)!, boxOn(eb, canvas)!), `${a} × ${b} on ${canvas}`).toBe(false);
    }
  };

  it("a phone title raised to 52 wraps instead of being cut off, and the subtitle and cards move down", () => {
    const before = openPage();
    const after = restyle(before, "open-title", { size: 52 });
    const title = after.elements.find((el) => el.id === "open-title")!;
    // Seven characters at 52px do not fit a phone's row: two lines, not 「从哪一刻开…」.
    expect(title.type === "text" && title.style?.nowrap).toBe(false);
    const grew = title.h - before.elements.find((el) => el.id === "open-title")!.h;
    expect(grew).toBeGreaterThan(40);
    const sub = (p: UiPage) => p.elements.find((el) => el.id === "open-sub")!;
    const cards = (p: UiPage) => p.elements.find((el) => el.id === "open-cards")!;
    expect(sub(after).y).toBe(sub(before).y + grew);
    expect(cards(after).y).toBe(cards(before).y + grew);
    // The cards give up height at the bottom rather than leaving the page.
    expect(cards(after).y + cards(after).h).toBeLessThanOrEqual(812);
    noOverlaps(after, ["open-title", "open-sub", "open-cards"], "phone");
    // The wide layout is its own arrangement: nothing moved there.
    for (const id of ["open-title", "open-sub", "open-cards"]) {
      expect(boxOn(after.elements.find((el) => el.id === id)!, "desktop")).toEqual(boxOn(before.elements.find((el) => el.id === id)!, "desktop"));
    }
  });

  it("on the wide canvas the same title just grows taller and pushes its own column down", () => {
    const before = openPage();
    const after = restyle(before, "open-title", { desktopSize: 60 });
    const t0 = boxOn(before.elements.find((el) => el.id === "open-title")!, "desktop")!;
    const t1 = boxOn(after.elements.find((el) => el.id === "open-title")!, "desktop")!;
    expect(t1.h).toBeGreaterThan(t0.h);
    const title = after.elements.find((el) => el.id === "open-title")!;
    expect(title.type === "text" && title.style?.nowrap).toBe(true);
    noOverlaps(after, ["open-title", "open-sub", "open-cards"], "desktop");
    expect(boxOn(after.elements.find((el) => el.id === "open-sub")!, "desktop")!.y)
      .toBe(boxOn(before.elements.find((el) => el.id === "open-sub")!, "desktop")!.y + (t1.h - t0.h));
    // The phone layout is untouched.
    expect(after.elements.find((el) => el.id === "open-sub")!.y).toBe(before.elements.find((el) => el.id === "open-sub")!.y);
  });

  it("a one-line title that still fits its row widens into the free room and stays one line", () => {
    const page: UiPage = {
      id: "p", name: "p", height: 812,
      elements: [
        { id: "t", type: "text", x: 20, y: 40, w: 150, h: 30, desktop: null, text: { template: "Chapter One" }, style: { size: 20, nowrap: true } },
        { id: "under", type: "text", x: 20, y: 80, w: 200, h: 20, desktop: null, text: { template: "sub" } },
      ],
    };
    const after = restyle(page, "t", { size: 30 });
    const t = after.elements.find((el) => el.id === "t")!;
    expect(t.type === "text" && t.style?.nowrap).toBe(true);
    expect(t.w).toBeGreaterThan(150);
    expect(t.x + t.w).toBeLessThanOrEqual(375 - 16);
    noOverlaps(after, ["t", "under"], "phone");
  });

  it("the chat header growing takes height from the transcript, never moves the composer off the page", () => {
    const before = chatPage();
    const after = restyle(before, "chat-title", { size: 30 });
    const composer = (p: UiPage) => p.elements.find((el) => el.type === "composer")!;
    const messages = (p: UiPage) => p.elements.find((el) => el.type === "messages")!;
    expect(composer(after)).toEqual(composer(before));
    expect(messages(after).y).toBeGreaterThan(messages(before).y);
    expect(messages(after).y + messages(after).h).toBe(composer(after).y);
    noOverlaps(after, ["chat-title", "chat-sub", "chat-messages", "chat-composer"], "phone");
  });

  it("does nothing when the box did not grow", () => {
    const page = openPage();
    const after = restyle(page, "open-title", { color: "#fff" });
    expect(after.elements.map(({ x, y, w, h, desktop }) => ({ x, y, w, h, desktop })))
      .toEqual(page.elements.map(({ x, y, w, h, desktop }) => ({ x, y, w, h, desktop })));
    const title = page.elements.find((el) => el.id === "open-title")!;
    expect(fitTextOnPage(page, "open-title", title)).toBe(page);
  });

  it("a part without a wide box of its own keeps its wide place when only the phone pushed it", () => {
    const page: UiPage = {
      id: "p", name: "p", height: 812,
      elements: [
        { id: "t", type: "text", x: 20, y: 40, w: 335, h: 30, desktop: { x: 40, y: 40, w: 600, h: 60 }, text: { template: "Hello" }, style: { size: 20 } },
        { id: "shared", type: "button", x: 20, y: 80, w: 100, h: 40, label: { template: "Go" }, actions: [] },
      ],
    };
    const after = restyle(page, "t", { size: 40 });
    const shared = after.elements.find((el) => el.id === "shared")!;
    expect(shared.y).toBeGreaterThan(80);
    expect(boxOn(shared, "desktop")).toEqual({ x: 20, y: 80, w: 100, h: 40 });
  });
});

describe("a hugging text box follows its words both ways", () => {
  const base = { id: "t", type: "text", x: 0, y: 0, w: 600, h: 200, text: { template: "雾港来信" }, style: { size: 20, lineHeight: 1.2 } } as const;
  it("shrinks to the words, with room for the glyphs", () => {
    const fitted = fitTextBox(base as never, undefined, { hug: true });
    expect(fitted.h).toBeLessThan(60);
    expect(fitted.h).toBeGreaterThanOrEqual(Math.ceil(20 * 1.2 + 2));
  });
  it("without hug, a taller box is left alone", () => {
    expect(fitTextBox(base as never)).toBe(base);
  });
});
