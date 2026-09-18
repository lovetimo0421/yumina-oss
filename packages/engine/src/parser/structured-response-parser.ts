import type { Effect, AudioEffect } from "../types/index.js";
import type { ParseResult } from "./response-parser.js";

/**
 * Parses JSON-format LLM responses.
 *
 * Expected format:
 * ```json
 * {
 *   "narrative": "Scene description...",
 *   "stateChanges": [
 *     { "variableId": "hp", "operation": "set", "value": 100 }
 *   ],
 *   "audioEffects": [{ "trackId": "bgm1", "action": "play" }]
 * }
 * ```
 */
export class StructuredResponseParser {
  /** Strip markdown code fences (```json ... ``` or ``` ... ```) if present. */
  private stripCodeFence(text: string): string {
    const trimmed = text.trim();
    const match = trimmed.match(/^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*```\s*$/);
    return match ? match[1]! : trimmed;
  }

  /**
   * Checks whether the given text is a structured JSON response with a `narrative` field.
   */
  isStructuredResponse(text: string): boolean {
    const trimmed = this.stripCodeFence(text);
    if (!trimmed.startsWith("{")) return false;
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === "object" && parsed !== null && typeof parsed.narrative === "string";
    } catch {
      // Could be truncated JSON — check for narrative field pattern
      return /"narrative"\s*:\s*"/.test(trimmed);
    }
  }

  /**
   * Parses a structured JSON response into a ParseResult.
   * Falls back to returning the raw text as cleanText if parsing fails.
   */
  parse(text: string): ParseResult {
    const trimmed = this.stripCodeFence(text);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // Attempt to repair truncated JSON (common with max token limits)
      const repaired = this.tryRepairJSON(trimmed);
      if (!repaired) {
        return { cleanText: text, effects: [], audioEffects: [] };
      }
      parsed = repaired;
    }

    const cleanText = typeof parsed.narrative === "string" ? parsed.narrative : "";

    // Convert stateChanges to Effect[]
    const effects: Effect[] = [];
    const rawChanges = parsed.stateChanges;
    if (Array.isArray(rawChanges)) {
      // Array format: [{ variableId, operation, value }]
      for (const sc of rawChanges) {
        if (
          typeof sc === "object" &&
          sc !== null &&
          typeof sc.variableId === "string" &&
          typeof sc.operation === "string"
        ) {
          effects.push({
            variableId: sc.variableId as string,
            operation: sc.operation as Effect["operation"],
            value: sc.value as Effect["value"],
          });
        }
      }
    } else if (typeof rawChanges === "object" && rawChanges !== null && !Array.isArray(rawChanges)) {
      // Flat object format: { currentBg: "classroom", segments: [...], day: 1 }
      // Treat each key as a "set" operation
      for (const [key, value] of Object.entries(rawChanges as Record<string, unknown>)) {
        effects.push({
          variableId: key,
          operation: "set",
          value: value as Effect["value"],
        });
      }
    }

    // Extract audioEffects
    const audioEffects: AudioEffect[] = [];
    if (Array.isArray(parsed.audioEffects)) {
      for (const ae of parsed.audioEffects) {
        if (
          typeof ae === "object" &&
          ae !== null &&
          typeof ae.trackId === "string" &&
          typeof ae.action === "string"
        ) {
          const effect: AudioEffect = {
            trackId: ae.trackId as string,
            action: ae.action as AudioEffect["action"],
          };
          if (typeof ae.volume === "number") effect.volume = ae.volume;
          if (typeof ae.fadeDuration === "number") effect.fadeDuration = ae.fadeDuration;
          audioEffects.push(effect);
        }
      }
    }

    return { cleanText, effects, audioEffects };
  }

  /**
   * Attempts to repair truncated JSON by closing unmatched braces/brackets.
   * Common when LLM output hits max token limits mid-JSON.
   */
  private tryRepairJSON(text: string): Record<string, unknown> | null {
    if (!text.startsWith("{")) return null;

    // First try: trim trailing incomplete string/value, then close
    let repaired = this.trimToLastComplete(text);
    let closers = this.findMissingClosers(repaired);
    if (closers) {
      try {
        const parsed = JSON.parse(repaired + closers);
        if (typeof parsed === "object" && parsed !== null && typeof parsed.narrative === "string") {
          return parsed as Record<string, unknown>;
        }
      } catch { /* try next strategy */ }
    }

    // Second try: use original text with closers
    closers = this.findMissingClosers(text);
    if (closers) {
      try {
        const parsed = JSON.parse(text + closers);
        if (typeof parsed === "object" && parsed !== null && typeof parsed.narrative === "string") {
          return parsed as Record<string, unknown>;
        }
      } catch { /* give up */ }
    }

    return null;
  }

  /**
   * Trim text to the last position that could be a complete JSON value
   * (after a closing `}`, `]`, `"`, digit, true/false/null).
   */
  private trimToLastComplete(text: string): string {
    // Find last comma or complete value boundary outside strings
    let inString = false;
    let lastGoodIdx = -1;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (inString) {
        if (ch === "\\" && i + 1 < text.length) { i++; continue; }
        if (ch === '"') { inString = false; lastGoodIdx = i; }
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === "}" || ch === "]") { lastGoodIdx = i; }
      if (ch === ",") { lastGoodIdx = i - 1; }
    }

    // If we ended inside a string, trim back to before that string started
    if (inString) {
      // Find the opening quote of the unclosed string
      let depth = 0;
      for (let i = text.length - 1; i >= 0; i--) {
        if (text[i] === '"' && (i === 0 || text[i - 1] !== "\\")) {
          depth++;
          if (depth === 1) {
            // This is the opening quote — trim before it
            // Also remove the key + colon if this was a value
            let trimIdx = i;
            while (trimIdx > 0 && text[trimIdx - 1] === " ") trimIdx--;
            if (trimIdx > 0 && text[trimIdx - 1] === ":") trimIdx--;
            while (trimIdx > 0 && text[trimIdx - 1] === " ") trimIdx--;
            // Remove the key too if quoted
            if (trimIdx > 0 && text[trimIdx - 1] === '"') {
              const keyStart = text.lastIndexOf('"', trimIdx - 2);
              if (keyStart >= 0) trimIdx = keyStart;
            }
            // Remove leading comma
            while (trimIdx > 0 && (text[trimIdx - 1] === "," || text[trimIdx - 1] === " " || text[trimIdx - 1] === "\n")) trimIdx--;
            return text.slice(0, trimIdx);
          }
        }
      }
    }

    return lastGoodIdx > 0 ? text.slice(0, lastGoodIdx + 1) : text;
  }

  /**
   * Scan text for unmatched `{` and `[` (respecting string literals)
   * and return the closing characters needed, or null if nothing to close.
   */
  private findMissingClosers(text: string): string | null {
    const stack: string[] = [];
    let inString = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (inString) {
        if (ch === "\\" && i + 1 < text.length) { i++; continue; }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === "{") stack.push("}");
      else if (ch === "[") stack.push("]");
      else if (ch === "}" || ch === "]") {
        if (stack.length > 0 && stack[stack.length - 1] === ch) {
          stack.pop();
        }
      }
    }

    if (stack.length === 0) return null;
    return stack.reverse().join("");
  }
}
