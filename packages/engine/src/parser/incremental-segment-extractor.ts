/**
 * Incrementally extracts completed segment objects from a growing JSON stream.
 *
 * Designed to be called on every SSE chunk during LLM streaming. It scans the
 * raw (potentially incomplete) JSON string for fully formed `{...}` objects
 * inside a `"variableId":"segments"` array, using brace-depth counting that
 * correctly handles quoted strings and escape sequences.
 */

export interface ExtractedSegment {
  speaker?: string;
  text: string;
  variant?: string;
  color?: string;
  emotion?: string;
  bg?: string;
  [key: string]: unknown;
}

export interface ExtractionResult {
  /** Newly found segments since the last call */
  newSegments: ExtractedSegment[];
  /** Latest bg change (from currentBg stateChange or segment bg field), or null */
  bg: string | null;
}

const EMPTY_RESULT: ExtractionResult = { newSegments: [], bg: null };

export class IncrementalSegmentExtractor {
  /** Number of segments already emitted */
  private extractedCount = 0;

  /**
   * Main extraction method. Call with the growing content string on each chunk.
   * Returns only NEW segments found since the previous call.
   */
  extract(content: string): ExtractionResult {
    const trimmed = content.trimStart();
    if (!trimmed.startsWith("{")) {
      return EMPTY_RESULT;
    }

    // --- bg from currentBg stateChange ---
    let bg: string | null = this.extractCurrentBg(trimmed);

    // --- Find segments array ---
    const segments = this.extractSegmentObjects(trimmed);

    // Determine newly completed segments
    const newSegments = segments.slice(this.extractedCount);
    this.extractedCount = segments.length;

    // Check for bg fields on new segments (latest one wins)
    for (const seg of newSegments) {
      if (typeof seg.bg === "string" && seg.bg.length > 0) {
        bg = seg.bg;
      }
    }

    if (newSegments.length === 0 && bg === null) {
      return EMPTY_RESULT;
    }

    return { newSegments, bg };
  }

  /** Reset internal state for a new LLM response. */
  reset(): void {
    this.extractedCount = 0;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Extracts `currentBg` value from the raw content using regex.
   * Supports both formats:
   * - Array format: `"variableId":"currentBg"..."value":"<bg>"`
   * - Flat format: `"currentBg": "<bg>"`
   */
  private extractCurrentBg(content: string): string | null {
    // Array format: { "variableId": "currentBg", ..., "value": "<bg>" }
    const arrayRe = /"variableId"\s*:\s*"currentBg"[^}]*"value"\s*:\s*"([^"]*)"/;
    const arrayMatch = content.match(arrayRe);
    if (arrayMatch?.[1]) return arrayMatch[1];

    // Flat format: "currentBg": "<bg>" (inside stateChanges object)
    const flatRe = /"currentBg"\s*:\s*"([^"]*)"/;
    const flatMatch = content.match(flatRe);
    return flatMatch?.[1] ?? null;
  }

  /**
   * Locates the segments array in the raw content and extracts all
   * complete `{...}` objects from it using brace-depth counting.
   * Supports both formats:
   * - Array format: `"variableId":"segments"..."value":[...]`
   * - Flat format: `"segments":[...]`
   */
  private extractSegmentObjects(content: string): ExtractedSegment[] {
    // Try array format first: { "variableId": "segments", ..., "value": [...] }
    const arrayMatch = content.match(/"variableId"\s*:\s*"segments"/);
    if (arrayMatch?.index !== undefined) {
      const valueMatch = content.slice(arrayMatch.index).match(/"value"\s*:\s*\[/);
      if (valueMatch?.index !== undefined) {
        const bracketIdx = content.indexOf("[", arrayMatch.index + valueMatch.index);
        if (bracketIdx !== -1) return this.extractFromBracket(content, bracketIdx);
      }
    }

    // Try flat format: "segments": [...]
    const flatMatch = content.match(/"segments"\s*:\s*\[/);
    if (flatMatch?.index !== undefined) {
      const bracketIdx = content.indexOf("[", flatMatch.index);
      if (bracketIdx !== -1) return this.extractFromBracket(content, bracketIdx);
    }

    return [];
  }

  private extractFromBracket(content: string, bracketIdx: number): ExtractedSegment[] {

    // Extract complete objects from the array region
    const objects = this.extractCompleteObjects(content, bracketIdx + 1);

    // Parse each object and filter to those with a `text` field
    const segments: ExtractedSegment[] = [];
    for (const objStr of objects) {
      try {
        const parsed = JSON.parse(objStr);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          typeof parsed.text === "string"
        ) {
          segments.push(parsed as ExtractedSegment);
        }
      } catch {
        // Skip malformed objects
      }
    }

    return segments;
  }

  /**
   * Extracts complete `{...}` JSON object strings from `content` starting at
   * `startIdx`. Uses brace-depth counting while correctly skipping over
   * string literals (including escaped characters).
   */
  private extractCompleteObjects(
    content: string,
    startIdx: number,
  ): string[] {
    const results: string[] = [];
    const len = content.length;
    let i = startIdx;

    while (i < len) {
      // Skip whitespace and commas between objects
      while (i < len && (content[i] === " " || content[i] === "\n" || content[i] === "\r" || content[i] === "\t" || content[i] === ",")) {
        i++;
      }

      if (i >= len || content[i] === "]") break;
      if (content[i] !== "{") break; // Not an object start — bail

      const objStart = i;
      let depth = 0;
      let inString = false;

      while (i < len) {
        const ch = content[i];

        if (inString) {
          if (ch === "\\") {
            // Skip escaped character
            i += 2;
            continue;
          }
          if (ch === '"') {
            inString = false;
          }
          i++;
          continue;
        }

        // Not in a string
        if (ch === '"') {
          inString = true;
          i++;
          continue;
        }

        if (ch === "{") {
          depth++;
        } else if (ch === "}") {
          depth--;
          if (depth === 0) {
            // Complete object found
            results.push(content.slice(objStart, i + 1));
            i++;
            break;
          }
        }

        i++;
      }

      // If we exited the inner loop without finding a complete object,
      // stop — the rest is incomplete.
      if (depth !== 0) break;
    }

    return results;
  }
}
