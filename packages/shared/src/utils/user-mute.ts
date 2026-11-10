import { z } from "zod";

export const muteDurationSchema = z.enum(["day", "week", "month", "permanent"]);
export type MuteDuration = z.infer<typeof muteDurationSchema>;
export interface UserMuteState {
  isMuted?: boolean;
  mutedUntil?: Date | string | null;
}

export function isUserMuted(state: UserMuteState, now = Date.now()): boolean {
  return state.isMuted === true && (state.mutedUntil == null || new Date(state.mutedUntil).getTime() > now);
}

/** Fixed elapsed durations; a month is 30 days. null means permanent. */
export function muteExpiresAt(duration: MuteDuration, now = new Date()): Date | null {
  if (duration === "permanent") return null;
  const days = { day: 1, week: 7, month: 30 }[duration];
  return new Date(now.getTime() + days * 86_400_000);
}
