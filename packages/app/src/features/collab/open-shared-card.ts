import type { RegisteredRouter } from "@tanstack/react-router";

/**
 * Where a card someone shared with you opens, from every door: the bell, the
 * live invite toast, "Shared with me" and the invite link. Studio, where the
 * others' pointers and following are; the route itself drops back to the
 * classic editor when the canvas is switched off for this account.
 */
export function openSharedCard(router: RegisteredRouter, worldId: string) {
  return router.navigate({ to: "/app/studio/$worldId", params: { worldId } });
}
