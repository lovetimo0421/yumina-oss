import { describe, expect, it } from "vitest";
import { compileUiDoc } from "../compile.js";
import { validateUiDoc } from "../schema.js";
import { UI_TEMPLATES, detectUiTemplate, fillTemplateMacros, getUiTemplate } from "../templates.js";
import type { UiTemplatePreset } from "../templates.js";
import { buildUiTheme, UI_THEMES } from "../themes.js";
import { UI_CANVAS_W, UI_DESKTOP_H, UI_DESKTOP_W } from "../types.js";
import type { UiDoc, UiElement } from "../types.js";

/**
 * Every assertion here runs against EVERY official layout.
 *
 * A set of layouts is only a set if they hold the same promises: each one is a
 * valid document, is playable, keeps its parts on the page, binds only to
 * variables it declared, survives a light theme, and can be left once entered.
 * Writing the checks per-layout is how the fourth one quietly stops doing what
 * the first three do.
 */

/** Stand-in words and ids, built from what the layout itself declares — so a
 *  layout that asks for a new string or variable is covered the moment it is
 *  added rather than the next time someone remembers this file. */
function inputFor(template: UiTemplatePreset) {
  const strings: Record<string, string> = { title: "Lin Zhou" };
  for (const key of template.stringKeys) {
    // Composed strings carry `{macro}` slots; give them real ones so the fill
    // step is exercised rather than skipped.
    strings[key] = key.endsWith("Format")
      ? template.needs.map((need) => `{${need.key}}`).join(" · ")
      : `word:${key}`;
  }
  const variableIds: Record<string, string> = {};
  for (const need of template.needs) variableIds[need.key] = `v-${need.key}`;
  return { strings, variableIds };
}

const buildAll = () => UI_TEMPLATES.map((t) => ({ template: t, doc: t.build(inputFor(t)) }));

const allIds = (doc: UiDoc) => (doc.pages ?? []).flatMap((p) => (p.elements ?? []).map((e) => e.id));

