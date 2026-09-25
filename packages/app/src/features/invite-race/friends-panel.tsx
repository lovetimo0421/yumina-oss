import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Search } from "lucide-react";
import type { InviteRaceFriendView } from "@yumina/shared";
import { cn } from "@/lib/utils";

/**
 * Every friend you brought, built for hundreds of rows: the funnel on top is
 * also the filter (tap "Needs to come back" to see exactly who to message),
 * then search, sort, and a list that loads 30 at a time.
 *
 * Progress is shown in tickets, never mushies, so a friend's spending can't be
 * read off this page.
 */

const API = import.meta.env?.VITE_API_URL || "";
type Filter = "all" | "waiting" | "active" | "playing" | "maxed";
type Sort = "tickets" | "newest";
export interface Funnel { signedUp: number; active: number; playing: number; maxed: number; waiting: number }

function Avatar({ name, image }: { name: string; image: string | null }) {
  return image
    ? <img src={image} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover" />
    : <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/[0.07] text-sm font-bold text-sub/70">{name.slice(0, 1).toUpperCase()}</span>;
}

function status(f: InviteRaceFriendView): { key: string; tone: string } {
  if (f.excluded) return { key: "excluded", tone: "bg-white/[0.06] text-sub/50" };
  if (!f.active) return { key: "waiting", tone: "bg-amber-400/12 text-amber-300" };
  if (f.progress.maxed) return { key: "maxed", tone: "bg-gold/15 text-gold" };
  if (f.progress.usageTickets > 0) return { key: "playing", tone: "bg-emerald-400/12 text-emerald-300" };
  return { key: "active", tone: "bg-sky-400/12 text-sky-300" };
}

function FriendRow({ f }: { f: InviteRaceFriendView }) {
  const { t, i18n } = useTranslation("profile");
  const s = status(f);
  const p = f.progress;
  // One line of guidance, only where there is something to do.
  const hint = f.excluded ? t("inviteRace.excluded")
    : !f.active ? t(f.activeHint === "play_more" ? "inviteRace.playMore" : "inviteRace.returnTomorrow")
    : p.maxed ? null
    : new Date(f.windowEndsAt).getTime() > Date.now() ? t("inviteRace.toNextBand", { n: p.ticketsToNextBand })
    : t("inviteRace.windowClosed");
  const date = new Date(f.joinedAt).toLocaleDateString(i18n.language, { month: "numeric", day: "numeric" });
  return (
    <li className={cn("flex items-center gap-3 px-4 py-3", f.excluded && "opacity-50")}>
      <Avatar name={f.name} image={f.image} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13.5px] font-semibold text-main">{f.name}</span>
          <span className={cn("shrink-0 rounded-full px-1.5 py-px text-[10px] font-bold", s.tone)}>{t(`inviteRace.status.${s.key}` as never)}</span>
          <span className="ml-auto hidden shrink-0 text-[11px] tabular-nums text-sub/40 sm:inline">{t("inviteRace.friendsTable.joined", { date })}</span>
        </div>
        {f.active && !f.excluded && (
          <div className="mt-1.5 flex h-1 gap-0.5">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-full flex-1 overflow-hidden rounded-full bg-white/[0.07]">
                <div className="h-full rounded-full bg-gold/80" style={{ width: `${p.band > i + 1 || p.maxed ? 100 : p.band === i + 1 ? Math.round(p.fraction * 100) : 0}%` }} />
              </div>
            ))}
          </div>
        )}
        {hint && <p className="mt-1 truncate text-[11.5px] text-sub/50">{hint}</p>}
      </div>
      <div className="w-12 shrink-0 text-right">
        <p className="text-[17px] font-black leading-none tabular-nums text-main">{f.tickets}</p>
        <p className="mt-0.5 text-[10px] text-sub/40">{t("inviteRace.ticketsShort")}</p>
      </div>
    </li>
  );
}

