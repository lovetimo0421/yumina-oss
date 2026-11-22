import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useRouter } from "@tanstack/react-router";
import { ArrowLeft, Loader2, Users } from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { absoluteImageUrl } from "@/lib/asset-url";
import { navigateBackSafely } from "@/lib/safe-back";
import { cn } from "@/lib/utils";
import { useUserProfileStore } from "@/stores/user-profile";
import { RoomApiError, storyRoomApi, type RoomSnapshot } from "./api";
import { joinErrorFix, normaliseSnapshot, roleChoices, type JoinFix } from "./room-logic";
import { useRoomStore } from "./room-store";
import { Portrait, RoleCard, SeatRow, memberPicture, type Seat } from "./party";

const apiBase = import.meta.env.VITE_API_URL || "";

/**
 * /app/room/<code>: the door to a friend's story. Shows the card, the host
 * and the seats, lets the joiner pick a role, fixes what the room requires
 * right here (birth year), then hands over to the chat itself, where members
 * read the story and act with everyone else.
 */
export function StoryRoomPage({ code }: { code: string }) {
  const router = useRouter();
  const [snap, setSnap] = useState<RoomSnapshot | null>(null);
  const [loadError, setLoadError] = useState<JoinFix | null>(null);

  const enterChat = useCallback((next: RoomSnapshot) => {
    useRoomStore.getState().attach(next);
    void router.navigate({ to: "/app/chat/$sessionId", params: { sessionId: next.room.sessionId }, replace: true });
  }, [router]);

  useEffect(() => {
    let alive = true;
    setSnap(null);
    setLoadError(null);
    storyRoomApi
      .get(code)
      .then((raw) => {
        if (!alive) return;
        const next = normaliseSnapshot(raw);
        if (next.room.status !== "open") setLoadError({ kind: "message", key: "closed" });
        else if (next.me) enterChat(next);
        else setSnap(next);
      })
      .catch((err) => {
        if (!alive) return;
        const reason = err instanceof RoomApiError ? (err.status === 404 || err.status === 410 ? "closed" : err.code) : "failed";
        setLoadError(joinErrorFix(reason));
      });
    return () => {
      alive = false;
    };
  }, [code, enterChat]);

  const goBack = () => navigateBackSafely(router.history, "/app");

  if (loadError) return <RoomMessage fix={loadError} onBack={goBack} />;
  if (!snap) {
    return (
      <Centered>
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground/40" />
      </Centered>
    );
  }
  return <JoinScreen snap={snap} onJoined={enterChat} onBack={goBack} />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full min-h-0 w-full flex-1 items-center justify-center overflow-y-auto p-4 sm:p-6">{children}</div>;
}

function fixKey(fix: JoinFix) {
  if (fix.kind === "birth-year") return "storyRoom.errBirthYear" as const;
  if (fix.kind === "adult") return "storyRoom.errAdult" as const;
  if (fix.kind === "role") return fix.key === "pickRole" ? ("storyRoom.errPickRole" as const) : ("storyRoom.errRoleTaken" as const);
  switch (fix.key) {
    case "closed":
      return "storyRoom.errClosed" as const;
    case "full":
      return "storyRoom.errFull" as const;
    case "kicked":
      return "storyRoom.errKicked" as const;
    case "blocked":
      return "storyRoom.errBlocked" as const;
    default:
      return "storyRoom.errFailed" as const;
  }
}

function RoomMessage({ fix, onBack }: { fix: JoinFix; onBack: () => void }) {
  const { t } = useTranslation("common");
  return (
    <Centered>
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <Users className="h-8 w-8 text-muted-foreground/30" />
        <p className="text-sm text-foreground/85">{t(fixKey(fix))}</p>
        <button
          type="button"
          onClick={onBack}
          className="rounded-xl border border-white/15 px-4 py-2 text-sm text-foreground/80 transition-colors hover:bg-white/[0.06]"
        >
          {t("storyRoom.back")}
        </button>
      </div>
    </Centered>
  );
}

