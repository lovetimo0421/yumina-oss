import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { filmText, ft, rawText, shortReason, shotStatus, type FilmT } from "./film-text";

const locales = ["en", "zh", "zh-Hant", "ja", "es"] as const;

function film(locale: string): Record<string, unknown> {
  const file = new URL(`../../../locales/${locale}/chat.json`, import.meta.url);
  return (JSON.parse(readFileSync(file, "utf8")) as { film: Record<string, unknown> }).film;
}

function leaves(o: Record<string, unknown>, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === "string") out.set(prefix + k, v);
    else for (const [kk, vv] of leaves(v as Record<string, unknown>, `${prefix}${k}.`)) out.set(kk, vv);
  }
  return out;
}

const vars = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();

test("every locale has the film window's words, with the same placeholders", () => {
  const en = leaves(film("en"));
  for (const locale of locales) {
    const other = leaves(film(locale));
    assert.deepEqual([...other.keys()].sort(), [...en.keys()].sort(), `${locale}: film keys differ from en`);
    for (const [key, value] of en) {
      const v = other.get(key)!;
      assert.ok(v.trim(), `${locale}: film.${key} is empty`);
      assert.deepEqual(vars(v), vars(value), `${locale}: film.${key} placeholders differ from en`);
    }
  }
});

test("the status and log words carry no Chinese outside the Chinese locales", () => {
  for (const locale of ["en", "ja", "es"]) {
    for (const [key, value] of leaves(film(locale))) {
      if (!/^(step|shotState|now|kind)\./.test(key)) continue;
      // Japanese shares kanji with Chinese: only reject the Simplified-only forms the old words used.
      const cjk = locale === "ja" ? /[镜头视频连发队币场]/ : /[一-鿿]/;
      assert.ok(!cjk.test(value), `${locale}: film.${key} = ${value}`);
    }
  }
});

/** A tiny i18next stand-in: looks the key up in one locale's chat.json and fills {{x}}. */
function tFor(locale: string): FilmT {
  const root = { film: film(locale) } as Record<string, unknown>;
  return (key, params) => {
    const template = key.split(".").reduce<unknown>((o, part) => (o as Record<string, unknown>)?.[part], root);
    assert.equal(typeof template, "string", `${locale}: missing ${key}`);
    return (template as string).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => String(params?.[name] ?? ""));
  };
}

test("filmText renders keys, nested words, names and parts in the viewer's language", () => {
  const en = tFor("en");
  const zh = tFor("zh");
  assert.equal(filmText(en, ft("step.streamConnected")), "Stream connected");
  assert.equal(filmText(zh, ft("step.streamConnected")), "视频流已连上");
  assert.equal(filmText(en, shotStatus("shown", "shotState.shownAfter", { secs: "10.2" })), "On screen · 10.2s");
  assert.equal(filmText(zh, shotStatus("shown", "shotState.shownAfter", { secs: "10.2" })), "画面已出 10.2s");
  assert.equal(filmText(zh, ft("now.playing", { reply: 3, n: 2, total: 4 })), "第 3 条回复 · 第 2/4 镜");
  assert.equal(filmText(en, ft("now.failed", { reason: shortReason("busy") })), "Not filmed: two films are already being made");
  assert.equal(filmText(zh, ft("step.newCast", { names: ["A", "B"] })), "新角色定妆：A、B");
  assert.equal(filmText(en, ft("step.newCast", { names: ["A", "B"] })), "New characters' looks set: A, B");
  const info = ft("shotState.clipInfoMore", { secs: "9.0", queued: "1", exec: "8", more: [ft("shotState.clipHold"), ft("shotState.clipRefs", { refs: "x" })] });
  assert.equal(filmText(zh, shotStatus("ready", "shotState.ready", { info })), "已生成，等待播放 · 9.0s 生成好（排队 1s · 生成 8s · 延长 · 参考 x）");
  const label = ft("step.directed", { secs: "1.5", n: 3 });
  assert.equal(filmText(zh, ft("step.turnShot", { label, n: 1, total: 3, how: ft("step.howSame") })), "导演 1.5s 拆成 3 镜 · 第 1/3 镜 · 同一场景");
  assert.equal(filmText(en, rawText("她回头看了你一眼。")), "她回头看了你一眼。");
  assert.equal(filmText(en, null), "");
});
