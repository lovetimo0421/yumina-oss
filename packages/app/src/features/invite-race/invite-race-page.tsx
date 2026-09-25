import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Crown, Gift, Loader2 } from "lucide-react";
import type { InviteRaceView } from "@yumina/shared";
import { cn } from "@/lib/utils";
import { feedback } from "@/lib/feedback";
import { PrizeChart, type PrizePoint } from "./prize-chart";
import { FriendsPanel, type Funnel } from "./friends-panel";
import { ShareBar } from "./share-bar";
import { HowItWorksSteps, PrizeSplit, RulesList } from "./how-it-works";

/**
 * The Invite Race page.
 *
 * One header card says what this is, how long is left, and holds your link —
 * sharing it is the one thing we want people to do. Below, the left column is
 * about you (your prize over time, the friends you brought); the right column
 * is about everyone (the leaderboard, what just happened, the rules). Phones
 * stack them in that order. No buy buttons; nothing reveals a friend's
 * spending; no mention of rounds or weeks.
 */

const API = import.meta.env?.VITE_API_URL || "";
const DAY = 86_400_000;

interface Board extends InviteRaceView {
  prizeHistory: PrizePoint[];
  change: { hours: number; deltaUsd: number; ticketsGained: number; fromFriendsUsd: number; fromPoolUsd: number } | null;
  funnel: Funnel;
  activity: { at: string; kind: "joined" | "came_back"; name: string; tickets: number }[];
}

const usd = (v: number) => `$${Math.abs(v) >= 1000 ? Math.round(v).toLocaleString("en-US") : v.toFixed(2)}`;
const signed = (v: number) => `${v >= 0 ? "+" : "−"}${usd(Math.abs(v))}`;

