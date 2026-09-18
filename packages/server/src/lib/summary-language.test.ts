import assert from "node:assert/strict";
import { test } from "node:test";

async function loadModule() {
  return import("./summary-language.js");
}

test("normalizeSessionSummaryLanguage falls back to auto for anything unknown", async () => {
  const { normalizeSessionSummaryLanguage } = await loadModule();
  assert.equal(normalizeSessionSummaryLanguage("zh-Hans"), "zh-Hans");
  assert.equal(normalizeSessionSummaryLanguage("auto"), "auto");
  // null is what an untouched session row holds, and what every session held
  // before the column existed.
  assert.equal(normalizeSessionSummaryLanguage(null), "auto");
  assert.equal(normalizeSessionSummaryLanguage(undefined), "auto");
  assert.equal(normalizeSessionSummaryLanguage("klingon"), "auto");
  assert.equal(normalizeSessionSummaryLanguage(7), "auto");
});

test("auto mode tells the summarizer to follow the source text, not English", async () => {
  const { buildSummaryLanguageInstruction } = await loadModule();
  const instruction = buildSummaryLanguageInstruction("auto");
  assert.match(instruction, /same language as the source text/);
  assert.match(instruction, /Do not translate the story into English/);
  // No specific language may be named in auto mode — that would pin the output
  // to one language for every story.
  assert.doesNotMatch(instruction, /Simplified Chinese|Japanese|Spanish/);
});

test("an explicit language is named to the model, natively and in English", async () => {
  const { buildSummaryLanguageInstruction } = await loadModule();
  assert.match(buildSummaryLanguageInstruction("zh-Hans"), /Simplified Chinese \(简体中文\)/);
  assert.match(buildSummaryLanguageInstruction("zh-Hant"), /Traditional Chinese \(繁體中文\)/);
  assert.match(buildSummaryLanguageInstruction("ja"), /Japanese \(日本語\)/);
  // Explicit modes must override the source text, otherwise picking English
  // for a Chinese story would silently do nothing.
  assert.match(buildSummaryLanguageInstruction("en"), /regardless of the language of the source text/);
});

test("the do-not-translate-names rule holds in every mode", async () => {
  const { buildSummaryLanguageInstruction } = await loadModule();
  // This is the actual reported bug: names came back translated, then were
  // translated BACK differently on the next turn. It must survive even when
  // the summary language deliberately differs from the story's.
  for (const language of ["auto", "en", "zh-Hans", "ja"] as const) {
    const instruction = buildSummaryLanguageInstruction(language);
    assert.match(instruction, /Never translate, transliterate, or re-romanize a name/);
  }
});

test("keepEnglishHeadings is opt-in and only pins the skeleton", async () => {
  const { buildSummaryLanguageInstruction } = await loadModule();
  assert.doesNotMatch(buildSummaryLanguageInstruction("zh-Hans"), /Structure:/);
  const pinned = buildSummaryLanguageInstruction("zh-Hans", { keepEnglishHeadings: true });
  assert.match(pinned, /Structure: keep the section headings \/ field names exactly as this prompt specifies them, in English/);
  assert.match(pinned, /Only the content you write inside them follows the language rule/);
});

// ─── Deterministic detection (the 2026-09-01 follow-up report) ───────

const ZH_HANS_SAMPLE =
  "林清雪站在城墙上，看着远方的军队缓缓逼近。她知道这一战无法避免，还是握紧了手中的长剑。城里的人们已经开始撤离，但她说过要守到最后一刻。";
const ZH_HANT_SAMPLE =
  "林清雪站在城牆上,看著遠方的軍隊緩緩逼近。她知道這一戰無法避免,還是握緊了手中的長劍。城裡的人們已經開始撤離,但她說過要守到最後一刻。";
const JA_SAMPLE =
  "リンは城壁の上に立って、遠くから近づいてくる軍隊を見つめていた。この戦いは避けられないと知っていたが、それでも剣を握りしめた。街の人々はすでに避難を始めている。";
const KO_SAMPLE =
  "린은 성벽 위에 서서 멀리서 다가오는 군대를 바라보았다. 이 전투를 피할 수 없다는 것을 알았지만 그래도 검을 꽉 쥐었다.";
const RU_SAMPLE =
  "Лин стояла на городской стене и смотрела, как вдалеке медленно приближается армия. Она знала, что этой битвы не избежать, но всё равно крепче сжала меч.";
const EN_SAMPLE =
  "She stood on the wall and watched the army slowly approach from the distance. She knew that this battle could not be avoided, but they had promised to hold the line, and she was not going to break that promise.";

test("detectSummaryLanguageFromText identifies the CJK languages that were misfiring", async () => {
  const { detectSummaryLanguageFromText } = await loadModule();
  assert.equal(detectSummaryLanguageFromText(ZH_HANS_SAMPLE), "zh-Hans");
  assert.equal(detectSummaryLanguageFromText(ZH_HANT_SAMPLE), "zh-Hant");
  // Kanji-heavy Japanese must NOT be read as Chinese, and vice versa — "the
  // plot summary is sometimes even in Japanese" was the reported misfire.
  assert.equal(detectSummaryLanguageFromText(JA_SAMPLE), "ja");
  assert.equal(detectSummaryLanguageFromText(KO_SAMPLE), "ko");
  assert.equal(detectSummaryLanguageFromText(RU_SAMPLE), "ru");
  assert.equal(detectSummaryLanguageFromText(EN_SAMPLE), "en");
});

test("a quoted katakana name does not flip a Chinese story to Japanese", async () => {
  const { detectSummaryLanguageFromText } = await loadModule();
  const withKatakanaName = `${ZH_HANS_SAMPLE}她想起了朋友セバスチャン的警告。${ZH_HANS_SAMPLE}`;
  assert.equal(detectSummaryLanguageFromText(withKatakanaName), "zh-Hans");
});

