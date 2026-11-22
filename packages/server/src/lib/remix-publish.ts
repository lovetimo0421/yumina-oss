/**
 * Whether a copy of someone else's card may go to Discover as a remix.
 *
 * An author who leaves "let others edit" on has agreed that people may copy the
 * card and rework it, and a reworked copy is published like any other card,
 * credited "Based on <original> by <author>" on its page. What stays closed:
 *
 *  - a copy of a card that is not on Discover right now. A DM-shared draft was
 *    handed to one person, not to the public; a card pulled after going live
 *    takes its copies dark anyway (lib/fork-orphan.ts).
 *  - a copy of a card whose author has since turned "let others edit" off.
 *    Remixes already live stay live; that switch is checked at submission.
 *
 * Copies of your own cards, and copies whose original no longer exists (there is
 * no one left to credit or ask), are publishable as before or as ordinary cards.
 */

export type RemixPublishBlock = "REMIX_SOURCE_NOT_PUBLIC" | "REMIX_NOT_ALLOWED";

export interface RemixSource {
  creatorId: string | null;
  status: string | null;
  isPublished: boolean | null;
  allowEdit: boolean | null;
}

export function remixPublishBlock(source: RemixSource | null, copyCreatorId: string): RemixPublishBlock | null {
  if (!source) return null;
  if (source.creatorId === copyCreatorId) return null;
  const live = (source.status ?? (source.isPublished ? "published" : "draft")) === "published" && source.isPublished !== false;
  if (!live) return "REMIX_SOURCE_NOT_PUBLIC";
  if (source.allowEdit === false) return "REMIX_NOT_ALLOWED";
  return null;
}

export const REMIX_PUBLISH_MESSAGES: Record<RemixPublishBlock, string> = {
  REMIX_SOURCE_NOT_PUBLIC: "This card is a copy of a card that isn't on Discover, so it can't be published.",
  REMIX_NOT_ALLOWED: "The author of the original card no longer allows edits, so this copy can't be published.",
};