function useBoard() {
  const [data, setData] = useState<Board | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const as = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("as") : null;
  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/invite-race/me${as ? `?as=${encodeURIComponent(as)}` : ""}`, { credentials: "include" });
      if (!res.ok) throw new Error(String(res.status));
      setData((await res.json() as { data: Board | null }).data);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [as]);
  useEffect(() => {
    void load();
    const id = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 60_000);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(id); window.removeEventListener("focus", onFocus); };
  }, [load]);
  return { data, failed, reload: load, as };
}

function useCountdown(iso: string | undefined) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  if (!iso) return null;
  const ms = Math.max(0, new Date(iso).getTime() - Date.now());
  return { d: Math.floor(ms / DAY), h: Math.floor((ms % DAY) / 3_600_000), m: Math.floor((ms % 3_600_000) / 60_000) };
}

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <section className={cn("rounded-2xl border border-white/[0.06] bg-white/[0.018]", className)}>{children}</section>;
}

function CardTitle({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-[13px] font-bold text-main">{children}</h2>
      {right}
    </div>
  );
}

function Header({ data }: { data: Board }) {
  const { t, i18n } = useTranslation("profile");
  const countdown = useCountdown(data.round?.endsAt);
  const notStarted = new Date(data.event.startsAt).getTime() > Date.now();
  return (
    <section className="relative overflow-hidden rounded-3xl border border-white/[0.07] bg-[#121317] p-5 sm:p-7">
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_100%_0%,rgba(201,162,94,0.22),transparent_55%)]" />
      <div className="relative flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-xl">
          <p className="text-[11px] font-bold tracking-[0.18em] text-gold">{t("inviteRace.title")}</p>
          <h1 className="mt-2 text-[26px] font-black leading-tight tracking-tight text-main sm:text-[34px]">{t("inviteRace.headline")}</h1>
          <p className="mt-2 text-sm leading-relaxed text-sub/70">{t("inviteRace.sub")}</p>
        </div>
        <div className="shrink-0 sm:text-right">
          {notStarted ? (
            <p className="text-sm text-main">{t("inviteRace.startsOn", { date: new Date(data.event.startsAt).toLocaleString(i18n.language, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) })}</p>
          ) : data.round && data.event.status !== "ended" && countdown ? (
            <>
              <p className="text-[11px] font-semibold text-sub/55">{t("inviteRace.countdownLabel")}</p>
              <p className="mt-1 flex items-baseline gap-1 font-black tabular-nums text-main sm:justify-end">
                <span className="text-3xl">{countdown.d}</span><span className="mr-1.5 text-xs text-sub/55">{t("inviteRace.unit.d")}</span>
                <span className="text-3xl">{countdown.h}</span><span className="mr-1.5 text-xs text-sub/55">{t("inviteRace.unit.h")}</span>
                <span className="text-3xl">{countdown.m}</span><span className="text-xs text-sub/55">{t("inviteRace.unit.m")}</span>
              </p>
            </>
          ) : <p className="text-sm text-sub/70">{t("inviteRace.ended")}</p>}
        </div>
      </div>
      <div className="relative mt-6"><ShareBar code={data.me.referralCode} rules={data.event.rules} /></div>
    </section>
  );
}

/**
 * Your tickets: the number, the climb, and the chart. The prize estimate sits
 * beside it — it is what the tickets are worth right now, and it naturally
 * dips as more people join, so it is never the line people watch.
 */
function PrizeCard({ data }: { data: Board }) {
  const { t } = useTranslation("profile");
  const [range, setRange] = useState<"day" | "round">("day");
  const [hover, setHover] = useState<PrizePoint | null>(null);
  const shown = hover?.tickets ?? data.me.tickets;

  const gained = useMemo(() => {
    const pts = data.prizeHistory;
    if (pts.length < 2) return 0;
    const base = range === "day" ? ([...pts].reverse().find((p) => Date.parse(p.at) <= Date.now() - DAY) ?? pts[0]!) : pts[0]!;
    return pts[pts.length - 1]!.tickets - base.tickets;
  }, [data.prizeHistory, range]);

  const c = data.change;
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-sub/60">{t("inviteRace.stats.mine")}</p>
          <p className="mt-1 text-[40px] font-black leading-none tabular-nums tracking-tight text-main">{shown.toLocaleString()}</p>
          <p className="mt-2 min-h-[20px] text-[13px] tabular-nums">
            {!hover && gained > 0 && (
              <span className="font-bold text-emerald-400">
                +{t("inviteRace.ticketsN", { n: gained.toLocaleString() })}
                <span className="ml-1 font-medium text-sub/50">{range === "day" ? t("inviteRace.chart.today") : t("inviteRace.chart.thisRound")}</span>
              </span>
            )}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-xs font-semibold text-sub/60">{t("inviteRace.estimate")}</p>
          <p className="mt-1 text-2xl font-black leading-none tabular-nums text-gold">{usd(data.me.estimateUsd)}</p>
        </div>
      </div>

      <div className="mt-3 flex justify-end">
        <div className="flex rounded-lg bg-white/[0.04] p-0.5 text-[11px] font-bold">
          {(["day", "round"] as const).map((r) => (
            <button key={r} type="button" onClick={() => setRange(r)}
              className={cn("rounded-md px-2.5 py-1", range === r ? "bg-white/10 text-main" : "text-sub/50 hover:text-sub")}>
              {r === "day" ? t("inviteRace.chart.day") : t("inviteRace.chart.round")}
            </button>
          ))}
        </div>
      </div>

      <div className="-mx-1 mt-2">
        <PrizeChart points={data.prizeHistory} markers={data.activity} range={range} onHover={setHover} />
      </div>

      {c && c.ticketsGained > 0 && (
        <p className="mt-3 flex items-center gap-2 border-t border-white/[0.05] pt-3 text-[12.5px] text-sub/70">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
          {t("inviteRace.why.friends", { n: c.ticketsGained, usd: signed(c.fromFriendsUsd) })}
        </p>
      )}

      {/* The numbers the estimate is made of, right under the chart. */}
      <div className="mt-4 grid grid-cols-3 gap-px overflow-hidden rounded-xl bg-white/[0.06]">
        {[
          { label: t("inviteRace.stats.all"), value: data.totals.tickets.toLocaleString(), sub: t("inviteRace.stats.people", { n: data.totals.participants.toLocaleString() }) },
          { label: t("inviteRace.stats.value"), value: `$${data.totals.usdPerTicket.toFixed(2)}`, sub: null as string | null },
          { label: t("inviteRace.stats.rank"), value: data.me.rank ? `#${data.me.rank}` : "—", sub: null },
        ].map((x) => (
          <div key={x.label} className="bg-[#15161b] px-3.5 py-2.5">
            <p className="text-[11px] text-sub/55">{x.label}</p>
            <p className="mt-0.5 text-lg font-black tabular-nums text-main">{x.value}</p>
            {x.sub && <p className="text-[10.5px] text-sub/40">{x.sub}</p>}
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11.5px] text-sub/45">
        {t("inviteRace.why.formula", { tickets: data.me.tickets.toLocaleString(), v: `$${data.totals.usdPerTicket.toFixed(2)}` })}
        {data.me.rankUsd > 0 && ` ${t("inviteRace.why.plusRank", { usd: usd(data.me.rankUsd) })}`}
      </p>
    </Card>
  );
}

