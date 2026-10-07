import { describe, expect, it } from "vitest";
import {
  METER_ROW_H, addMeterRow, boundVariableOf, canReflow, fillColorOf, findElementPage,
  groupOf, rebindVariable, removeGroup, updateElements, withFillColor, duplicateGroup,
} from "../edit.js";
import { validateUiDoc } from "../schema.js";
import { UI_TEMPLATES, getUiTemplate } from "../templates.js";
import { boxOn } from "../edit.js";
import { UI_DESKTOP_H, UI_DESKTOP_W } from "../types.js";
import type { UiDoc, UiElement } from "../types.js";

const template = getUiTemplate("portrait-scene")!;
const input = () => {
  const strings: Record<string, string> = { title: "Lin Zhou" };
  for (const key of template.stringKeys) strings[key] = `word:${key}`;
  const variableIds: Record<string, string> = {};
  for (const need of template.needs) variableIds[need.key] = `v-${need.key}`;
  return { strings, variableIds };
};
const doc = () => template.build(input());
const page = (d: UiDoc) => d.pages[0]!;
const byId = (d: UiDoc, id: string) => page(d).elements.find((el) => el.id === id);
const transcript = (d: UiDoc) => page(d).elements.find((el) => el.type === "messages")!;

describe("groups", () => {
  it("treats a meter's label, value and track as one thing", () => {
    const ids = groupOf(doc(), "page-1", "tpl-meter-1");
    expect(ids.sort()).toEqual(["tpl-meter-1", "tpl-meter-1-label", "tpl-meter-1-value"]);
  });

  it("finds the same group from any part of it", () => {
    const d = doc();
    expect(groupOf(d, "page-1", "tpl-meter-1-label").sort()).toEqual(groupOf(d, "page-1", "tpl-meter-1").sort());
  });

  it("leaves an ungrouped element as its own unit", () => {
    expect(groupOf(doc(), "page-1", "tpl-messages")).toEqual(["tpl-messages"]);
  });

  it("does not confuse two meters on the same page", () => {
    const first = groupOf(doc(), "page-1", "tpl-meter-1");
    expect(first).not.toContain("tpl-meter-2");
  });

  it("says nothing about an element that is not there", () => {
    expect(groupOf(doc(), "page-1", "nope")).toEqual([]);
    expect(findElementPage(doc(), "nope")).toBe(null);
  });

  it("locates an element's page, including the second one", () => {
    expect(findElementPage(doc(), "tpl-meter-1")).toBe("page-1");
    expect(findElementPage(doc(), "tpl-d-list")).toBe("page-details");
  });
});

