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

/**
 * The mode a saved conversation reopens in: the one it was last working in.
 * It used to reopen in "advise" always, so a creator who came back to a card
 * the assistant had been building was told "I can't change the card" and
 * handed a brief of what was already built (nickn, 2026-11-12).
 * The latest sign wins: card changes, a job or a picture mean build; an
 * unanswered brief means advise, because its confirmation sheet lives there.
 */
export function conversationMode(messages: StudioChatMessage[]): "build" | "advise" {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "assistant") continue;
    if (message.buildProposal) return "advise";
    if (message.jobProposal || message.imageProposal) return "build";
    if (message.toolCalls?.length && message.proposalStatus !== "rejected") return "build";
  }
  return "advise";
}
