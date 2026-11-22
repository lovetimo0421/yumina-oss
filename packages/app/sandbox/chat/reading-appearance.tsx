import { createContext, useContext } from "react";

export type PlayColorMode = "dark" | "light";
export const ReadingAppearanceContext = createContext<PlayColorMode | null>(null);

/** React context also follows portals, including the isolated model dialog. */
export function useReadingAppearance() {
  const mode = useContext(ReadingAppearanceContext);
  return {
    "data-play-color-mode": mode ?? undefined,
    className: mode ? "play-reader-surface" : "",
  };
}
