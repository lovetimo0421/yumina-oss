import { useTranslation } from "react-i18next";
import { Check, Crown, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Member, RoomRole } from "./api";

/**
 * The room's people drawn the way party games draw them: a picture per seat
 * (the role's art, else the player's avatar, else a monogram on a tone of
 * their own), a row of seats with the empty ones showing, and roles as
 * portrait cards to pick from.
 */

/** A steady hue per person, so a monogram reads as someone, not a blank. */
function hueOf(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function Portrait({
  src,
  name,
  seed,
  className,
  monogramClassName,
}: {
  src?: string | null;
  name: string;
  seed?: string;
  className?: string;
  monogramClassName?: string;
}) {
  if (src) return <img src={src} alt="" draggable={false} className={cn("object-cover", className)} />;
  const hue = hueOf(seed ?? name);
  return (
    <span
      aria-hidden
      className={cn("flex items-center justify-center font-serif font-bold text-[#F3E3BF]", className)}
      style={{ background: `linear-gradient(150deg, hsl(${hue} 32% 34%), hsl(${(hue + 40) % 360} 38% 15%))` }}
    >
      <span className={cn("leading-none", monogramClassName)}>{Array.from(name.trim())[0] ?? "?"}</span>
    </span>
  );
}

/** A member's picture: the role they play, else their own avatar. */
export function memberPicture(member: Pick<Member, "image" | "roleId">, roles: readonly RoomRole[]): string | null {
  const role = member.roleId ? roles.find((r) => r.id === member.roleId) : null;
  return role?.image ?? member.image ?? null;
}

export type Seat = {
  key: string;
  name: string;
  image: string | null;
  roleName?: string | null;
  host?: boolean;
  you?: boolean;
  online?: boolean;
};

/** The table's seats: filled ones with their people, then the open ones. */
export function SeatRow({
  seats,
  max,
  onOpenSeat,
  className,
}: {
  seats: readonly Seat[];
  max: number;
  /** Pressing an open seat (the host: invite someone into it). */
  onOpenSeat?: () => void;
  className?: string;
}) {
  const { t } = useTranslation("common");
  const shownOpen = Math.max(0, Math.min(max, 8) - seats.length);
  const hiddenOpen = Math.max(0, max - seats.length - shownOpen);
  return (
    <div className={cn("flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]", className)} data-seat-row="">
      {seats.map((s) => (
        <div key={s.key} className="flex w-[4.25rem] shrink-0 flex-col items-center gap-1">
          <span className="relative">
            <Portrait
              src={s.image}
              name={s.name}
              seed={s.key}
              className={cn(
                "h-[4.25rem] w-[4.25rem] rounded-2xl border",
                s.you ? "border-[#C9A25E]/80" : "border-white/10",
                s.online === false && "opacity-50",
              )}
              monogramClassName="text-2xl"
            />
            {s.host && (
              <span className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full border border-[#121316] bg-[#C9A25E] text-[#1A1A22]">
                <Crown className="h-3 w-3" strokeWidth={2.5} />
              </span>
            )}
            {s.online && <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-[#17181D] bg-emerald-400" />}
          </span>
          <span className="w-full truncate text-center text-[11px] font-medium leading-tight text-foreground/90">
            {s.you ? t("storyRoom.you") : s.name}
          </span>
          {s.roleName && <span className="-mt-1 w-full truncate text-center text-[10px] leading-tight text-[#D8B26B]/90">{s.roleName}</span>}
        </div>
      ))}
      {Array.from({ length: shownOpen }, (_, i) => {
        const tile = (
          <span className="flex h-[4.25rem] w-[4.25rem] items-center justify-center rounded-2xl border border-dashed border-white/15 text-white/25 transition-colors group-hover:border-[#C9A25E]/50 group-hover:text-[#C9A25E]">
            <Plus className="h-5 w-5" />
          </span>
        );
        return onOpenSeat ? (
          <button key={`open-${i}`} type="button" onClick={onOpenSeat} aria-label={t("storyRoom.inviteFriends")} className="group flex w-[4.25rem] shrink-0 flex-col items-center gap-1">
            {tile}
          </button>
        ) : (
          <div key={`open-${i}`} className="flex w-[4.25rem] shrink-0 flex-col items-center gap-1">{tile}</div>
        );
      })}
      {hiddenOpen > 0 && (
        <div className="flex h-[4.25rem] shrink-0 items-center px-1 text-xs tabular-nums text-muted-foreground">+{hiddenOpen}</div>
      )}
    </div>
  );
}

/** One role to play, as a portrait card: its art, name and line; who holds it. */
export function RoleCard({
  role,
  selected,
  holder,
  hostHolds,
  disabled,
  onPick,
}: {
  role: Pick<RoomRole, "id" | "name" | "note" | "image">;
  selected: boolean;
  holder: { name: string; image: string | null } | null;
  hostHolds?: boolean;
  disabled?: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={selected}
      onClick={onPick}
      data-role-card={role.id}
      className={cn(
        "group relative flex aspect-[3/4] w-full flex-col justify-end overflow-hidden rounded-2xl border text-left transition-all",
        selected
          ? "border-[#C9A25E] shadow-[0_0_0_1px_#C9A25E,0_12px_32px_rgba(201,162,94,0.25)]"
          : "border-white/10 hover:border-[#C9A25E]/50",
        disabled && !selected && "cursor-not-allowed",
      )}
    >
      <Portrait
        src={role.image}
        name={role.name}
        seed={role.id}
        className={cn("absolute inset-0 h-full w-full transition-transform duration-300", !disabled && "group-hover:scale-[1.04]", holder && !selected && "grayscale-[60%]")}
        monogramClassName="text-5xl opacity-80"
      />
      <span className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/30 to-transparent" />
      {holder && !selected && <span className="absolute inset-0 bg-black/40" />}
      {selected && (
        <span className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-[#C9A25E] text-[#1A1A22]">
          <Check className="h-3.5 w-3.5" strokeWidth={3} />
        </span>
      )}
      <span className="relative flex flex-col gap-0.5 p-2.5">
        <span className={cn("truncate text-sm font-bold", selected ? "text-[#F3D58F]" : "text-white")}>{role.name}</span>
        {holder ? (
          <span className="flex items-center gap-1 text-[11px] text-white/70">
            <Portrait src={holder.image} name={holder.name} className="h-4 w-4 rounded-full" monogramClassName="text-[9px]" />
            {hostHolds && <Crown className="h-3 w-3 text-[#C9A25E]" />}
            <span className="truncate">{holder.name}</span>
          </span>
        ) : (
          role.note && <span className="line-clamp-2 text-[11px] leading-snug text-white/70">{role.note}</span>
        )}
      </span>
    </button>
  );
}
