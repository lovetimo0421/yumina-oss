import { getExtensionDefinition } from "@yumina/shared";

export function validateExtensionsSearch(search: Record<string, unknown>): {
  tab?: "discover" | "manage";
  extension?: string;
} {
  return {
    tab: search.tab === "manage" ? "manage" : search.tab === "discover" ? "discover" : undefined,
    // Deep links open existing catalog details, never arbitrary URLs or keys.
    extension: typeof search.extension === "string" && getExtensionDefinition(search.extension)
      ? search.extension : undefined,
  };
}
