import { describe, it, expect } from "vitest";
import { keywordMatches, wholeWordPattern } from "../keyword-matcher.js";

/** keywordMatches as it was before patterns were cached and prefiltered. */
function reference(text: string, keyword: string, wholeWord: boolean): boolean {
  const lowerText = text.toLowerCase();
  const lowerKeyword = keyword.toLowerCase();
  const regexMatch = /^\/(.+)\/([gimsuy]*)$/.exec(keyword);
  if (regexMatch) {
    try {
      const flags = regexMatch[2]!.includes("i") ? regexMatch[2]! : regexMatch[2]! + "i";
      if (new RegExp(regexMatch[1]!, flags).test(text)) return true;
    } catch { /* fall through */ }
  }
  if (wholeWord) {
    try {
      if (lowerKeyword.trim() && wholeWordPattern(lowerKeyword).test(text)) return true;
    } catch { /* fall through */ }
    return false;
  }
  return lowerText.includes(lowerKeyword);
}

const TEXTS = [
  "Ron grabs your sleeve. Ronald Weasley, honestly. RON!",
  "赫敏皱着眉往这儿看。我去了Hogsmeade村,潘西·帕金森站在门口",
  "José y Género hablan por téléphone; NERO no está.",
  "chapter 10 begins\nchapter 1 begins\n\tThe Three Broomsticks",
  "ハリーはホグワーツへ。해리는 호그와트로. ภาษาไทย",
  "a.b*c (paren) [bracket] $dollar ^caret \\slash /slash/ 100%",
  "",
  "İstanbul ǅemal ß STRASSE ﬁne",
];
const KEYWORDS = [
  "Ron", "ron", "Ronald", "aunt", "chapter 1", "赫敏", "潘西", "Hogsmeade", "村", "José", "género",
  "Nero", "phone", "ハリー", "호그와트", "ไทย", "a.b*c", "(paren)", "[bracket]", "$dollar", "^caret",
  "\\slash", "100%", " ", "", "  Ron  ", "istanbul", "strasse", "ß", "fine",
  "/ron/", "/ron/g", "/^Ron/y", "/RON/gi", "/赫敏|潘西/", "/[/", "/x/ii", "/chapter \\d+/gm", "/./s",
];

describe("keywordMatches equivalence", () => {
  it("returns what the uncached implementation returned, in any call order", () => {
    // Twice, so second calls hit the caches and any carried regex state shows.
    for (let round = 0; round < 2; round++) {
      for (const text of TEXTS) {
        for (const keyword of KEYWORDS) {
          for (const wholeWord of [false, true]) {
            expect(keywordMatches(text, keyword, wholeWord), `${round} ${JSON.stringify(keyword)} ${wholeWord} in ${JSON.stringify(text.slice(0, 20))}`)
              .toBe(reference(text, keyword, wholeWord));
          }
        }
      }
    }
  });
});