describe.each(UI_TEMPLATES.map((t) => [t.id, t] as const))("the %s layout", (_id, template) => {
  const build = (extra: Partial<Parameters<typeof template.build>[0]> = {}): UiDoc =>
    template.build({ ...inputFor(template), ...extra });
  const scene = () => build().pages[0]!;

  it("is a valid document", () => {
    const result = validateUiDoc(build());
    expect(result.ok, result.ok ? "" : result.errors.join("; ")).toBe(true);
  });

  it("is playable: a transcript to read and a composer to answer in", () => {
    const types = scene().elements.map((el) => el.type);
    expect(types).toContain("messages");
    expect(types).toContain("composer");
  });

  it("keeps every element inside the page it is arranged on", () => {
    for (const page of build().pages) {
      for (const el of page.elements) {
        expect(el.x, `${page.id}/${el.id}`).toBeGreaterThanOrEqual(0);
        expect(el.y, `${page.id}/${el.id}`).toBeGreaterThanOrEqual(0);
        expect(el.x + el.w, `${page.id}/${el.id}`).toBeLessThanOrEqual(UI_CANVAS_W);
        expect(el.y + el.h, `${page.id}/${el.id}`).toBeLessThanOrEqual(page.height);
      }
    }
  });

  describe("on the wide canvas", () => {
    /** The box an element occupies when the desktop canvas is in force. */
    const wide = (el: UiElement) => (el.desktop === undefined ? el : el.desktop);

    it("places every part it draws, rather than leaving it at phone coordinates", () => {
      // An element with no desktop box keeps its phone numbers, which on a
      // 1024-wide canvas means it sits wherever it happened to sit on a 375-wide
      // one. That is right for a full-bleed backdrop and wrong for anything the
      // layout positioned, so the layouts place what they place.
      const unplaced = scene().elements.filter((el) => el.desktop === undefined);
      expect(unplaced.map((el) => el.id)).toEqual([]);
    });

    it("keeps every part inside the wide canvas", () => {
      for (const el of scene().elements) {
        const b = wide(el);
        if (b === null) continue;
        expect(b.x, el.id).toBeGreaterThanOrEqual(0);
        expect(b.y, el.id).toBeGreaterThanOrEqual(0);
        expect(b.x + b.w, el.id).toBeLessThanOrEqual(UI_DESKTOP_W);
        expect(b.y + b.h, el.id).toBeLessThanOrEqual(UI_DESKTOP_H);
      }
    });

    it("still has a transcript and a composer, and nothing sitting on them", () => {
      const page = scene();
      const list = page.elements.find((el) => el.type === "messages")!;
      const composer = page.elements.find((el) => el.type === "composer")!;
      const box = wide(list)!;
      const cbox = wide(composer)!;
      expect(box.w, "the transcript is not a sliver").toBeGreaterThan(400);
      expect(box.h).toBeGreaterThan(200);
      expect(cbox.y + cbox.h).toBeLessThanOrEqual(UI_DESKTOP_H);

      const over = page.elements.filter((el) => {
        if (el.id === list.id) return false;
        const b = wide(el);
        // A rail is a ground the conversation sits beside, not on: it is
        // allowed to be large, it just may not cover the words.
        if (b === null || el.id === "tpl-rail") return false;
        return b.x < box.x + box.w && box.x < b.x + b.w && b.y < box.y + box.h && box.y < b.y + b.h;
      });
      expect(over.map((el) => el.id)).toEqual([]);
    });

    it("does not let two labelled things sit on top of each other", () => {
      // Backdrops, scrims and rails are MEANT to be under things. Everything
      // else on the wide canvas was placed by hand from one edge or another,
      // and two runs of hand placement meeting in the middle is exactly how
      // "第 12 天 · 黄昏" ended up underneath a meter.
      const page = scene();
      const GROUND = /^(tpl-rail|tpl-hud|tpl-portrait|tpl-art-|tpl-portrait-empty)/;
      const placed = page.elements
        .filter((el) => !GROUND.test(el.id) && el.type !== "messages" && el.type !== "composer")
        .map((el) => ({ id: el.id, b: wide(el) }))
        .filter((e): e is { id: string; b: { x: number; y: number; w: number; h: number } } => e.b !== null);

      const clashes: string[] = [];
      for (let i = 0; i < placed.length; i++) {
        for (let j = i + 1; j < placed.length; j++) {
          const a = placed[i]!, c = placed[j]!;
          // A label sitting on its own meter's track is the group being a
          // group; only cross-group overlap is a mistake.
          const groupA = page.elements.find((el) => el.id === a.id)?.group;
          const groupB = page.elements.find((el) => el.id === c.id)?.group;
          if (groupA && groupA === groupB) continue;
          const hit = a.b.x < c.b.x + c.b.w && c.b.x < a.b.x + a.b.w
            && a.b.y < c.b.y + c.b.h && c.b.y < a.b.y + a.b.h;
          if (hit) clashes.push(`${a.id} × ${c.id}`);
        }
      }
      expect(clashes).toEqual([]);
    });

    it("uses the width it was given — a column down the middle is the bug this canvas exists to fix", () => {
      const page = scene();
      const rightmost = Math.max(...page.elements.map((el) => {
        const b = wide(el);
        return b === null ? 0 : b.x + b.w;
      }));
      expect(rightmost).toBeGreaterThan(UI_DESKTOP_W * 0.9);
    });
  });

  it("nothing overlaps the transcript, which is the part that has to be readable", () => {
    const page = scene();
    const list = page.elements.find((el) => el.type === "messages")!;
    const overlapping = page.elements.filter((el) =>
      el.id !== list.id &&
      el.x < list.x + list.w && list.x < el.x + el.w &&
      el.y < list.y + list.h && list.y < el.y + el.h);
    expect(overlapping.map((el) => el.id)).toEqual([]);
  });

  it("binds only to variables it declared — a stray id is a meter frozen for ever", () => {
    const declared = new Set(template.needs.map((need) => `v-${need.key}`));
    const referenced = new Set<string>();
    JSON.stringify(build(), (key, value) => {
      if (key === "variableId" && typeof value === "string") referenced.add(value);
      if (key === "template" && typeof value === "string") {
        for (const match of value.matchAll(/\{\{([^}]+)\}\}/g)) {
          const id = match[1]!.trim();
          // `item` and `index` are a list row's own macros, resolved per row
          // before the variable pass — not names anybody has to declare.
          if (id === "index" || id === "item" || id.startsWith("item.")) continue;
          referenced.add(id);
        }
      }
      return value;
    });
    expect([...referenced].filter((id) => !declared.has(id))).toEqual([]);
  });

  it("uses every variable it asks the creator to accept", () => {
    // The mirror of the test above, and the one that catches waste: a layout
    // that declares a need it never binds adds a variable to somebody's card
    // for nothing.
    const serialized = JSON.stringify(build());
    for (const need of template.needs) {
      expect(serialized, `${template.id} declares ${need.key} but never binds it`).toContain(`v-${need.key}`);
    }
  });

  it("names white as INK only where it brings its own dark ground with it", () => {
    // A themed word is drawn in --yc-text, which is near-black under 素纸, so a
    // literal white word is a word that disappears on cream. The one exception
    // is glass: a translucent dark plate ON the art, whose white text is
    // legible precisely because the plate is under it.
    //
    // "Ink" is the colour an element's TEXT is drawn in. It has to be named per
    // element type rather than found by walking the object, because a gradient
    // stop and a shadow both have a field called `color` too — and those are
    // light, not words.
    const inkOf = (el: UiElement): string | undefined =>
      el.type === "text" ? el.style?.color
      : el.type === "button" ? el.style?.textColor
      : el.type === "list" ? el.textStyle?.color
      : undefined;

    const WHITE = /255\s*,\s*255\s*,\s*255|#fff(?:fff)?\b/i;
    const isWhite = (value: string | undefined): value is string =>
      typeof value === "string" && WHITE.test(value) && !value.startsWith("var(");
    const isGlass = (el: UiElement) => JSON.stringify("style" in el ? el.style : null).includes("rgba(12,12,16");
    const covers = (plate: UiElement, el: UiElement) =>
      plate.x <= el.x && plate.y <= el.y &&
      plate.x + plate.w >= el.x + el.w && plate.y + plate.h >= el.y + el.h;

    for (const page of build().pages) {
      const plates = page.elements.filter(isGlass);
      for (const el of page.elements) {
        const ink = inkOf(el);
        if (!isWhite(ink)) continue;
        expect(
          plates.some((plate) => covers(plate, el)),
          `${el.id} writes in white (${ink}) with no glass plate under it`,
        ).toBe(true);
      }
    }
  });

  it("keeps every other white faint enough to be light rather than paint", () => {
    // Sheen cannot make anything vanish — there is nothing under it but colour.
    // But that is only true while it stays faint: a 60%-white "highlight" over
    // 素纸's deep green is a wash that takes the theme's accent with it.
    const WHITE = /255\s*,\s*255\s*,\s*255/;
    const alphaOf = (value: string) => {
      const rgba = /rgba?\([^)]*?,\s*([\d.]+)\s*\)/.exec(value);
      return rgba ? Number(rgba[1]) : 1;
    };
    // A `var(--yc-name, rgba(255,255,255,0.55))` is a TOKEN with a fallback.
    // The fallback is what happens when a card has no theme at all; it is not
    // a colour this layout paints, so the scan drops everything inside var().
    const stripVars = (text: string) => {
      let out = "";
      let depth = 0;
      for (let i = 0; i < text.length; i++) {
        if (depth === 0 && text.startsWith("var(", i)) { depth = 1; i += 3; continue; }
        if (depth > 0) {
          if (text[i] === "(") depth++;
          else if (text[i] === ")") depth--;
          continue;
        }
        out += text[i];
      }
      return out;
    };

    for (const page of build().pages) {
      for (const el of page.elements) {
        const paint = stripVars(JSON.stringify("style" in el ? el.style : null));
        for (const match of paint.matchAll(/rgba?\([^)]*\)/g)) {
          const value = match[0];
          if (!WHITE.test(value)) continue;
          expect(alphaOf(value), `${el.id} paints ${value}`).toBeLessThanOrEqual(0.25);
        }
      }
    }
  });

  it("carries a theme through unchanged — picking a layout is not a colour edit", () => {
    const theme = buildUiTheme({ id: "blossom", accent: "#8fd6c0" })!;
    expect(build({ theme }).theme).toEqual(theme);
  });

  it("compiles to a card that renders the platform's own chat", () => {
    const code = compileUiDoc(build()).files["index.tsx"]!;
    expect(code).toContain("MessageList");
    expect(code).toContain("MessageInput");
    expect(code).toContain("api.sendMessage");
    expect(code).toContain(`data-ui-el="${template.signature}"`);
  });

  it("puts the conversation's own controls on the card", () => {
    // regenerate / copy / rewind have always existed on the bubble toolbar,
    // behind a hover a player on a touch screen never performs. A layout that
    // does not surface them ships a card whose controls are invisible.
    const kinds = scene().elements
      .filter((el) => el.type === "button")
      .flatMap((el) => (el.type === "button" ? el.actions.map((a) => a.kind) : []));
    for (const kind of ["rewind", "regenerate", "copy-message"]) {
      expect(kinds, `${template.id} offers no ${kind}`).toContain(kind);
    }
  });

  it("leaves no macro slot unfilled", () => {
    // `{day}` reaching the player means the fill step missed a key — the card
    // shows a brace instead of a number, on the surface a creator never checks.
    const composed: string[] = [];
    JSON.stringify(build(), (key, value) => {
      if (key === "template" && typeof value === "string") composed.push(value);
      return value;
    });
    for (const text of composed) {
      expect(text.replace(/\{\{[^}]*\}\}/g, ""), text).not.toMatch(/\{[A-Za-z]/);
    }
  });

  describe("its second page", () => {
    it("exists, and the way in points at it", () => {
      const doc = build();
      expect(doc.pages.map((p) => p.id)).toEqual(["page-1", "page-details"]);
      expect(doc.entryPageId).toBe("page-1");
      const open = doc.pages[0]!.elements.find((el) => el.id === "tpl-details-open")!;
      expect(open.type === "button" && open.actions).toEqual([{ kind: "go-page", pageId: "page-details" }]);
    });

    it("every go-page names a page that exists — a dead end is a card the player is stuck in", () => {
      const doc = build();
      const ids = new Set(doc.pages.map((p) => p.id));
      const targets: string[] = [];
      JSON.stringify(doc, (key, value) => {
        if (key === "pageId" && typeof value === "string") targets.push(value);
        return value;
      });
      expect(targets.length).toBeGreaterThan(0);
      expect(targets.filter((id) => !ids.has(id))).toEqual([]);
    });

    it("can always be left", () => {
      const back = build().pages[1]!.elements.filter(
        (el) => el.type === "button" && el.actions.some((a) => a.kind === "go-page" && a.pageId === "page-1"),
      );
      expect(back.length).toBeGreaterThan(0);
    });

    it("explains an empty list instead of showing an empty box", () => {
      for (const el of build().pages[1]!.elements) {
        if (el.type !== "list") continue;
        expect(el.emptyText?.template, el.id).toBeTruthy();
        // The compiler's default row colour is a literal white, invisible on 素纸.
        expect(el.textStyle?.color, el.id).toMatch(/^var\(--yc-/);
      }
    });
  });
});