/** Top 5, then you (if you're not in it), then how far to the next place. */
function Leaderboard({ data }: { data: Board }) {
  const { t } = useTranslation("profile");
  const { leaders, me } = data;
  const { rankPrizesUsd, rankMinTickets } = data.event.rules;
  // Each top spot's rank prize, on its row, so the total reads as share + prize.
  const rankNote = (rank: number, tickets: number) => {
    const prize = rankPrizesUsd[rank - 1];
    if (!prize || tickets < rankMinTickets) return null;
    return <span className="text-gold/80">{t("inviteRace.rankPrize.won", { usd: usd(prize) })}</span>;
  };
  const meInTop = me.rank != null && me.rank <= leaders.length;
  const row = (rank: number, name: string, image: string | null, tickets: number, prize: number, mine: boolean, key: string) => (
    <li key={key} className={cn("flex items-center gap-3 rounded-xl px-2 py-2", mine && "bg-gold/[0.08]")}>
      <span className={cn("w-4 text-center text-[13px] font-black tabular-nums",
        rank === 1 ? "text-gold" : rank === 2 ? "text-zinc-300" : rank === 3 ? "text-amber-600" : "text-sub/45")}>{rank}</span>
      {image ? <img src={image} alt="" className="h-7 w-7 rounded-full object-cover" />
        : <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/[0.06] text-[11px] font-bold text-sub/70">{name.slice(0, 1)}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold text-main">{mine ? t("inviteRace.you") : name}</span>
        {rankNote(rank, tickets) && <span className="block truncate text-[10.5px] font-medium">{rankNote(rank, tickets)}</span>}
      </span>
      <span className="text-[11px] tabular-nums text-sub/50">{t("inviteRace.ticketsN", { n: tickets.toLocaleString() })}</span>
      <span className="w-16 text-right text-[13px] font-bold tabular-nums text-gold">{usd(prize)}</span>
    </li>
  );
  return (
    <Card className="p-4">
      <CardTitle right={<Crown className="h-4 w-4 text-gold/80" />}>{t("inviteRace.top")}</CardTitle>
      {leaders.length === 0 ? <p className="mt-3 text-[13px] text-sub/55">{t("inviteRace.topEmpty")}</p> : (
        <ol className="mt-2 flex flex-col">
          {leaders.map((l) => row(l.rank, l.name, l.image, l.tickets, l.estimateUsd, me.rank === l.rank, l.userId))}
          {!meInTop && me.rank != null && (
            <>
              <li aria-hidden className="py-0.5 text-center text-sub/30">···</li>
              {row(me.rank, "", null, me.tickets, me.estimateUsd, true, "me")}
            </>
          )}
        </ol>
      )}
      <p className="mt-2 border-t border-white/[0.05] pt-3 text-[12px] text-sub/65">
        {me.nextRank
          ? (me.nextRank.prizeUsd > 0
            ? t("inviteRace.toRank", { n: me.nextRank.ticketsNeeded, rank: me.nextRank.rank, prize: usd(me.nextRank.prizeUsd) })
            : t("inviteRace.toRankNoPrize", { n: me.nextRank.ticketsNeeded, rank: me.nextRank.rank }))
          : me.rank === 1 ? t("inviteRace.leading") : t("inviteRace.firstTicket")}
      </p>
    </Card>
  );
}

function Activity({ data }: { data: Board }) {
  const { t, i18n } = useTranslation("profile");
  if (!data.activity.length) return null;
  const ago = (iso: string) => {
    const m = Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 60_000));
    if (m < 60) return t("inviteRace.ago.m", { n: m });
    if (m < 1440) return t("inviteRace.ago.h", { n: Math.round(m / 60) });
    return new Date(iso).toLocaleDateString(i18n.language, { month: "numeric", day: "numeric" });
  };
  return (
    <Card className="p-4">
      <CardTitle>{t("inviteRace.activityTitle")}</CardTitle>
      <ul className="mt-2 flex flex-col">
        {data.activity.slice(0, 6).map((a, i) => (
          <li key={i} className="flex items-center gap-2.5 py-1.5 text-[12.5px]">
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", a.kind === "came_back" ? "bg-gold" : "bg-white/40")} />
            <span className="min-w-0 flex-1 truncate text-sub/85">
              {t(a.kind === "came_back" ? "inviteRace.act.cameBack" : "inviteRace.act.joined", { name: a.name })}
            </span>
            <span className="shrink-0 font-bold tabular-nums text-gold">+{a.tickets}</span>
            <span className="shrink-0 whitespace-nowrap text-right text-[11px] tabular-nums text-sub/40">{ago(a.at)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * Only shown when there is something to do: a $10+ prize waiting for the
 * winner to pick. Gift cards are whole dollars; the cents come as mushies.
 * Under-$10 prizes are paid straight into the wallet and need no card here.
 */
function Claim({ data, reload }: { data: Board; reload: () => void }) {
  const { t, i18n } = useTranslation("profile");
  const pending = data.results.filter((r) => r.method === "choice_pending");
  const [busy, setBusy] = useState<string | null>(null);
  if (!pending.length) return null;
  const rate = data.event.rules.mushiesPerUsd ?? 1000;
  const choose = async (roundNo: number, choice: "cash" | "mushies") => {
    setBusy(`${roundNo}:${choice}`);
    try {
      const res = await fetch(`${API}/api/invite-race/choose`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roundNo, choice }),
      });
      if (!res.ok) throw new Error();
      reload();
    } catch {
      feedback.error(t("inviteRace.chooseFailed"));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card className="border-gold/25 p-4">
      <CardTitle right={<Gift className="h-4 w-4 text-gold" />}>{t("inviteRace.claim.title")}</CardTitle>
      {pending.map((r) => {
        const cents = Math.round(r.totalUsd * 100);
        const card = Math.floor(cents / 100);
        const change = Math.round(((cents % 100) * rate) / 100);
        return (
          <div key={r.roundNo} className="mt-3">
            <p className="text-2xl font-black tabular-nums text-gold">{usd(r.totalUsd)}</p>
            <div className="mt-3 grid gap-2">
              <button type="button" disabled={!!busy} onClick={() => choose(r.roundNo, "cash")}
                className="flex items-center justify-between gap-2 rounded-xl border border-white/12 px-3.5 py-2.5 text-left text-[13px] font-semibold text-main hover:bg-white/[0.04] disabled:opacity-40">
                <span>{change > 0 ? t("inviteRace.claim.giftCardPlus", { usd: `$${card}`, m: change.toLocaleString() }) : t("inviteRace.claim.giftCard", { usd: `$${card}` })}</span>
                {busy === `${r.roundNo}:cash` && <Loader2 className="h-4 w-4 animate-spin" />}
              </button>
              <button type="button" disabled={!!busy} onClick={() => choose(r.roundNo, "mushies")}
                className="flex items-center justify-between gap-2 rounded-xl border border-white/12 px-3.5 py-2.5 text-left text-[13px] font-semibold text-main hover:bg-white/[0.04] disabled:opacity-40">
                <span>{t("inviteRace.claim.allMushies", { m: Math.round((cents * rate) / 100).toLocaleString() })}</span>
                {busy === `${r.roundNo}:mushies` && <Loader2 className="h-4 w-4 animate-spin" />}
              </button>
            </div>
            <p className="mt-2.5 text-[11px] leading-relaxed text-sub/55">{t("inviteRace.giftCardHow")}</p>
            {r.chooseBy && (
              <p className="mt-1 text-[11px] text-sub/45">
                {t("inviteRace.chooseBy", { date: new Date(r.chooseBy).toLocaleDateString(i18n.language, { month: "short", day: "numeric" }) })}
              </p>
            )}
          </div>
        );
      })}
    </Card>
  );
}

function Rules({ data }: { data: Board }) {
  const { t } = useTranslation("profile");
  const rules = data.event.rules;
  return (
    <Card className="p-4">
      <CardTitle>{t("inviteRace.how.splitTitle")}</CardTitle>
      <div className="mt-2"><PrizeSplit rules={rules} /></div>
      <p className="mt-5 text-[13px] font-bold text-main">{t("inviteRace.payout.title")}</p>
      <ul className="mt-1.5 flex flex-col gap-1 text-xs leading-relaxed text-sub/70">
        <li>{t("inviteRace.payout.small", { cash: `$${rules.cashThresholdUsd}`, rate: (rules.mushiesPerUsd ?? 1000).toLocaleString() })}</li>
        <li>{t("inviteRace.payout.large", { cash: `$${rules.cashThresholdUsd}` })}</li>
      </ul>
      <a href="https://www.tremendous.com/catalog" target="_blank" rel="noopener noreferrer"
        className="mt-1.5 inline-block text-xs font-semibold text-gold hover:text-gold/80">{t("inviteRace.payout.catalog")} ↗</a>
      <details className="group mt-4 border-t border-white/[0.05] pt-3">
        <summary className="flex cursor-pointer list-none items-center justify-between text-[13px] font-bold text-gold hover:text-gold/80">
          {t("inviteRace.rules")}<ChevronDown className="h-4 w-4 text-gold transition-transform group-open:rotate-180" />
        </summary>
        <div className="mt-2"><RulesList rules={rules} /></div>
        <p className="mt-2 text-[11px] text-sub/40">{t("inviteRace.estimateNote")}</p>
      </details>
    </Card>
  );
}

export function InviteRacePage() {
  const { t } = useTranslation("profile");
  const { data, failed, reload, as } = useBoard();

  if (data === undefined) {
    return (
      <div className="flex h-full items-center justify-center">
        {failed ? <p className="text-sm text-sub/60">{t("inviteRace.loadFailed")}</p> : <Loader2 className="h-5 w-5 animate-spin text-sub/50" />}
      </div>
    );
  }
  if (data === null) return <div className="flex h-full items-center justify-center p-6 text-center text-sm text-sub/60">{t("inviteRace.none")}</div>;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-5 px-4 pb-20 pt-5 sm:px-6 lg:px-10 lg:pt-8">
        {data.event.status === "preview" && (
          <p className="rounded-xl border border-amber-400/25 bg-amber-400/[0.06] px-3 py-2 text-xs font-semibold text-amber-200/90">{t("inviteRace.preview")}</p>
        )}
        <Header data={data} />
        <section className="rounded-2xl border border-white/[0.06] bg-white/[0.018] p-4 sm:p-5">
          <CardTitle>{t("inviteRace.how.title")}</CardTitle>
          <div className="mt-3"><HowItWorksSteps rules={data.event.rules} /></div>
        </section>
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="flex min-w-0 flex-col gap-5">
            <PrizeCard data={data} />
            <div className="flex flex-col gap-5 lg:hidden">
              <Claim data={data} reload={reload} />
              <Rules data={data} />
              <Leaderboard data={data} />
            </div>
            <FriendsPanel funnel={data.funnel} as={as} refreshKey={`${data.totals.tickets}:${data.me.tickets}:${data.funnel.signedUp}`} />
            <div className="lg:hidden"><Activity data={data} /></div>
          </div>
          <aside className="hidden min-w-0 flex-col gap-5 lg:flex">
            <Claim data={data} reload={reload} />
            <Rules data={data} />
            <Leaderboard data={data} />
            <Activity data={data} />
          </aside>
        </div>
      </div>
    </div>
  );
}
