import { describe, expect, it } from "vitest";
import { StateReceiptFilter, stripStateReceipts } from "../parser/state-receipt.js";

const marker = '<yumina-state version="1" status="none" />';
function streamed(chunks: string[]) {
  const filter = new StateReceiptFilter();
  return chunks.map((chunk) => filter.push(chunk)).join("") + filter.flush();
}

describe("StateReceiptFilter", () => {
  for (const raw of [`Story.\n${marker}`, `Story.\n  \t${marker}\n`, `${marker}\nAnother line.`, `First\r\n${marker}\r\nLast`, `First\n${marker}\n${marker}\nLast`]) {
    it(`hides the receipt at every two-chunk boundary: ${JSON.stringify(raw)}`, () => {
      const expected = streamed([raw]);
      expect(expected).not.toContain("yumina-state");
      for (let split = 0; split <= raw.length; split++) {
        expect(streamed([raw.slice(0, split), raw.slice(split)]), `split ${split}`).toBe(expected);
      }
      expect(streamed([...raw])).toBe(expected);
    });
  }
  it("does not leak protocol prefixes while a receipt is arriving", () => {
    const filter = new StateReceiptFilter();
    expect(filter.push("Story.\n")).toBe("Story.\n");
    for (const char of marker) expect(filter.push(char)).toBe("");
    expect(filter.flush()).toBe("");
  });
  it.each(["Plain story.", "First\nSecond", "  Indented story", "<maintext>Story</maintext>", `He says ${marker} in prose.`, `> ${marker}`, `\\${marker}`, `"${marker}"`])
    ("preserves nonprotocol narrative %s", (raw) => expect(streamed([...raw])).toBe(raw));
  it("flushes ordinary pending whitespace", () => expect(streamed(["Story.\n  "])).toBe("Story.\n  "));
  it("hides a receipt truncated at its protocol prefix", () => expect(streamed(["Story.\n<yumina-st"])).toBe("Story.\n"));
  it("does not erase another tag that only shares the prefix", () => {
    const raw = '<yumina-stateful>Story component</yumina-stateful>';
    expect(streamed([...raw])).toBe(raw);
  });
  it("keeps a receipt in a fenced narrative example visible", () => {
    const raw = `Example:\n\`\`\`text\n${marker}\n\`\`\``;
    expect(streamed([...raw])).toBe(raw);
  });
});

describe("stripStateReceipts", () => {
  it("removes standalone protocol while retaining surrounding story", () => {
    expect(stripStateReceipts(`First\n  ${marker}\nLast\n${marker}`)).toBe("First\nLast");
  });
  it("is idempotent for repeated history/copy cleanup", () => {
    const raw = `Story.\n${marker}`;
    expect(stripStateReceipts(stripStateReceipts(raw))).toBe(stripStateReceipts(raw));
  });
  it.each([`He says ${marker} in prose.`, `> ${marker}`, `\\${marker}`, `"${marker}"`])
    ("preserves quoted/escaped markers %s", (raw) => expect(stripStateReceipts(raw)).toBe(raw));
  it("preserves fenced narrative examples rather than removing their contents", () => {
    const raw = `Example:\n\`\`\`text\n${marker}\n\`\`\``;
    expect(stripStateReceipts(raw)).toBe(raw);
  });
});