export function FriendsPanel({ funnel, as, refreshKey }: { funnel: Funnel; as: string | null; refreshKey: string | null }) {
  const { t } = useTranslation("profile");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("tickets");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<InviteRaceFriendView[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const req = useRef(0);

  useEffect(() => {
    const id = setTimeout(() => setQuery(q.trim()), 250);
    return () => clearTimeout(id);
  }, [q]);

  const load = useCallback(async (offset: number) => {
    const n = ++req.current;
    setLoading(true);
    const params = new URLSearchParams({ filter, sort, q: query, offset: String(offset), limit: "30" });
    if (as) params.set("as", as);
    try {
      const res = await fetch(`${API}/api/invite-race/friends?${params}`, { credentials: "include" });
      const json = await res.json() as { data: { total: number; rows: InviteRaceFriendView[] } };
      if (n !== req.current) return;
      setTotal(json.data.total);
      setRows((prev) => (offset === 0 ? json.data.rows : [...prev, ...json.data.rows]));
    } catch {
      /* keep what we have */
    } finally {
      if (n === req.current) setLoading(false);
    }
  }, [filter, sort, query, as]);

  useEffect(() => { void load(0); }, [load, refreshKey]);

  const stages: { key: Filter; label: string; n: number; tone: string }[] = [
    { key: "all", label: t("inviteRace.funnel.signedUp"), n: funnel.signedUp, tone: "text-main" },
    { key: "waiting", label: t("inviteRace.funnel.waiting"), n: funnel.waiting, tone: "text-amber-300" },
    { key: "active", label: t("inviteRace.funnel.active"), n: funnel.active, tone: "text-sky-300" },
    { key: "playing", label: t("inviteRace.funnel.playing"), n: funnel.playing, tone: "text-emerald-300" },
    { key: "maxed", label: t("inviteRace.funnel.maxed"), n: funnel.maxed, tone: "text-gold" },
  ];

  return (
    <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-white/[0.018]">
      <div className="flex items-center justify-between gap-3 px-4 pt-4">
        <h2 className="text-[13px] font-bold text-main">{t("inviteRace.friendsTitle")}</h2>
        <span className="text-xs tabular-nums text-sub/50">{t("inviteRace.friendsCount", { n: funnel.signedUp })}</span>
      </div>

      {/* The funnel is the filter. */}
      <div className="mt-3 grid grid-cols-5 border-y border-white/[0.05]">
        {stages.map((s) => (
          <button key={s.key} type="button" onClick={() => setFilter(s.key)}
            className={cn("flex flex-col items-start gap-0.5 px-3 py-3 text-left transition-colors hover:bg-white/[0.02]",
              filter === s.key && "bg-white/[0.03] shadow-[inset_0_-2px_0_var(--color-gold)]")}>
            <span className={cn("text-lg font-black tabular-nums sm:text-xl", s.tone)}>{s.n}</span>
            <span className="text-[10.5px] leading-tight text-sub/55">{s.label}</span>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <label className="flex min-w-[160px] flex-1 items-center gap-2 rounded-xl border border-white/[0.08] bg-black/20 px-3 py-2">
          <Search className="h-4 w-4 text-sub/45" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("inviteRace.friendsTable.search")}
            className="w-full bg-transparent text-sm text-main outline-none placeholder:text-sub/40" />
        </label>
        <div className="flex rounded-xl border border-white/[0.08] p-0.5 text-xs font-semibold">
          {(["tickets", "newest"] as const).map((k) => (
            <button key={k} type="button" onClick={() => setSort(k)}
              className={cn("rounded-lg px-2.5 py-1.5", sort === k ? "bg-white/10 text-main" : "text-sub/55")}>{t(`inviteRace.sort.${k}` as never)}</button>
          ))}
        </div>
      </div>

      {filter === "waiting" && funnel.waiting > 0 && (
        <p className="mx-4 mb-2 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2 text-xs text-amber-200/90">{t("inviteRace.waitingTip", { n: funnel.waiting })}</p>
      )}

      {rows.length === 0 && !loading ? (
        <p className="px-4 pb-5 pt-2 text-sm text-sub/55">{funnel.signedUp === 0 ? t("inviteRace.friendsEmpty") : t("inviteRace.friendsTable.none")}</p>
      ) : (
        <ul className="divide-y divide-white/[0.05] border-t border-white/[0.05]">{rows.map((f) => <FriendRow key={f.inviteeId} f={f} />)}</ul>
      )}

      {(rows.length < total || loading) && (
        <button type="button" disabled={loading} onClick={() => void load(rows.length)}
          className="flex w-full items-center justify-center gap-2 border-t border-white/[0.05] px-4 py-3 text-sm font-semibold text-sub/70 hover:text-main">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : t("inviteRace.friendsTable.more", { shown: rows.length, total })}
        </button>
      )}
    </section>
  );
}
