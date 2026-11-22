import { useContext, useMemo } from "react";
import { RigCharacter, type RigCharacterProps } from "@/../sandbox/building-blocks/rig-character";
import { YuminaContext } from "@/../sandbox/sandbox-context";
import { fetchAssetBytes } from "@/lib/fetch-asset-bytes";

/**
 * <RigCharacter> for the Studio's in-page preview: the play sandbox's own component, drawn by the same runtime, so
 * the creator sees the live character their card shows (it was a placeholder figure here, and a card that waits for
 * its character sat on its loading screen forever). The component reads the character's pack through the sandbox
 * API; out here that API is the idle default, so it is given the one thing it needs: the asset reader play uses.
 * Its own module so the sandbox API and the rig runtime load only when a previewed card has a live character.
 */
export default function PreviewRigCharacter(props: RigCharacterProps) {
  const base = useContext(YuminaContext);
  const api = useMemo(
    () => ({ ...base, fetchAsset: (ref: string) => fetchAssetBytes(ref, import.meta.env.VITE_API_URL || "") }),
    [base],
  );
  return (
    <YuminaContext.Provider value={api}>
      <RigCharacter {...props} />
    </YuminaContext.Provider>
  );
}