test("detection refuses to guess on tiny or ambiguous samples", async () => {
  const { detectSummaryLanguageFromText } = await loadModule();
  assert.equal(detectSummaryLanguageFromText(""), null);
  assert.equal(detectSummaryLanguageFromText("ok 好"), null);
  // Latin script without a clear stopword winner (proper nouns only).
  assert.equal(detectSummaryLanguageFromText("Lin Qingxue Sebastian Aria Kael Voss Miro Talon Vesper Juno Idris Sable Rune Corvid Lyra Onyx"), null);
});

test("resolveSummaryOutputLanguage: user pick > detection > world hint > auto", async () => {
  const { resolveSummaryOutputLanguage } = await loadModule();
  // 1. Explicit pick always wins, even against contradicting text.
  assert.equal(resolveSummaryOutputLanguage({ configured: "en", sourceText: ZH_HANS_SAMPLE }), "en");
  // 2. Auto resolves from the source text itself.
  assert.equal(resolveSummaryOutputLanguage({ configured: "auto", sourceText: ZH_HANS_SAMPLE }), "zh-Hans");
  assert.equal(resolveSummaryOutputLanguage({ configured: null, sourceText: JA_SAMPLE }), "ja");
  // 3. Undetectable Latin text falls back to the world's stored language —
  //    but only a Latin-language hint; a zh hint must not force Chinese
  //    summaries onto Latin-script text.
  const ambiguousLatin = "Lin Qingxue Sebastian Aria Kael Voss Miro Talon Vesper Juno Idris Sable Rune Corvid Lyra Onyx";
  assert.equal(resolveSummaryOutputLanguage({ configured: "auto", sourceText: ambiguousLatin, worldLanguage: "es" }), "es");
  assert.equal(resolveSummaryOutputLanguage({ configured: "auto", sourceText: ambiguousLatin, worldLanguage: "zh" }), "auto");
  // An empty sample takes any hint (worlds store Traditional as plain "zh";
  // Simplified is the majority default).
  assert.equal(resolveSummaryOutputLanguage({ configured: "auto", sourceText: "", worldLanguage: "zh" }), "zh-Hans");
  // 4. Nothing known → stay on the old same-as-source instruction.
  assert.equal(resolveSummaryOutputLanguage({ configured: "auto", sourceText: ambiguousLatin }), "auto");
});

test("wrong-language summary is corrected once with names and facts preserved in the request", async () => {
  const { correctSummaryLanguageOnce } = await loadModule();
  let calls = 0;
  const result = await correctSummaryLanguageOnce({
    text: EN_SAMPLE, language: "zh-Hans",
    generate: async (prompt) => {
      calls++;
      assert.match(String(prompt[0]!.content), /Simplified Chinese \(简体中文\)/);
      assert.match(String(prompt[0]!.content), /Never translate, transliterate, or re-romanize a name/);
      assert.match(String(prompt[0]!.content), /Preserve every fact, number, and relationship/);
      assert.equal(prompt[1]!.content, EN_SAMPLE);
      return ZH_HANS_SAMPLE;
    },
  });
  assert.equal(calls, 1);
  assert.equal(result, ZH_HANS_SAMPLE);
});

test("correction still in the wrong language is returned without another check or call", async () => {
  const { correctSummaryLanguageOnce } = await loadModule();
  let calls = 0;
  const stillEnglish = `${EN_SAMPLE} The gate remained open.`;
  const result = await correctSummaryLanguageOnce({
    text: EN_SAMPLE, language: "zh-Hans",
    generate: async () => {
      assert.equal(++calls, 1, "language correction must never loop");
      return stillEnglish;
    },
  });
  assert.equal(calls, 1);
  assert.equal(result, stillEnglish);
});

test("matching, unresolved, and name-only summaries do not make a correction call", async () => {
  const { correctSummaryLanguageOnce } = await loadModule();
  for (const [text, language] of [
    [ZH_HANS_SAMPLE + " Celeste 与 Lee Know 一起离开。", "zh-Hans"],
    [EN_SAMPLE, "en"], [JA_SAMPLE, "ja"], [KO_SAMPLE, "ko"], [RU_SAMPLE, "ru"],
    [EN_SAMPLE, "auto"], ["ok 好", "zh-Hans"],
    ["Celeste Lee Know Sebastian Aria Kael Voss", "zh-Hans"],
  ] as const) {
    let calls = 0;
    assert.equal(await correctSummaryLanguageOnce({
      text, language, generate: async () => { calls++; return "unexpected correction"; },
    }), text);
    assert.equal(calls, 0, "unnecessary correction");
  }
});

test("an explicit English target can correct a Chinese summary", async () => {
  const { correctSummaryLanguageOnce } = await loadModule();
  let calls = 0;
  assert.equal(await correctSummaryLanguageOnce({
    text: ZH_HANS_SAMPLE, language: "en",
    generate: async (prompt) => { calls++; assert.match(String(prompt[0]!.content), /Language: write in English/); return EN_SAMPLE; },
  }), EN_SAMPLE);
  assert.equal(calls, 1);
});

test("failed or empty correction preserves the original without scheduling another attempt", async () => {
  const { correctSummaryLanguageOnce } = await loadModule();
  for (const failure of ["error", "empty"] as const) {
    let calls = 0;
    assert.equal(await correctSummaryLanguageOnce({
      text: EN_SAMPLE, language: "zh-Hans",
      generate: async () => {
        assert.equal(++calls, 1);
        if (failure === "error") throw new Error("provider unavailable");
        return "  ";
      },
    }), EN_SAMPLE);
    assert.equal(calls, 1);
  }
});
