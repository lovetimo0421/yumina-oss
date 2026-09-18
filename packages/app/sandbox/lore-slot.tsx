import { useEffect } from "react";
import { useYumina } from "./sandbox-context";

/**
 * Invisible lorebook trigger — when this component is mounted in the React tree,
 * the bound entry (via Custom UI → Bindings) becomes eligible for AI injection.
 * Unmounting deactivates it. Does not render entry content to the player.
 */
export function LoreSlot({ id }: { id: string }) {
  const api = useYumina();

  useEffect(() => {
    api.setLoreSlotActive?.(id, true);
    return () => {
      api.setLoreSlotActive?.(id, false);
    };
  }, [id, api]);

  return null;
}
