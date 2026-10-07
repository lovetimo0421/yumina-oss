import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { boxOn, UI_TEMPLATES } from "@yumina/engine";
import type { UiElement } from "@yumina/engine";

/**
 * The layouts are laid out in numbers; the words arrive later, from five
 * locale files, and a text element CLIPS at its box — `overflow: hidden`, no
 * ellipsis, no scrollbar. A sentence that does not fit is therefore not "a bit
 * tight": it is half a sentence, with nothing on screen saying there was more.
 *
 * That is how the portrait layout's empty state shipped reading
 * "这里放立绘 — 在「卡片信息」里传一张，或用「立绘」" and stopping there: 20px of
 * height for a line and a half of Chinese, on the first thing a new creator
 * sees after picking the most-picked layout.
 *
 * So: build every layout with every locale's real strings, and check the words
 * fit the box they were given, on both canvases.
 */

const LANGS = ["zh", "en", "ja", "es", "zh-Hant"] as const;
type Layout = Record<string, Record<string, Record<string, string>>>;

const localeLayout = (lang: string): Layout =>
  JSON.parse(readFileSync(`src/locales/${lang}/editor.json`, "utf-8")).studio.layout;

/**
 * Rough advance width per character, as a multiple of the font size.
 *
 * Calibrated against what Chromium reported for these same layouts — the
 * scrollWidth and scrollHeight of every `[data-ui-el]`, five locales, both
 * canvases — so that it agrees with the browser about the one string that
 * really wrapped and about the near misses that did not: "Regenerate" in a
 * 74px button is a fit, "Somewhere unnamed" in a 139px chip is not.
 */
function estimateWidth(text: string, size: number): number {
  let units = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code === 0x20 || code === 0xa0) units += 0.28;
    else if (
      // CJK, kana, hangul, fullwidth forms, CJK punctuation — all square.
      (code >= 0x2e80 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0x3000 && code <= 0x303f)
    ) units += 1;
    else if (/[·.,:;!|'()[\]-]/.test(ch)) units += 0.30;
    else if (/[filjtrI]/.test(ch)) units += 0.34;
    else if (/[mw]/.test(ch)) units += 0.80;
    else if (/[MW]/.test(ch)) units += 0.88;
    else if (/[A-Z]/.test(ch)) units += 0.64;
    else units += 0.50;
  }
  return units * size;
}

/** Copy with a runtime value in it can be any length; only fixed words are
 *  something a test can hold to a size. */
const isFixed = (text: string) => !text.includes("{{");

interface Words { text: string; size: number; desktopSize?: number; lineHeight: number; pad: number }

function wordsOf(el: UiElement): Words | null {
  if (el.type === "text" && el.text?.template && isFixed(el.text.template)) {
    // `nowrap` text cannot lose a line: it ends in an ellipsis the reader can
    // see, which is the entire point of the flag.
    if (el.style?.nowrap) return null;
    return {
      text: el.text.template,
      size: el.style?.size ?? 14,
      desktopSize: el.style?.desktopSize,
      lineHeight: el.style?.lineHeight ?? 1.5,
      pad: 0,
    };
  }
  if (el.type === "button" && el.label?.template && isFixed(el.label.template)) {
    // A button's label sits inside the UA's own 6px of horizontal padding.
    return {
      text: el.label.template,
      size: el.style?.size ?? 14,
      desktopSize: el.style?.desktopSize,
      lineHeight: 1.3,
      pad: 12,
    };
  }
  return null;
}

for (const lang of LANGS) {
  const layout = localeLayout(lang);
  for (const template of UI_TEMPLATES) {
    test(`the ${template.id} layout holds its ${lang} words`, () => {
      const strings: Record<string, string> = { title: "月下的旅店" };
      for (const key of template.stringKeys) {
        const word = layout.s.common?.[key] ?? layout.s[template.id]?.[key] ?? "";
        assert.notEqual(word, "", `${lang} is missing studio.layout.s.*.${key} for ${template.id}`);
        strings[key] = word;
      }
      const variableIds = Object.fromEntries(template.needs.map((need) => [need.key, `v-${need.key}`]));
      const doc = template.build({ strings, variableIds });

      const problems: string[] = [];
      for (const page of doc.pages) {
        for (const el of page.elements) {
          const words = wordsOf(el);
          if (!words) continue;
          for (const canvas of ["phone", "desktop"] as const) {
            const box = boxOn(el, canvas);
            if (!box) continue;
            const size = (canvas === "desktop" ? words.desktopSize : undefined) ?? words.size;
            const usable = Math.max(1, box.w - words.pad);
            const lines = Math.max(1, Math.ceil(estimateWidth(words.text, size) / usable));
            // One line is never lost to a box shorter than its line-height: the
            // line box overflows evenly and the glyphs, about 1em tall, stay
            // whole. It is the SECOND line that disappears without a trace, so
            // that is where the measure changes.
            // A line box taller than its element is clipped by `overflow:
            // hidden`, so the rule is simply that the line box has to fit.
            // Buttons are the exception: the UA centres their label and lets
            // it spill evenly, so only a second line actually disappears.
            const needed = el.type === "button"
              ? (lines === 1 ? size * 1.05 : lines * size * words.lineHeight)
              : lines * size * words.lineHeight;
            if (needed > box.h + 0.5) {
              problems.push(
                `${el.id} on ${canvas}: "${words.text}" wants ${lines} line(s) ` +
                `≈${Math.ceil(needed)}px at ${size}px, box is ${box.h}px (width ${box.w})`,
              );
            }
          }
        }
      }
      assert.deepEqual(problems, [], `\n${problems.join("\n")}\n`);
    });
  }
}