describe("colour edits", () => {
  it("replaces the colour a stack paints without dropping the rest of it", () => {
    const fills = withFillColor([{ kind: "color", color: "#111" }, { kind: "gradient", stops: [] }], "#f00");
    expect(fills[0]).toEqual({ kind: "color", color: "#f00" });
    expect(fills).toHaveLength(2);
    expect(fills[1]!.kind).toBe("gradient");
  });

  it("adds one when the element was painted with something else entirely", () => {
    const fills = withFillColor([{ kind: "gradient", stops: [] }], "#f00");
    expect(fills[0]).toEqual({ kind: "color", color: "#f00" });
    expect(fills).toHaveLength(2);
  });

  it("reads back what the panel should show as current, token and all", () => {
    expect(fillColorOf([{ kind: "color", color: "var(--yc-send-bg)" }])).toBe("var(--yc-send-bg)");
    expect(fillColorOf([{ kind: "gradient", stops: [] }])).toBe(null);
    expect(fillColorOf(undefined)).toBe(null);
  });

  it("recolours a whole meter through updateElements and touches nothing else", () => {
    const before = doc();
    const ids = groupOf(before, "page-1", "tpl-meter-1");
    const after = updateElements(before, "page-1", ids, (el) =>
      el.type === "meter" ? { ...el, style: { ...el.style, fills: withFillColor(el.style?.fills, "#7ad0a1") } } : el);

    const meter = byId(after, "tpl-meter-1")!;
    expect(meter.type === "meter" && fillColorOf(meter.style?.fills)).toBe("#7ad0a1");
    // The other meter keeps the theme's accent.
    const other = byId(after, "tpl-meter-2")!;
    expect(other.type === "meter" && fillColorOf(other.style?.fills)).toMatch(/^var\(--yc-send-bg/);
    expect(validateUiDoc(after).ok).toBe(true);
  });
});

describe("adding a meter row", () => {
  const added = () => addMeterRow(doc(), "page-1", { id: "m-new", label: "Trust", variableId: "v-trust" });

  it("produces a document the compiler still accepts", () => {
    const result = validateUiDoc(added());
    expect(result.ok, result.ok ? "" : result.errors.join("; ")).toBe(true);
  });

  it("arrives as a labelled row bound to the variable it was given", () => {
    const d = added();
    const meter = byId(d, "m-new")!;
    expect(meter.type).toBe("meter");
    expect(meter.type === "meter" && meter.value).toMatchObject({ kind: "variable", variableId: "v-trust" });
    expect(byId(d, "m-new-label")!.type === "text" && byId(d, "m-new-label")).toMatchObject({ text: { template: "Trust" } });
    expect(groupOf(d, "page-1", "m-new").sort()).toEqual(["m-new", "m-new-label", "m-new-value"]);
  });

  it("wears the theme's accent unless told otherwise", () => {
    const meter = byId(added(), "m-new")!;
    expect(meter.type === "meter" && fillColorOf(meter.style?.fills)).toMatch(/^var\(--yc-send-bg/);
    const red = addMeterRow(doc(), "page-1", { id: "m2", label: "L", variableId: "v", color: "#e05" });
    const m2 = byId(red, "m2")!;
    expect(m2.type === "meter" && fillColorOf(m2.style?.fills)).toBe("#e05");
  });

  it("lands under the meters already there rather than on top of them", () => {
    const d = added();
    const existing = page(d).elements.filter((el) => el.type === "meter" && el.id !== "m-new");
    const lowest = Math.max(...existing.map((el) => el.y + el.h));
    expect(byId(d, "m-new-label")!.y).toBeGreaterThan(lowest);
  });

  it("takes the space out of the transcript, so the composer does not move", () => {
    const before = doc();
    const after = addMeterRow(before, "page-1", { id: "m-new", label: "Trust", variableId: "v-trust" });
    const b = transcript(before);
    const a = transcript(after);
    expect(a.y).toBe(b.y + METER_ROW_H);
    expect(a.h).toBe(b.h - METER_ROW_H);
    expect(a.y + a.h).toBe(b.y + b.h);

    for (const id of ["tpl-composer", "tpl-action-look"]) {
      expect(byId(after, id)!.y, id).toBe(byId(before, id)!.y);
    }
  });

  it("keeps every element on the page", () => {
    const d = added();
    for (const el of page(d).elements) {
      expect(el.y, el.id).toBeGreaterThanOrEqual(0);
      expect(el.y + el.h, el.id).toBeLessThanOrEqual(page(d).height);
    }
  });

  it("stacks: three added rows sit one under the other", () => {
    let d = doc();
    for (const id of ["a", "b", "c"]) d = addMeterRow(d, "page-1", { id, label: id, variableId: `v-${id}` });
    const ys = ["a", "b", "c"].map((id) => byId(d, id)!.y);
    expect(ys[0]).toBeLessThan(ys[1]!);
    expect(ys[1]).toBeLessThan(ys[2]!);
    expect(validateUiDoc(d).ok).toBe(true);
  });

  it("refuses to squeeze the transcript out of existence", () => {
    let d = doc();
    // Keep adding until the transcript would be too short to read.
    while (canReflow(d, "page-1", METER_ROW_H)) {
      d = addMeterRow(d, "page-1", { id: `m${transcript(d).h}`, label: "x", variableId: "v-x" });
    }
    expect(transcript(d).h).toBeGreaterThanOrEqual(80);
  });

  it("places the new row on the WIDE canvas too, in the column its neighbours are in", () => {
    // Without a desktop box the row inherits the phone's coordinates, which on
    // a divided layout means landing across whatever the desktop put at x=18 —
    // a rail, a portrait, the edge of the screen.
    const d = added();
    const track = byId(d, "m-new")!;
    const wide = boxOn(track, "desktop")!;
    const neighbour = boxOn(byId(d, "tpl-meter-1")!, "desktop")!;
    expect(wide.x).toBe(neighbour.x);
    expect(wide.w).toBe(neighbour.w);
    expect(wide.y).toBeGreaterThan(neighbour.y);
    expect(wide.x + wide.w).toBeLessThanOrEqual(UI_DESKTOP_W);
    expect(wide.y + wide.h).toBeLessThanOrEqual(UI_DESKTOP_H);
  });

  it("opens the gap on both canvases, each at its own insertion point", () => {
    const before = doc();
    const after = addMeterRow(before, "page-1", { id: "m-new", label: "Trust", variableId: "v-trust" });
    for (const canvas of ["phone", "desktop"] as const) {
      const b = boxOn(transcript(before), canvas)!;
      const a = boxOn(transcript(after), canvas)!;
      expect(a.y, canvas).toBe(b.y + METER_ROW_H);
      expect(a.h, canvas).toBe(b.h - METER_ROW_H);
      expect(a.y + a.h, `${canvas}: the composer does not move`).toBe(b.y + b.h);
    }
  });

  it("grows the panel the meters live inside, on whichever canvas has one", () => {
    // 冒险状态 draws its figures on a card. A row added to it used to hang off
    // the bottom of that card, outside the frame it belongs to.
    const hud = getUiTemplate("adventure-hud")!;
    const strings: Record<string, string> = { title: "T" };
    for (const key of hud.stringKeys) strings[key] = key.endsWith("Format") ? "{day}" : "w";
    const variableIds = Object.fromEntries(hud.needs.map((need) => [need.key, `v-${need.key}`]));
    const before = hud.build({ strings, variableIds });
    const after = addMeterRow(before, "page-1", { id: "m-new", label: "Trust", variableId: "v-trust" });

    const panelOf = (d: UiDoc) => d.pages[0]!.elements.find((el) => el.id === "tpl-hud")!;
    for (const canvas of ["phone", "desktop"] as const) {
      const b = boxOn(panelOf(before), canvas)!;
      const a = boxOn(panelOf(after), canvas)!;
      expect(a.h, canvas).toBe(b.h + METER_ROW_H);

      // And the new row is actually inside it.
      const row = boxOn(after.pages[0]!.elements.find((el) => el.id === "m-new")!, canvas)!;
      expect(row.y + row.h, `${canvas}: the row sits inside its panel`).toBeLessThanOrEqual(a.y + a.h);
    }
  });

  it("leaves a full-height rail alone — it already has room", () => {
    const stat = getUiTemplate("stat-panel")!;
    const strings: Record<string, string> = { title: "T" };
    for (const key of stat.stringKeys) strings[key] = key.endsWith("Format") ? "{day}" : "w";
    const variableIds = Object.fromEntries(stat.needs.map((need) => [need.key, `v-${need.key}`]));
    const before = stat.build({ strings, variableIds });
    const after = addMeterRow(before, "page-1", { id: "m-new", label: "T", variableId: "v-t" });
    const rail = (d: UiDoc) => boxOn(d.pages[0]!.elements.find((el) => el.id === "tpl-rail")!, "desktop")!;
    expect(rail(after).h).toBe(rail(before).h);
    expect(rail(after).y + rail(after).h).toBeLessThanOrEqual(UI_DESKTOP_H);
  });

  it("does nothing for a page that is not there", () => {
    expect(addMeterRow(doc(), "nope", { id: "x", label: "x", variableId: "v" })).toEqual(doc());
  });
});

describe("removing a group", () => {
  it("takes every part of the meter, not just the one that was clicked", () => {
    const before = doc();
    const after = removeGroup(before, "page-1", groupOf(before, "page-1", "tpl-meter-1"));
    for (const id of ["tpl-meter-1", "tpl-meter-1-label", "tpl-meter-1-value"]) {
      expect(byId(after, id), id).toBeUndefined();
    }
    expect(byId(after, "tpl-meter-2")).toBeDefined();
    expect(validateUiDoc(after).ok).toBe(true);
  });

  it("gives the space back to the transcript, exactly reversing an add", () => {
    const before = doc();
    const added = addMeterRow(before, "page-1", { id: "m-new", label: "Trust", variableId: "v-trust" });
    const removed = removeGroup(added, "page-1", groupOf(added, "page-1", "m-new"));
    expect(transcript(removed).y).toBe(transcript(before).y);
    expect(transcript(removed).h).toBe(transcript(before).h);
  });

  it("leaves a composition alone — deleting the portrait does not slide the card up", () => {
    const before = doc();
    const after = removeGroup(before, "page-1", groupOf(before, "page-1", "tpl-portrait"));
    expect(byId(after, "tpl-portrait")).toBeUndefined();
    expect(byId(after, "tpl-portrait-empty")).toBeUndefined();
    expect(transcript(after).y).toBe(transcript(before).y);
    expect(byId(after, "tpl-title")!.y).toBe(byId(before, "tpl-title")!.y);
  });

  it("does not drag a side-by-side neighbour upwards", () => {
    // 立绘对话 puts two meters on one row. Deleting the left one empties half
    // the row and frees no vertical space — reclaiming it slid the survivor up
    // into the details button, which is what this pins.
    const before = doc();
    const survivorY = byId(before, "tpl-meter-2")!.y;
    const after = removeGroup(before, "page-1", groupOf(before, "page-1", "tpl-meter-1"));

    expect(byId(after, "tpl-meter-2")!.y).toBe(survivorY);
    expect(byId(after, "tpl-meter-2-label")!.y).toBe(byId(before, "tpl-meter-2-label")!.y);
    expect(transcript(after).y).toBe(transcript(before).y);
    expect(transcript(after).h).toBe(transcript(before).h);
  });

  it("reclaims the row once the last meter on it goes", () => {
    const before = doc();
    let d = removeGroup(before, "page-1", groupOf(before, "page-1", "tpl-meter-1"));
    d = removeGroup(d, "page-1", groupOf(d, "page-1", "tpl-meter-2"));
    expect(transcript(d).y).toBe(transcript(before).y - METER_ROW_H);
    expect(transcript(d).h).toBe(transcript(before).h + METER_ROW_H);
  });

  it("closes the gap on both canvases when the row goes", () => {
    const before = doc();
    const added = addMeterRow(before, "page-1", { id: "m-new", label: "Trust", variableId: "v-trust" });
    const removed = removeGroup(added, "page-1", groupOf(added, "page-1", "m-new"));
    for (const canvas of ["phone", "desktop"] as const) {
      const b = boxOn(transcript(before), canvas)!;
      const a = boxOn(transcript(removed), canvas)!;
      expect(a.y, canvas).toBe(b.y);
      expect(a.h, canvas).toBe(b.h);
    }
  });

  it("judges side-by-side per canvas — a pair on one may be a stack on the other", () => {
    // 立绘对话 puts its two meters side by side on BOTH canvases, so deleting
    // one frees nothing on either. The point is that the question is asked
    // twice rather than answered once from the phone's geometry.
    const before = doc();
    const after = removeGroup(before, "page-1", groupOf(before, "page-1", "tpl-meter-1"));
    for (const canvas of ["phone", "desktop"] as const) {
      const b = boxOn(transcript(before), canvas)!;
      const a = boxOn(transcript(after), canvas)!;
      expect(a.y, canvas).toBe(b.y);
      expect(boxOn(byId(after, "tpl-meter-2")!, canvas)!.y, canvas)
        .toBe(boxOn(byId(before, "tpl-meter-2")!, canvas)!.y);
    }
  });

  it("does nothing when asked to remove what is not there", () => {
    expect(removeGroup(doc(), "page-1", ["nope"])).toEqual(doc());
  });
});

describe("duplicating a group", () => {
  it("copies every part, with fresh ids and a group of its own", () => {
    const before = doc();
    const ids = groupOf(before, "page-1", "tpl-meter-1");
    const after = duplicateGroup(before, "page-1", ids, "copy");

    // The original survives untouched.
    for (const id of ids) expect(byId(after, id), id).toBeDefined();
    const copies = page(after).elements.filter((el) => el.id.startsWith("copy-"));
    expect(copies).toHaveLength(ids.length);

    // …and the copy is its own unit, or selecting one would select six.
    const copyGroups = new Set(copies.map((el) => el.group));
    expect(copyGroups.size).toBe(1);
    expect([...copyGroups][0]).not.toBe(byId(after, "tpl-meter-1")!.group);
    expect(groupOf(after, "page-1", copies[0]!.id).sort()).toEqual(copies.map((el) => el.id).sort());
    expect(validateUiDoc(after).ok).toBe(true);
  });

  it("offsets the copy, so it does not look like nothing happened", () => {
    const after = duplicateGroup(doc(), "page-1", groupOf(doc(), "page-1", "tpl-meter-1"), "copy");
    const original = byId(after, "tpl-meter-1")!;
    const copy = page(after).elements.find((el) => el.id.startsWith("copy-") && el.type === "meter")!;
    expect(copy.x).toBeGreaterThan(original.x);
    expect(copy.y).toBeGreaterThan(original.y);
  });

  it("offsets on the canvas it was asked about, leaving the other alone", () => {
    const before = doc();
    const ids = groupOf(before, "page-1", "tpl-meter-1");
    const after = duplicateGroup(before, "page-1", ids, "copy", "desktop");
    const source = byId(after, "tpl-meter-1")!;
    const copy = page(after).elements.find((el) => el.id.startsWith("copy-") && el.type === "meter")!;
    expect(boxOn(copy, "desktop")!.x).toBeGreaterThan(boxOn(source, "desktop")!.x);
    expect(boxOn(copy, "phone")!.x).toBe(boxOn(source, "phone")!.x);
  });

  it("does nothing when there is nothing to copy", () => {
    expect(duplicateGroup(doc(), "page-1", [], "copy")).toEqual(doc());
    expect(duplicateGroup(doc(), "nope", ["tpl-meter-1"], "copy")).toEqual(doc());
  });
});

describe("variable binding", () => {
  it("reads back what each kind of element is bound to", () => {
    const d = doc();
    expect(boundVariableOf(byId(d, "tpl-meter-1")!)).toBe("v-affinity");
    expect(boundVariableOf(byId(d, "tpl-portrait")!)).toBe("v-portrait");
    expect(boundVariableOf(byId(d, "tpl-meter-1-value")!)).toBe("v-affinity");
    expect(boundVariableOf(byId(d, "tpl-messages")!)).toBe(null);
  });

  it("rebinds a meter, an image and a list", () => {
    const d = doc();
    const meter = rebindVariable(byId(d, "tpl-meter-1")!, "v-other");
    expect(meter.type === "meter" && meter.value).toMatchObject({ kind: "variable", variableId: "v-other" });
    const image = rebindVariable(byId(d, "tpl-portrait")!, "v-other");
    expect(image.type === "image" && image.src).toEqual({ kind: "variable", variableId: "v-other" });
  });

  it("swaps a macro in place, so a sentence around it survives", () => {
    const el: UiElement = { id: "t", type: "text", x: 0, y: 0, w: 10, h: 10, text: { template: "Day {{v-day}} · dusk" } };
    const next = rebindVariable(el, "v-new");
    expect(next.type === "text" && next.text.template).toBe("Day {{v-new}} · dusk");
  });

  it("gives a text element a macro when it had none", () => {
    const el: UiElement = { id: "t", type: "text", x: 0, y: 0, w: 10, h: 10, text: { template: "plain" } };
    expect(rebindVariable(el, "v-new").type === "text" && (rebindVariable(el, "v-new") as never as { text: { template: string } }).text.template).toBe("{{v-new}}");
  });

  it("leaves an element it cannot bind untouched", () => {
    const el = byId(doc(), "tpl-messages")!;
    expect(rebindVariable(el, "v-new")).toEqual(el);
  });
});

describe("every official layout", () => {
  it("groups its meters, so the panel can select one as a unit", () => {
    for (const preset of UI_TEMPLATES) {
      const strings: Record<string, string> = { title: "T" };
      for (const key of preset.stringKeys) strings[key] = key.endsWith("Format") ? "{day}" : "w";
      const variableIds = Object.fromEntries(preset.needs.map((need) => [need.key, `v-${need.key}`]));
      const built = preset.build({ strings, variableIds });
      for (const p of built.pages) {
        for (const el of p.elements) {
          if (el.type !== "meter") continue;
          expect(groupOf(built, p.id, el.id).length, `${preset.id}/${el.id}`).toBeGreaterThan(1);
        }
      }
    }
  });
});
