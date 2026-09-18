/**
 * Filters out tag blocks that some models leak into their text output: reasoning blocks
 * (e.g., Gemini 2.5 Flash Lite emitting <fiction-mode>...</fiction-mode>) and structural
 * blocks the engine injects into the prompt that the model then echoes back verbatim
 * (e.g., the <game-state> state summary).
 *
 * Works both incrementally (for streaming) and as a one-shot strip (for final text).
 */

/** Tag names (lowercase) that wrap model reasoning — content inside these is suppressed. */
const THINKING_TAGS = new Set([
  "think",
  "thinking",
  "fiction-mode",
  "reasoning",
  "reflection",
  "inner-thought",
  "brainstorming",
]);

/**
 * Tag names (lowercase) for structural blocks the engine injects into the prompt that some
 * models mirror back into their reply. Content inside these is suppressed — it's a verbatim
 * echo of context we sent, never narrative. See PromptBuilder.buildFormatBlock for <game-state>.
 */
const ECHOED_TAGS = new Set([
  "game-state",
  // The per-turn update reminder PromptBuilder.buildFormatBlock appends right after
  // <game-state>. Models that mirror the state block tend to mirror this too — strip
  // it so the instruction text never leaks into the narrative.
  "state-reminder",
  // Last-turn variable changes, rendered between the two blocks above by
  // buildFormatBlock. Same mirroring risk, same treatment.
  "last-turn-changes",
]);

/** Union of all tag names whose blocks (open tag, content, close tag) are suppressed. */
const SUPPRESSED_TAGS = new Set([...THINKING_TAGS, ...ECHOED_TAGS]);

/**
 * Incremental filter: call `push()` with each streaming chunk, get back only
 * the non-thinking content. Call `flush()` at end of stream.
 */
export class ThinkingTagFilter {
  private state: "normal" | "in_tag" | "in_block" = "normal";
  /** Buffer for characters after `<` while we determine if it's a thinking tag */
  private tagBuffer = "";
  /** The thinking tag we're currently suppressing (lowercase) */
  private blockTag = "";
  /** Accumulates content inside the block so we can detect the closing tag */
  private closeBuffer = "";

  push(chunk: string): string {
    let output = "";
    let i = 0;

    while (i < chunk.length) {
      const ch = chunk[i]!;

      switch (this.state) {
        case "normal":
          if (ch === "<") {
            this.state = "in_tag";
            this.tagBuffer = "<";
          } else {
            output += ch;
          }
          break;

        case "in_tag":
          this.tagBuffer += ch;
          if (ch === ">") {
            // Tag complete — check if it's a thinking open tag
            const match = this.tagBuffer.match(/^<([\w-]+)>$/i);
            if (match && SUPPRESSED_TAGS.has(match[1]!.toLowerCase())) {
              this.state = "in_block";
              this.blockTag = match[1]!.toLowerCase();
              this.closeBuffer = "";
            } else {
              // Not a thinking tag — emit the buffered characters
              output += this.tagBuffer;
              this.state = "normal";
            }
            this.tagBuffer = "";
          } else if (this.tagBuffer.length > 30) {
            // Too long to be a simple <tagname> — not a thinking tag
            output += this.tagBuffer;
            this.tagBuffer = "";
            this.state = "normal";
          }
          break;

        case "in_block": {
          this.closeBuffer += ch;
          const closeTag = `</${this.blockTag}>`;
          if (this.closeBuffer.toLowerCase().endsWith(closeTag)) {
            this.state = "normal";
            this.blockTag = "";
            this.closeBuffer = "";
          } else if (this.closeBuffer.length > 20_000) {
            // Prevent unbounded growth — keep only the tail needed for matching
            this.closeBuffer = this.closeBuffer.slice(-closeTag.length);
          }
          break;
        }
      }

      i++;
    }

    return output;
  }

  /** Flush any buffered content at end of stream. */
  flush(): string {
    if (this.state === "in_tag") {
      const result = this.tagBuffer;
      this.tagBuffer = "";
      this.state = "normal";
      return result;
    }
    // If still in_block at end, the thinking content is simply discarded
    return "";
  }

  reset(): void {
    this.state = "normal";
    this.tagBuffer = "";
    this.blockTag = "";
    this.closeBuffer = "";
  }

  /** One-shot: strip all thinking tag blocks from a complete string. */
  static strip(text: string): string {
    let result = text;
    for (const tag of SUPPRESSED_TAGS) {
      const pattern = new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, "gi");
      result = result.replace(pattern, "");
    }
    // Clean up leftover whitespace from removed blocks
    return result.replace(/\n{3,}/g, "\n\n").trim();
  }
}
