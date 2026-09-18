import type { WorldEntry } from "../types/index.js";
import { isVariableBoundEntry } from "../lorebook/entry-triggers.js";

type EntrySection = NonNullable<WorldEntry["section"]>;

interface SectionDefaults {
  alwaysSend: boolean;
  depth?: number;
  role?: WorldEntry["role"];
}

/**
 * Derives alwaysSend and depth from an entry's section.
 * This is the single source of truth for the section → engine-field mapping.
 *
 * - system-presets → alwaysSend true
 * - examples      → alwaysSend true (role forced to "example")
 * - chat-history  → alwaysSend false, depth 4 (depth-injected context)
 * - post-history  → alwaysSend true
 */
export function deriveSectionDefaults(section: EntrySection): SectionDefaults {
  switch (section) {
    case "system-presets":
      return { alwaysSend: true };
    case "examples":
      return { alwaysSend: true, role: "example" };
    case "chat-history":
      return { alwaysSend: false, depth: 4 };
    case "post-history":
      return { alwaysSend: true };
    default:
      return { alwaysSend: true };
  }
}

/**
 * Section defaults for an EXISTING entry (section move, bundle import, agent
 * section update). Variable-bound entries are gated by their conditions and
 * never use always-send — re-deriving section defaults over one must not
 * resurrect `alwaysSend: true`, or the entry gets injected every turn and its
 * conditions go dead (the "imported bundle always sends" bug).
 *
 * Use `deriveSectionDefaults` only when CREATING a fresh entry.
 */
export function deriveSectionDefaultsForEntry(
  entry: Pick<WorldEntry, "variableBound" | "conditions">,
  section: EntrySection,
): SectionDefaults {
  const defaults = deriveSectionDefaults(section);
  return isVariableBoundEntry(entry) ? { ...defaults, alwaysSend: false } : defaults;
}
