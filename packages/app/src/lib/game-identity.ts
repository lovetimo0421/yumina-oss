export interface GuestIdentity { guestId: string; guestToken: string; expiresAt: number }
export interface GameIdentityClient {
  get(): Promise<GuestIdentity | null>;
  markGuestVisit(): Promise<GuestIdentity | null>;
  current(): GuestIdentity | null;
  link(accountId: string): Promise<boolean>;
}
let client: Promise<GameIdentityClient | null> | undefined;
/** The same public SDK used by standalone games; the sandbox never holds it. */
export function getGameIdentityClient(): Promise<GameIdentityClient | null> {
  if (!client) {
    const path = "/game-sdk/identity.mjs";
    client = import(/* @vite-ignore */ path)
      .then(m => m.createGameIdentity({ base: import.meta.env?.VITE_API_URL || "" }) as GameIdentityClient)
      .catch(() => { client = undefined; return null; });
  }
  return client;
}
export function linkObservedGameGuest(accountId: string): void {
  try {
    if (!localStorage.getItem("yumina_game_seen_guest")) return;
    void getGameIdentityClient().then(c => c?.link(accountId)).catch(() => {});
  } catch { /* Storage-disabled browsers still have account authentication. */ }
}
