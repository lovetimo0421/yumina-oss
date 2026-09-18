import type { GameEvent, EventPattern, EventMatchCondition } from "./types.js";

/**
 * Check if a GameEvent matches an EventPattern.
 * - Matches eventType (exact or trailing wildcard "spatial:*")
 * - Optionally checks data field conditions
 */
export function matchesEventPattern(event: GameEvent, pattern: EventPattern): boolean {
  // Match event type
  if (!matchesEventType(event.type, pattern.eventType)) {
    return false;
  }

  // Match data field conditions
  if (pattern.match) {
    for (const [field, condition] of Object.entries(pattern.match)) {
      const eventValue = event[field];
      if (!matchesCondition(eventValue, condition)) {
        return false;
      }
    }
  }

  return true;
}

/** Match event type string with optional wildcard support */
function matchesEventType(eventType: string, patternType: string): boolean {
  if (patternType === eventType) return true;

  // Trailing wildcard: "spatial:*" matches "spatial:zone-enter", "spatial:proximity-enter", etc.
  if (patternType.endsWith(":*")) {
    const prefix = patternType.slice(0, -1); // "spatial:"
    return eventType.startsWith(prefix);
  }

  return false;
}

/** Evaluate a single field condition against an event value */
function matchesCondition(value: unknown, condition: EventMatchCondition): boolean {
  const target = condition.value;

  switch (condition.operator) {
    case "eq":
      return value === target;
    case "neq":
      return value !== target;
    case "gt":
      return typeof value === "number" && typeof target === "number" && value > target;
    case "gte":
      return typeof value === "number" && typeof target === "number" && value >= target;
    case "lt":
      return typeof value === "number" && typeof target === "number" && value < target;
    case "lte":
      return typeof value === "number" && typeof target === "number" && value <= target;
    case "contains": {
      if (typeof value !== "string" || typeof target !== "string") return false;
      // Event-data `contains` is used by player/AI keyword triggers — the
      // creator-facing field is labeled "Keywords" and expects a list. Treat
      // commas (ASCII + fullwidth + 顿号) as OR separators so multi-keyword
      // input fires whenever ANY keyword appears. A single keyword with no
      // separators behaves exactly as a substring match (back-compat).
      const haystack = value.toLowerCase();
      const keywords = target
        .toLowerCase()
        .split(/[,，、]/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (keywords.length === 0) return false;
      return keywords.some((kw) => haystack.includes(kw));
    }
    default:
      return false;
  }
}
