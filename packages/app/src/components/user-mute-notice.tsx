import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { MessageSquareOff } from "lucide-react";
import { isUserMuted, type UserMuteState } from "@yumina/shared";
import { useUserMuteStore } from "@/stores/user-mute";

export function useMuteActive(state: UserMuteState) {
  const [tick, setTick] = useState(0);
  const until = state.mutedUntil == null ? null : new Date(state.mutedUntil).getTime();
  useEffect(() => {
    if (!state.isMuted || until == null || until <= Date.now()) return;
    const timer = window.setTimeout(() => setTick((n) => n + 1), Math.min(until - Date.now(), 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [state.isMuted, until, tick]);
  return isUserMuted(state);
}

export function UserMuteStatus({ state }: { state: UserMuteState }) {
  const { t, i18n } = useTranslation("common");
  const active = useMuteActive(state);
  if (!active) return null;
  return <span className="text-xs text-amber-500">
    {state.mutedUntil
      ? t("userMute.until", { date: new Date(state.mutedUntil).toLocaleString(i18n.language) })
      : t("userMute.permanent")}
  </span>;
}

export function UserMuteNotice() {
  const { t } = useTranslation("common");
  const isMuted = useUserMuteStore((s) => s.isMuted);
  const mutedUntil = useUserMuteStore((s) => s.mutedUntil);
  if (!isMuted) return null;
  return <div role="status" className="flex shrink-0 items-start gap-2 border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm">
    <MessageSquareOff aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
    <div><UserMuteStatus state={{ isMuted, mutedUntil }} /><p className="mt-1 text-muted-foreground">{t("userMute.help")}</p></div>
  </div>;
}
