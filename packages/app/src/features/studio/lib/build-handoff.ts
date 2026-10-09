import { isStudioBuildProposal, type StudioBuildProposal } from "@yumina/shared";
import type { StudioChatMessage } from "./types";

/** A later user turn invalidates the old offer: the advisor must save its updated scope. */
export function latestBuildProposal(messages: StudioChatMessage[]): StudioBuildProposal | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === "user") return null;
    if (isStudioBuildProposal(message.buildProposal)) return message.buildProposal;
  }
  return null;
}

const seen = new Set<string>();
export function handoffKey(worldId: string, conversationId: string, revision: string): string {
  return `yumina.studio.build-offer:${worldId}:${conversationId}:${revision}`;
}
export function hasSeenBuildOffer(key: string): boolean {
  try { return seen.has(key) || localStorage.getItem(key) === "seen"; } catch { return seen.has(key); }
}
export function markBuildOfferSeen(key: string): void {
  seen.add(key);
  try { localStorage.setItem(key, "seen"); } catch { /* In-memory fallback for private browsing. */ }
}