describe("the set as a whole", () => {
  it("gives every layout a signature no other layout installs", () => {
    for (const { template, doc } of buildAll()) {
      const mine = new Set(allIds(doc));
      expect(mine, template.id).toContain(template.signature);
      for (const other of buildAll()) {
        if (other.template.id === template.id) continue;
        expect(
          allIds(other.doc).includes(template.signature),
          `${other.template.id} also installs ${template.id}'s signature ${template.signature}`,
        ).toBe(false);
      }
    }
  });

  it("is round-trippable: every built document reports the layout that built it", () => {
    for (const { template, doc } of buildAll()) {
      expect(detectUiTemplate(doc), template.id).toBe(template.id);
    }
  });

  it("shares variable keys, so switching layouts does not collect a second 好感度", () => {
    // Two layouts that both track affection must ask for it under the SAME key,
    // because the store matches on the name a key resolves to.
    const byKey = new Map<string, string>();
    for (const template of UI_TEMPLATES) {
      for (const need of template.needs) {
        const seen = byKey.get(need.key);
        if (seen) expect(seen, `${need.key} is ${seen} in one layout and ${need.type} in ${template.id}`).toBe(need.type);
        else byKey.set(need.key, need.type);
      }
    }
    expect(byKey.size).toBeGreaterThan(0);
  });

  it("fades art into the page with a COLOUR, not the gradient two themes paint their ground with", () => {
    // `--yc-bg` is `linear-gradient(...)` under 夜色 and 花信. Substituted into a
    // colour stop it voids the whole declaration and the fade silently does not
    // happen — the art just ends on a hard edge.
    for (const { template, doc } of buildAll()) {
      const json = JSON.stringify(doc);
      expect(json, template.id).not.toContain("var(--yc-bg,");
      expect(json, template.id).not.toContain("var(--yc-bg)");
    }
    for (const theme of UI_THEMES) {
      expect(buildUiTheme({ id: theme.id })!.tokens!["--yc-bg-solid"], theme.id).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe("fillTemplateMacros", () => {
  it("binds a shipped string to the ids it was given", () => {
    expect(fillTemplateMacros("Day {day} · {timeOfDay}", { day: "v1", timeOfDay: "v2" }))
      .toBe("Day {{v1}} · {{v2}}");
  });

  it("leaves a slot it has no variable for alone, rather than emitting an empty macro", () => {
    expect(fillTemplateMacros("Day {day} · {weather}", { day: "v1" })).toBe("Day {{v1}} · {weather}");
  });

  it("does not touch a macro that is already written out", () => {
    expect(fillTemplateMacros("{{already}}", { already: "v1" })).toBe("{{already}}");
  });
});

describe("detectUiTemplate", () => {
  it("says nothing about a document that has no layout in it", () => {
    expect(detectUiTemplate(undefined)).toBe(null);
    expect(detectUiTemplate({ version: 1, entryPageId: "page-1", pages: [{ id: "page-1", name: "Main", height: 812, elements: [] }] })).toBe(null);
  });

  it("names the layout for a document that still carries its signature after edits", () => {
    const template = getUiTemplate("portrait-scene")!;
    const doc = template.build(inputFor(template));
    // A creator deletes the openers and drags the meters around; the picker
    // still has to light up the layout they started from.
    doc.pages[0]!.elements = doc.pages[0]!.elements.filter((el) => !el.id.startsWith("tpl-action-"));
    expect(detectUiTemplate(doc)).toBe("portrait-scene");
  });
});

describe("a layout's ground is painted under its words", () => {
  // A full-height box listed after the title painted over it: the card's name
  // vanished on the wide canvas of 养成面板 and 角色卡.
  it.each(UI_TEMPLATES.map((t) => [t.id, t] as const))("%s", (_id, template) => {
    for (const page of template.build(inputFor(template)).pages) {
      const order = [...page.elements].map((el, i) => ({ el, i })).sort((a, b) => (a.el.z ?? 0) - (b.el.z ?? 0) || a.i - b.i);
      const wide = (el: UiElement) => (el.desktop === null ? null : el.desktop ?? { x: el.x, y: el.y, w: el.w, h: el.h });
      order.forEach(({ el }, rank) => {
        const g = wide(el);
        if (el.type !== "box" || !g || g.h < UI_DESKTOP_H * 0.9) return;
        for (const { el: over } of order.slice(0, rank)) {
          const b = wide(over);
          if (over.type !== "text" || !b) continue;
          const inside = b.x >= g.x && b.x + b.w <= g.x + g.w && b.y >= g.y && b.y + b.h <= g.y + g.h;
          expect(inside, `${over.id} is under ${el.id} on ${page.id}`).toBe(false);
        }
      });
    }
  });
});
