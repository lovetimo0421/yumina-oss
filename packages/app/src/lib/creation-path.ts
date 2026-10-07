/** The surfaces where someone is MAKING something: the blueprint/Studio, the
 *  classic editor and the create picker. Anything that interrupts on its own
 *  schedule — a campaign promo, a nudge — stays out of these, the way it
 *  already stays out of a running story. */
export function isCreationPath(pathname: string): boolean {
  return (
    pathname.startsWith("/app/studio")
    || pathname.startsWith("/app/worlds/create")
    || /^\/app\/worlds\/[^/]+\/edit/.test(pathname)
  );
}
