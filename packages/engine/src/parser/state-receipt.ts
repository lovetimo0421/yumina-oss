/** Platform receipt, never a gameplay command. Standalone lines only. */
export const STATE_RECEIPT_PREFIX = "<yumina-state";

export function stripStateReceipts(text: string): string {
  let fence = false;
  return text.split("\n").filter((line) => {
    if (/^\s*(?:```|~~~)/.test(line)) fence = !fence;
    return fence || !/^[\t ]*<yumina-state(?:\s|\/|>|$)/.test(line);
  }).join("\n").trimEnd();
}

/** Hold only a possible protocol prefix (not an entire line/response). */
export class StateReceiptFilter {
  private pending = "";
  private lineStart = true;
  private hiding = false;
  private fence = false;

  push(chunk: string): string {
    let out = "";
    for (const char of chunk) {
      if (this.hiding) {
        if (char === "\n") { this.hiding = false; this.lineStart = true; }
        continue;
      }
      if (this.lineStart) {
        this.pending += char;
        const candidate = this.pending.trimStart();
        if (candidate === "" && char !== "\n") continue;
        if (candidate === "```" || candidate === "~~~") {
          this.fence = !this.fence;
          out += this.pending; this.pending = ""; this.lineStart = false;
          continue;
        }
        if (!this.fence && candidate.startsWith(STATE_RECEIPT_PREFIX) && candidate.length > STATE_RECEIPT_PREFIX.length && /[\s/>]/.test(candidate[STATE_RECEIPT_PREFIX.length]!)) {
          this.pending = "";
          this.hiding = char !== "\n";
          continue;
        }
        if (((!this.fence && STATE_RECEIPT_PREFIX.startsWith(candidate)) || "```".startsWith(candidate) || "~~~".startsWith(candidate)) && char !== "\n") continue;
        out += this.pending;
        this.pending = "";
        this.lineStart = char === "\n";
      } else {
        out += char;
        if (char === "\n") this.lineStart = true;
      }
    }
    return out;
  }

  flush(): string {
    const text = this.pending;
    this.pending = "";
    return !this.fence && text.trimStart() !== "" && STATE_RECEIPT_PREFIX.startsWith(text.trimStart()) ? "" : text;
  }
}
