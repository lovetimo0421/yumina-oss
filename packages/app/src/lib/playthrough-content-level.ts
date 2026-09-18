import type { ContentLevel } from "@/stores/ui";

export function playthroughContentLevelQuery(
  prefix: "?" | "&",
  contentLevel: ContentLevel,
): string {
  return contentLevel === "safe" ? "" : `${prefix}contentLevel=${contentLevel}`;
}
