import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/**
 * Your tickets over the round. Tickets only grow as friends join and play, so
 * this line climbs — unlike the prize estimate, which dips every time someone
 * new joins and each ticket's share shrinks (owner 2026-09-24: don't show
 * players a falling line every day). Hover (or drag on a phone) to read any
 * hour. Dots mark the moments a friend joined or came back.
 */

export interface PrizePoint { at: string; estimateUsd: number; tickets: number }
export interface PrizeMarker { at: string; kind: "joined" | "came_back"; name: string; tickets: number }

const W = 760;
const H = 240;
const PAD_T = 16;
const PAD_B = 22;


export function PrizeChart({ points, markers, range, onHover }: {
  points: PrizePoint[];
  markers: PrizeMarker[];
  range: "day" | "round";
  onHover: (p: PrizePoint | null) => void;
}) {
  const { t, i18n } = useTranslation("profile");
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const data = useMemo(() => {
    if (range === "round") return points;
    const since = Date.now() - 86_400_000;
    const inDay = points.filter((p) => Date.parse(p.at) >= since);
    // Start the day window from the last point before it, so the line begins at "24h ago".
    const before = [...points].reverse().find((p) => Date.parse(p.at) < since);
    return before ? [before, ...inDay] : inDay;
  }, [points, range]);

  const geo = useMemo(() => {
    if (data.length < 2) return null;
    const t0 = Date.parse(data[0]!.at);
    const t1 = Date.parse(data[data.length - 1]!.at);
    const vals = data.map((p) => p.tickets);
    // From zero, so the climb reads at its true size.
    const lo = 0;
    const hi = Math.max(...vals);
    const span = hi - lo || 1;
    const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * W;
    const y = (v: number) => PAD_T + (1 - (v - lo) / span) * (H - PAD_T - PAD_B);
    const xy = data.map((p) => [x(Date.parse(p.at)), y(p.tickets)] as const);
    // Monotone cubic (Fritsch–Carlson): smooth like a stock chart, but never
    // overshoots a real value the way a plain spline would.
    const n = xy.length;
    const dx = xy.slice(1).map((p, i) => p[0] - xy[i]![0] || 1e-6);
    const slope = xy.slice(1).map((p, i) => (p[1] - xy[i]![1]) / dx[i]!);
    const tan = xy.map((_, i) => {
      if (i === 0) return slope[0]!;
      if (i === n - 1) return slope[n - 2]!;
      const a = slope[i - 1]!, b = slope[i]!;
      return a * b <= 0 ? 0 : (3 * (dx[i - 1]! + dx[i]!)) / ((2 * dx[i]! + dx[i - 1]!) / a + (dx[i]! + 2 * dx[i - 1]!) / b);
    });
    let line = `M${xy[0]![0].toFixed(1)},${xy[0]![1].toFixed(1)}`;
    for (let i = 0; i < n - 1; i++) {
      const [x0, y0] = xy[i]!, [x1, y1] = xy[i + 1]!, h = dx[i]! / 3;
      line += ` C${(x0 + h).toFixed(1)},${(y0 + tan[i]! * h).toFixed(1)} ${(x1 - h).toFixed(1)},${(y1 - tan[i + 1]! * h).toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
    }
    return { t0, t1, x, y, xy, line };
  }, [data]);

  if (!geo) {
    return <div className="flex h-[240px] items-center justify-center text-sm text-sub/50">—</div>;
  }

  const color = "#C9A25E";
  const inRange = markers.filter((m) => {
    const t = Date.parse(m.at);
    return t >= geo.t0 && t <= geo.t1;
  });
  // Where the line is at a marker's moment: the last point at or before it.
  const valueAt = (t: number) => {
    let v = data[0]!.tickets;
    for (const p of data) { if (Date.parse(p.at) <= t) v = p.tickets; else break; }
    return v;
  };

  const pick = (clientX: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const px = ((clientX - r.left) / r.width) * W;
    let best = 0;
    for (let i = 1; i < geo.xy.length; i++) if (Math.abs(geo.xy[i]![0] - px) < Math.abs(geo.xy[best]![0] - px)) best = i;
    setHover(best);
    onHover(data[best]!);
  };
  const clear = () => { setHover(null); onHover(null); };

  const h = hover != null ? geo.xy[hover]! : null;
  const hp = hover != null ? data[hover]! : null;
  const fmtTime = (iso: string) => new Date(iso).toLocaleString(i18n.language, { weekday: "short", hour: "2-digit", minute: "2-digit" });

  return (
    <div className="relative select-none">
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-[200px] w-full touch-none sm:h-[240px]"
        onPointerMove={(e) => pick(e.clientX)} onPointerDown={(e) => pick(e.clientX)} onPointerLeave={clear}>
        <defs>
          <linearGradient id="ticket-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.22} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <path d={`${geo.line} L${W},${H} L0,${H} Z`} fill="url(#ticket-fill)" />
        <path d={geo.line} fill="none" stroke={color} strokeWidth={2.4} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {h && <line x1={h[0]} x2={h[0]} y1={0} y2={H} stroke="rgba(255,255,255,.28)" vectorEffect="non-scaling-stroke" />}
      </svg>
      {/* Dots are HTML, not SVG: the chart stretches to its box and would squash circles into ovals. */}
      {inRange.map((m, i) => {
        const t = Date.parse(m.at);
        return (
          <span key={i} title={m.name} className={cn("pointer-events-none absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full", m.kind === "came_back" ? "bg-gold" : "bg-white/55")}
            style={{ left: `${(geo.x(t) / W) * 100}%`, top: `${(geo.y(valueAt(t)) / H) * 100}%` }} />
        );
      })}
      {h && (
        <span className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[#16171d]"
          style={{ left: `${(h[0] / W) * 100}%`, top: `${(h[1] / H) * 100}%`, background: color }} />
      )}
      {h && hp && (
        <div className={cn("pointer-events-none absolute top-0 -translate-x-1/2 whitespace-nowrap rounded-lg border border-white/10 bg-[#16171d]/95 px-2.5 py-1.5 text-[11px] shadow-lg")}
          style={{ left: `${Math.min(92, Math.max(8, (h[0] / W) * 100))}%` }}>
          <span className="font-bold tabular-nums text-main">{t("inviteRace.ticketsN", { n: hp.tickets.toLocaleString() })}</span>
          <span className="ml-1.5 tabular-nums text-sub/60">{fmtTime(hp.at)}</span>
        </div>
      )}
    </div>
  );
}
