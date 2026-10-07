import { useRef } from "react";

/** UI identity survives the first save, but separately imported cards never
 * share their canvas session. There is only one blueprint presentation. */
export function useBlueprintDocumentKey({ worldId, serverWorldId }: { worldId: string; serverWorldId: string | null }): string {
  const key = serverWorldId ? `world:${serverWorldId}` : `draft:${worldId}`;
  const current = useRef({ key, worldId, serverWorldId, documentKey: key });
  if (current.current.key !== key) {
    const promoted = current.current.serverWorldId === null && serverWorldId !== null && current.current.worldId === worldId;
    current.current = { key, worldId, serverWorldId, documentKey: promoted ? current.current.documentKey : key };
  }
  return current.current.documentKey;
}
