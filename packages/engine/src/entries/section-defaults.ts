import type { WorldEntry } from "../types/index.js";
import { isVariableBoundEntry } from "../lorebook/entry-triggers.js";

type EntrySection = NonNullable<WorldEntry["section"]>;

interface SectionDefaults {
  alwaysSend: boolean;
  depth?: number;
  role?: WorldEntry["role"];
  roleBeforeExample?: WorldEntry["roleBeforeExample"];
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
  entry: Pick<WorldEntry, "variableBound" | "conditions"> & Partial<Pick<WorldEntry, "role" | "roleBeforeExample">>,
  section: EntrySection,
): SectionDefaults {
  const base = deriveSectionDefaults(section);
  const defaults = isVariableBoundEntry(entry) ? { ...base, alwaysSend: false } : base;
  // Into the examples: remember what it was. Out of them: be that again — an
  // "example" outside the examples section is read by nothing.
  if (section === "examples") {
    return entry.role && entry.role !== "example" ? { ...defaults, roleBeforeExample: entry.role } : defaults;
  }
  if (entry.role === "example") return { ...defaults, role: entry.roleBeforeExample ?? "custom", roleBeforeExample: undefined };
  return defaults;
}
