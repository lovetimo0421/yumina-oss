export type PlaytimeEvent = "resume" | "tick" | "pause" | "stop";
export interface PlaytimeLease {
  leaseId: string | null;
  seenAt: Date | null;
  syncedAt: Date | null;
}
export function playtimeDecision(
  lease: PlaytimeLease,
  event: PlaytimeEvent,
  leaseId: string,
  now: Date,
  recoverElapsed = false,
) {
  const owns = lease.leaseId === leaseId;
  const occupied =
    !!lease.leaseId &&
    !owns &&
    !!lease.seenAt &&
    now.getTime() - lease.seenAt.getTime() <= 45_000;
  if (lease.seenAt && now < lease.seenAt)
    return {
      accepted: false,
      active: owns,
      reason: "stale-request",
      deltaSeconds: 0,
    };
  const gap = owns && lease.syncedAt ? now.getTime() - lease.syncedAt.getTime() : 0;
  const continuous = owns && !!lease.syncedAt && gap >= 0 && gap <= 90_000;
  const deltaSeconds = continuous ? Math.floor(gap / 1000) : 0;
  // Carry subsecond remainder instead of dropping it on every heartbeat.
  const syncedAt = continuous
    ? new Date(lease.syncedAt!.getTime() + deltaSeconds * 1000)
    : now;
  if (event === "resume")
    // Older clients and explicit page restores start a fresh observation.
    // Only a retry within confirmed continuous foreground play recovers time.
    return {
      accepted: !occupied,
      active: !occupied,
      reason: occupied
        ? "lease-held"
        : owns
          ? "lease-refreshed"
          : "lease-acquired",
      deltaSeconds: !occupied && recoverElapsed ? deltaSeconds : 0,
      syncedAt: occupied ? lease.syncedAt : recoverElapsed ? syncedAt : now,
    };
  if (!owns)
    return {
      accepted: false,
      active: false,
      reason: occupied ? "lease-held" : "lease-missing",
      deltaSeconds: 0,
    };
  return {
    accepted: true,
    active: event === "tick",
    reason:
      event === "tick"
        ? "tick-applied"
        : event === "stop"
          ? "stopped"
          : "paused",
    deltaSeconds,
    syncedAt,
  };
}
