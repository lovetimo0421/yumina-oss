export type CommunityThreadDateMode = "created" | "activity";

export function getCommunityThreadDisplayTime(
  thread: { createdAt: string; lastReplyAt: string | null },
  mode: CommunityThreadDateMode,
): string {
  return mode === "activity" ? thread.lastReplyAt ?? thread.createdAt : thread.createdAt;
}