function JoinScreen({ snap: initial, onJoined, onBack }: { snap: RoomSnapshot; onJoined: (snap: RoomSnapshot) => void; onBack: () => void }) {
  const { t } = useTranslation("common");
  const { data: auth } = useSession();
  const meId = auth?.user?.id ?? null;
  const [snap, setSnap] = useState(initial);
  const [roleId, setRoleId] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [fix, setFix] = useState<JoinFix | null>(null);
  const [year, setYear] = useState("");
  const forceFetchProfile = useUserProfileStore((s) => s.forceFetchProfile);

  const host = snap.members.find((m) => m.role === "host") ?? null;
  const cover = absoluteImageUrl(snap.session.worldCover);
  const roles = roleChoices(snap.roles, snap.members, meId);
  const full = snap.members.length >= snap.room.maxSeats;
  const needsRole = snap.rolesRequired && roles.length > 0 && !roleId;
  // A split room: joining means paying a share of the rounds you act in.
  const split = (snap.cost?.mode ?? snap.room.costMode) === "split";
  const perRound = snap.cost?.perRound ?? null;
  const thisYear = new Date().getFullYear();
  const yearValue = Number(year);
  const yearValid = /^\d{4}$/.test(year) && yearValue >= 1900 && yearValue <= thisYear;

  const join = async () => {
    setJoining(true);
    setFix(null);
    try {
      onJoined(normaliseSnapshot(await storyRoomApi.join(snap.room.code, roleId, { acceptSplit: split })));
    } catch (err) {
      const next = joinErrorFix(err instanceof RoomApiError ? err.code : "failed");
      setFix(next);
      if (next.kind === "role") {
        // Someone took it meanwhile: show the seats as they are now.
        setRoleId(null);
        storyRoomApi.get(snap.room.code).then((s) => setSnap(normaliseSnapshot(s))).catch(() => {});
      }
    } finally {
      setJoining(false);
    }
  };

  const saveYearAndJoin = async () => {
    if (!yearValid) return;
    setJoining(true);
    try {
      const res = await fetch(`${apiBase}/api/users/me`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ birthYear: yearValue }),
      });
      if (!res.ok) throw new Error(String(res.status));
      void forceFetchProfile();
    } catch {
      setJoining(false);
      setFix({ kind: "message", key: "failed" });
      return;
    }
    await join();
  };

  const blocked = fix?.kind === "message" && fix.key !== "failed";

  const seats: Seat[] = snap.members.map((m) => ({
    key: m.userId,
    name: m.name,
    image: memberPicture(m, snap.roles),
    roleName: m.roleName,
    host: m.role === "host",
    online: m.online,
  }));

  return (
    <div className="relative h-full min-h-0 w-full flex-1 overflow-y-auto">
      {cover && (
        <div aria-hidden className="pointer-events-none fixed inset-0 overflow-hidden">
          <img src={cover} alt="" className="h-full w-full scale-110 object-cover opacity-30 blur-2xl" />
          <div className="absolute inset-0 bg-gradient-to-b from-[#121316]/40 via-[#121316]/80 to-[#121316]" />
        </div>
      )}
      <div className="relative mx-auto flex w-full max-w-[34rem] flex-col gap-6 px-4 pb-10 pt-4 sm:pt-10">
        <div className="relative overflow-hidden rounded-3xl border border-white/10 shadow-[0_24px_60px_rgba(0,0,0,0.55)]">
          <div className="relative aspect-[16/9] w-full bg-[#1F2027]">
            {cover && <img src={cover} alt="" className="h-full w-full object-cover" />}
            <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/20 to-transparent" />
            <button
              type="button"
              onClick={onBack}
              className="absolute left-3 top-3 flex h-10 w-10 items-center justify-center rounded-full bg-black/45 text-white/80 backdrop-blur-sm transition-colors hover:bg-black/65 hover:text-white"
              aria-label={t("storyRoom.back")}
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <div className="absolute inset-x-0 bottom-0 flex flex-col gap-1.5 px-5 pb-4">
              <h1
                className="font-serif text-2xl font-black leading-tight tracking-wide text-[#FFF5D6] sm:text-3xl"
                style={{ textShadow: "0 4px 20px rgba(0,0,0,0.8)" }}
              >
                {snap.session.worldName ?? t("storyRoom.title")}
              </h1>
              {host && (
                <span className="flex items-center gap-2 text-sm text-white/80">
                  <Portrait src={host.image} name={host.name} seed={host.userId} className="h-6 w-6 rounded-full" monogramClassName="text-[11px]" />
                  {t("storyRoom.hostedBy", { name: host.name })}
                </span>
              )}
            </div>
          </div>
        </div>

        <section className="flex flex-col gap-2.5">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-foreground">{t("storyRoom.party")}</h2>
            <span className={cn("text-xs tabular-nums", full ? "text-amber-300/90" : "text-muted-foreground")}>
              {t("storyRoom.seatCount", { count: snap.members.length, max: snap.room.maxSeats })}
            </span>
          </div>
          <SeatRow seats={seats} max={snap.room.maxSeats} />
        </section>

        {roles.length > 0 && (
          <section className="flex flex-col gap-2.5">
            <h2 className="text-sm font-semibold text-foreground">
              {snap.rolesRequired ? t("storyRoom.pickRoleRequired") : t("storyRoom.pickRoleOptional")}
            </h2>
            <div className={cn("grid grid-cols-2 gap-2.5", roles.length === 4 || roles.length > 6 ? "sm:grid-cols-4" : "sm:grid-cols-3")}>
              {roles.map((r) => (
                <RoleCard
                  key={r.id}
                  role={r}
                  selected={roleId === r.id}
                  holder={r.holder}
                  hostHolds={!!r.holder && r.holder.userId === host?.userId}
                  disabled={!r.free || joining}
                  onPick={() => setRoleId(roleId === r.id ? null : r.id)}
                />
              ))}
            </div>
          </section>
        )}

        <div className="flex flex-col gap-4">
          {fix && fix.kind !== "role" && (
            <div className="flex flex-col gap-2.5 rounded-xl border border-[#262830] bg-[#1F2027] px-3.5 py-3 text-sm text-foreground/85">
              <span>{t(fixKey(fix))}</span>
              {fix.kind === "birth-year" && (
                <div className="flex items-center gap-2">
                  <input
                    value={year}
                    onChange={(e) => setYear(e.target.value.replace(/\D/g, "").slice(0, 4))}
                    onKeyDown={(e) => e.key === "Enter" && void saveYearAndJoin()}
                    inputMode="numeric"
                    autoFocus
                    placeholder={t("storyRoom.birthYearPlaceholder")}
                    aria-label={t("storyRoom.addBirthYear")}
                    className="h-10 w-28 rounded-lg border border-[#262830] bg-[#121316] px-3 text-sm tabular-nums outline-none focus:border-[#C9A25E]/60"
                  />
                  <button
                    type="button"
                    disabled={!yearValid || joining}
                    onClick={() => void saveYearAndJoin()}
                    className="h-10 rounded-lg bg-[#C9A25E] px-3.5 text-xs font-semibold text-[#1A1A22] transition-colors hover:bg-[#D8B26B] disabled:opacity-40"
                  >
                    {t("storyRoom.saveAndJoin")}
                  </button>
                </div>
              )}
              {fix.kind === "adult" && (
                <Link
                  to="/app/settings"
                  hash="content-safety"
                  className="self-start rounded-lg bg-white/[0.08] px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-white/[0.12]"
                >
                  {t("storyRoom.contentSettings")}
                </Link>
              )}
            </div>
          )}
          {fix?.kind === "role" && <p className="-mt-1 text-xs text-amber-300/90">{t(fixKey(fix))}</p>}

          {split && (
            <p className="rounded-xl border border-[#262830] bg-[#1F2027] px-3.5 py-3 text-sm leading-relaxed text-foreground/85" data-room-split="">
              {t("storyRoom.splitJoinNote")}
              {perRound != null && <span className="text-muted-foreground"> {t("storyRoom.splitPerRound", { amount: perRound.toLocaleString() })}</span>}
            </p>
          )}

          {fix?.kind !== "birth-year" && (
            <button
              type="button"
              onClick={() => void join()}
              disabled={joining || blocked || full || needsRole}
              className="flex min-h-12 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#C9A25E] to-[#B8913D] px-4 text-sm font-bold text-[#1A1A22] shadow-[0_0_24px_rgba(201,162,94,0.22)] transition-all hover:from-[#D4AD6A] hover:to-[#C9A25E] disabled:opacity-40 disabled:shadow-none"
            >
              {joining && <Loader2 className="h-4 w-4 animate-spin" />}
              {full ? t("storyRoom.errFull") : needsRole ? t("storyRoom.pickRole") : split ? t("storyRoom.splitJoin") : t("storyRoom.join")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
