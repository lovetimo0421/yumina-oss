import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useHalloweenDecor } from "@/lib/halloween-decor";
import { useMediaQuery } from "@/hooks/use-media-query";
import "./halloween-decor.css";

/**
 * Halloween art for the app shell. Every piece checks useHalloweenDecor()
 * itself, so a caller drops it in and it disappears on Nov 3 or when the
 * viewer turns decorations off in Settings.
 */

/** A small jack-o'-lantern. Shared by the decorations and the hosted pumpkin hunt. */
export function PumpkinGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden xmlns="http://www.w3.org/2000/svg">
      <path d="M15.2 7.4c-.1-2 .9-3.8 2.7-4.4l.9 1.7c-1 .5-1.6 1.5-1.6 2.7z" fill="#6E8B3D" />
      <path d="M18.6 5.6c1.6-1.3 3.6-1.2 4.6-.4-1.5.2-2.9 1-3.6 2z" fill="#86A84B" />
      <ellipse cx="10.6" cy="18.6" rx="7.6" ry="9.6" fill="#D9641A" />
      <ellipse cx="21.4" cy="18.6" rx="7.6" ry="9.6" fill="#D9641A" />
      <ellipse cx="16" cy="18.4" rx="7.4" ry="10.6" fill="#F08A24" />
      <path d="M12.6 9.6c-1.6 2.2-2.4 5-2.4 8.4" stroke="#FFB15C" strokeWidth="1.2" strokeLinecap="round" fill="none" opacity="0.55" />
      <path d="M10.4 16.6l2.6-3.2 2.4 3.2z M16.6 16.6l2.4-3.2 2.6 3.2z" fill="#FFE08A" />
      <path d="M9.6 20.2c2 3.2 10.8 3.2 12.8 0l-1.6.9-1.3-1-1.4 1.2-1.3-1.1-1.5 1.1-1.3-1.1-1.4 1.1-1.4-1z" fill="#FFE08A" />
    </svg>
  );
}

/** A round little ghost with blushing cheeks. */
export function GhostGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden xmlns="http://www.w3.org/2000/svg">
      <path d="M6 15a10 10 0 0 1 20 0v12l-3.3-2.4L19.4 27 16 24.6 12.6 27l-3.3-2.4L6 27z" fill="#F5F1E8" />
      <ellipse cx="12.6" cy="15" rx="1.5" ry="2.1" fill="#2A2530" />
      <ellipse cx="19.4" cy="15" rx="1.5" ry="2.1" fill="#2A2530" />
      <circle cx="10.4" cy="18.6" r="1.4" fill="#F4A6B0" opacity="0.75" />
      <circle cx="21.6" cy="18.6" r="1.4" fill="#F4A6B0" opacity="0.75" />
      <ellipse cx="16" cy="19.4" rx="0.9" ry="1.1" fill="#2A2530" />
    </svg>
  );
}

function WitchHatGlyph({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 40 30" className={className} aria-hidden xmlns="http://www.w3.org/2000/svg">
      <ellipse cx="20" cy="25.5" rx="17" ry="3.6" fill="#2E2340" stroke="#4E3B6E" strokeWidth="0.8" />
      <path d="M11 25c1.8-7 4.8-14.6 8.6-19.6 1.6-2 4.6-3.2 7.4-2.4-2.6.4-4.2 2-4.6 4.4L28.6 25z" fill="#2E2340" stroke="#4E3B6E" strokeWidth="0.8" strokeLinejoin="round" />
      <path d="M12.2 21.2h15.6l.8 3.6H11.2z" fill="#C9A25E" />
      <rect x="18" y="20.6" width="4.4" height="4.6" rx="0.6" fill="none" stroke="#F5E6B8" strokeWidth="0.9" />
      <path d="M24.6 9.2l.5 1.1 1.2.1-.9.8.3 1.2-1.1-.6-1.1.6.3-1.2-.9-.8 1.2-.1z" fill="#F5E6B8" />
    </svg>
  );
}

/** A crooked witch hat for the sidebar logo. */
export function LogoWitchHat() {
  const on = useHalloweenDecor();
  if (!on) return null;
  return <WitchHatGlyph className="halloween-logo-hat" />;
}

/**
 * The same hat tipped onto an avatar: small in the top bar by default, or
 * sized by the caller (profile pages pass their own class).
 */
export function AvatarWitchHat({ className = "halloween-avatar-hat" }: { className?: string }) {
  const on = useHalloweenDecor();
  if (!on) return null;
  return <WitchHatGlyph className={className} />;
}

function BatGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 24" className={className} aria-hidden xmlns="http://www.w3.org/2000/svg">
      <path d="M22 12C18 6 12 4 3 6c3 1.6 4 3.4 3.6 5.6 2-1.4 4.4-1.2 5.6.6 1.4-1.4 4-1.4 5.4.4z" fill="#8E74B8" />
      <path d="M26 12c4-6 10-8 19-6-3 1.6-4 3.4-3.6 5.6-2-1.4-4.4-1.2-5.6.6-1.4-1.4-4-1.4-5.4.4z" fill="#8E74B8" />
      <ellipse cx="24" cy="13" rx="3.6" ry="4.6" fill="#A58BCB" />
      <path d="M21.4 9.4l.9-2.6 1.3 2.2zM26.6 9.4l-.9-2.6-1.3 2.2z" fill="#A58BCB" />
      <circle cx="22.7" cy="12" r="0.8" fill="#FFE08A" />
      <circle cx="25.3" cy="12" r="0.8" fill="#FFE08A" />
    </svg>
  );
}

function CandyGlyph({ className, color }: { className?: string; color: string }) {
  return (
    <svg viewBox="0 0 40 24" className={className} aria-hidden xmlns="http://www.w3.org/2000/svg">
      <path d="M11 12L2 5v14zM29 12l9-7v14z" fill={color} opacity="0.85" />
      <ellipse cx="20" cy="12" rx="10" ry="8" fill={color} />
      <path d="M14 7.4c3 1.6 5 5.6 4.6 9.6M21 5c2.4 2 3.6 5.4 3.4 8.6" stroke="#FFF4DC" strokeWidth="1.6" strokeLinecap="round" fill="none" opacity="0.7" />
    </svg>
  );
}

function CandyCornGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 28" className={className} aria-hidden xmlns="http://www.w3.org/2000/svg">
      <path d="M12 1.5c-3 0-9.6 18-9.6 22.4 0 2.2 4.6 2.8 9.6 2.8s9.6-.6 9.6-2.8C21.6 19.5 15 1.5 12 1.5z" fill="#FFF3DC" />
      <path d="M5.2 14.4c2 .8 4.4 1.2 6.8 1.2s4.8-.4 6.8-1.2c1.3 3.6 2.8 7.4 2.8 9.5 0 2.2-4.6 2.8-9.6 2.8s-9.6-.6-9.6-2.8c0-2.1 1.5-5.9 2.8-9.5z" fill="#F08A24" />
      <path d="M2.8 21.6c2.4 1 5.6 1.4 9.2 1.4s6.8-.4 9.2-1.4c.3 1 .4 1.8.4 2.3 0 2.2-4.6 2.8-9.6 2.8s-9.6-.6-9.6-2.8c0-.5.1-1.3.4-2.3z" fill="#FFC25C" />
    </svg>
  );
}

function MoonGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden xmlns="http://www.w3.org/2000/svg">
      <path d="M20.6 4.4A12 12 0 1 0 27.6 22 10 10 0 0 1 20.6 4.4z" fill="#F3D9A0" />
      <circle cx="11" cy="18" r="1.6" fill="#D9B56E" opacity="0.7" />
      <circle cx="15.4" cy="24" r="1.1" fill="#D9B56E" opacity="0.7" />
      <path d="M25 6.6l.6 1.3 1.4.2-1 1 .2 1.4-1.2-.7-1.2.7.2-1.4-1-1 1.4-.2z" fill="#FFF4DC" />
    </svg>
  );
}

/** A cobweb tucked into a corner (top-right by default; flip for top-left). */
export function CobwebCorner({ className = "", flip = false }: { className?: string; flip?: boolean }) {
  const on = useHalloweenDecor();
  if (!on) return null;
  return (
    <svg viewBox="0 0 60 60" className={`halloween-cobweb ${flip ? "halloween-cobweb--left" : ""} ${className}`} aria-hidden xmlns="http://www.w3.org/2000/svg">
      <g stroke="rgba(245, 233, 210, 0.38)" strokeWidth="0.9" fill="none" strokeLinecap="round">
        <path d="M60 0L4 4M60 0L16 26M60 0L34 44M60 0L56 58" />
        <path d="M44 1.2c1.2 4.6 4.4 6.4 8.6 6.2-1.6 4.8.4 8.4 4.6 10.6" />
        <path d="M30 2.2c1.6 7.6 7.4 11.2 14 11.2-2.6 7.2.2 13.6 7.6 17.4-1 6.2 0 9 3 13" />
        <path d="M16 3.2c2.4 10.2 10.6 15.6 20.6 15.8-3.6 10.4.4 18.6 9.8 24-1.4 6.6-.2 10.6 3.6 15" />
      </g>
    </svg>
  );
}

const STICKERS = ["ghost", "bat", "candy-pink", "candy-corn", "moon", "candy-purple", "web"] as const;

/**
 * A little Halloween sticker for a card's corner, picked from `seed` (an id)
 * so each post keeps the same one. Purely decorative: no pumpkins here, so a
 * sticker never passes for one of the hunt's pumpkins.
 */
export function HalloweenSticker({ seed, className = "" }: { seed: string; className?: string }) {
  const on = useHalloweenDecor();
  if (!on) return null;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  const kind = STICKERS[Math.abs(h) % STICKERS.length];
  const tilt = (Math.abs(h >> 4) % 25) - 12;
  if (kind === "web") return <CobwebCorner className={`halloween-sticker-web ${className}`} />;
  const glyph =
    kind === "ghost" ? <GhostGlyph className="h-full w-full" />
    : kind === "bat" ? <BatGlyph className="h-full w-full" />
    : kind === "candy-corn" ? <CandyCornGlyph className="h-full w-full" />
    : kind === "moon" ? <MoonGlyph className="h-full w-full" />
    : <CandyGlyph className="h-full w-full" color={kind === "candy-pink" ? "#F4A6B0" : "#A58BCB"} />;
  return (
    <span className={`halloween-sticker halloween-sticker--${kind} ${className}`} style={{ rotate: `${tilt}deg` }} aria-hidden>
      {glyph}
    </span>
  );
}

type PumpkinMood = "cheer" | "decor" | "sleepy";

/**
 * A round, soft-faced pumpkin for the decorations. Deliberately unlike the
 * jagged jack-o'-lantern the pumpkin hunt uses, so nobody mistakes one for
 * the other.
 */
function CutePumpkinGlyph({ mood, className }: { mood: PumpkinMood; className?: string }) {
  const ink = "#5A2A0E";
  return (
    <svg viewBox="0 0 40 32" className={className} aria-hidden xmlns="http://www.w3.org/2000/svg">
      <path d="M19 8.6c-.3-2.4.4-4.4 2-5.4l1.4 1.2c-1 .8-1.4 2.2-1.2 4.2z" fill="#6E8B3D" />
      <path d="M22.2 5.6c2-1.6 4.6-1.4 5.8-.2-1.8 0-3.4.8-4.4 2z" fill="#86A84B" />
      <ellipse cx="12.6" cy="19.6" rx="10.4" ry="10.4" fill="#D9641A" />
      <ellipse cx="27.4" cy="19.6" rx="10.4" ry="10.4" fill="#D9641A" />
      <ellipse cx="20" cy="19.4" rx="10.2" ry="11.4" fill="#F08A24" />
      <path d="M15.6 10.6c-1.4 2.4-2 5.2-1.8 8.6" stroke="#FFB15C" strokeWidth="1.3" strokeLinecap="round" fill="none" opacity="0.55" />
      <circle cx="12.4" cy="22.4" r="2" fill="#FF8F7A" opacity="0.55" />
      <circle cx="27.6" cy="22.4" r="2" fill="#FF8F7A" opacity="0.55" />
      {mood === "cheer" && (
        <g stroke={ink} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none">
          <path d="M13.8 19.2q2-2.8 4 0M22.2 19.2q2-2.8 4 0" />
          <path d="M17.4 22.4q2.6 3.4 5.2 0z" fill={ink} />
        </g>
      )}
      {mood === "decor" && (
        <g>
          <circle cx="15.6" cy="18.8" r="1.6" fill={ink} />
          <circle cx="24.4" cy="18.8" r="1.6" fill={ink} />
          <circle cx="16.1" cy="18.2" r="0.5" fill="#FFF4DC" />
          <circle cx="24.9" cy="18.2" r="0.5" fill="#FFF4DC" />
          <path d="M18 22.6q1 1.3 2 0q1 1.3 2 0" stroke={ink} strokeWidth="1.3" strokeLinecap="round" fill="none" />
        </g>
      )}
      {mood === "sleepy" && (
        <g stroke={ink} strokeWidth="1.5" strokeLinecap="round" fill="none">
          <path d="M13.8 18.6q2 1.8 4 0M22.2 18.6q2 1.8 4 0" />
          <ellipse cx="20" cy="23.2" rx="0.9" ry="1.1" fill={ink} stroke="none" />
        </g>
      )}
    </svg>
  );
}

const PATCH: { mood: PumpkinMood; className: string }[] = [
  { mood: "decor", className: "halloween-patch__pumpkin--left" },
  { mood: "sleepy", className: "halloween-patch__pumpkin--right" },
  { mood: "cheer", className: "halloween-patch__pumpkin--big" },
];

/**
 * Three pumpkins sitting at the foot of the sidebar, a ghost hiding behind
 * them. Poke one and it bounces and says something. None of them is one of
 * the hunt's pumpkins, and the round-eyed one says so.
 */
export function SidebarPumpkinPatch() {
  const on = useHalloweenDecor();
  const { t } = useTranslation("common");
  const [bouncing, setBouncing] = useState<PumpkinMood | null>(null);
  const [bubble, setBubble] = useState<{ mood: PumpkinMood; x: number; y: number; n: number } | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(hideTimer.current), []);
  if (!on) return null;

  const poke = (mood: PumpkinMood, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    setBouncing(null);
    requestAnimationFrame(() => setBouncing(mood));
    setBubble((prev) => ({ mood, x: rect.right + 8, y: rect.top + rect.height / 2, n: (prev?.n ?? 0) + 1 }));
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setBubble(null), 2400);
  };

  return (
    <div className="halloween-patch">
      <svg viewBox="0 0 80 20" className="halloween-patch__vine" aria-hidden xmlns="http://www.w3.org/2000/svg">
        <path d="M4 16c10-2 14-10 24-8s10 10 22 8 14-8 26-6" stroke="#6E8B3D" strokeWidth="1.6" fill="none" strokeLinecap="round" />
        <path d="M27 8c-2-4 0-6 2-6-.4 2 0 4-2 6zM52 15c3 1 5-1 5-3-2 1-3 .4-5 3z" fill="#86A84B" />
        <path d="M66 9c2-1 3 .6 2 2-1.2 1.4-3 .4-2.4-1" stroke="#86A84B" strokeWidth="1" fill="none" strokeLinecap="round" />
      </svg>
      <GhostGlyph className="halloween-patch__ghost" />
      {PATCH.map(({ mood, className }) => (
        <button
          key={mood}
          type="button"
          aria-label={t("halloween.decor.label")}
          className={`halloween-patch__pumpkin ${className} ${bouncing === mood ? "halloween-patch__pumpkin--boing" : ""}`}
          onClick={(e) => poke(mood, e.currentTarget)}
          onAnimationEnd={(e) => { if (e.animationName === "halloween-boing") setBouncing(null); }}
        >
          <CutePumpkinGlyph mood={mood} className="h-full w-full" />
          {mood === "sleepy" && <span className="halloween-patch__zzz" aria-hidden>z</span>}
        </button>
      ))}
      {bubble && createPortal(
        <div key={bubble.n} className="halloween-patch__bubble" style={{ left: bubble.x, top: bubble.y }} role="status">
          {t(`halloween.decor.${bubble.mood}`)}
        </div>,
        document.body,
      )}
    </div>
  );
}

type GarlandItem = "flag" | "spider" | "ghost" | PumpkinMood;

// Five scallops of string across the banner; each holds three charms.
const GARLAND: GarlandItem[][] = [
  ["flag", "cheer", "flag"],
  ["flag", "ghost", "flag"],
  ["flag", "decor", "flag"],
  ["flag", "sleepy", "flag"],
  ["flag", "spider", "flag"],
];
// Phones get a shorter string over the right half, clear of the banner copy.
const GARLAND_PHONE: GarlandItem[][] = [
  ["flag", "ghost", "flag"],
  ["flag", "cheer", "flag"],
  ["flag", "spider", "flag"],
];
const GARLAND_SAG = 20;
const FLAG_COLORS = ["#F08A24", "#7A5CA8", "#F5E6B8"];

/** A string of bunting and little lanterns draped along the top of the home banner. */
export function HeroGarland() {
  const on = useHalloweenDecor();
  const phone = useMediaQuery("(max-width: 639px)");
  if (!on) return null;
  const garland = phone ? GARLAND_PHONE : GARLAND;
  const span = 100 / garland.length;
  // The string is a row of quadratic scallops; a charm at fraction f of a
  // scallop hangs at depth 4 * SAG * f * (1 - f) below the pins.
  const path = `M0 3 ${garland.map((_, i) => {
    const x0 = i * span * 10;
    const x1 = (i + 1) * span * 10;
    return `Q${(x0 + x1) / 2} ${3 + 2 * GARLAND_SAG} ${x1} 3`;
  }).join(" ")}`;
  let n = 0;
  return (
    <div className={`halloween-garland ${phone ? "halloween-garland--phone" : ""}`} aria-hidden>
      <svg viewBox="0 0 1000 60" preserveAspectRatio="none" className="halloween-garland__string" xmlns="http://www.w3.org/2000/svg">
        <path d={path} stroke="rgba(245, 230, 184, 0.5)" strokeWidth="1.4" fill="none" vectorEffect="non-scaling-stroke" />
      </svg>
      {garland.flatMap((items, i) => items.map((item, j) => {
        const f = (j + 1) / (items.length + 1);
        const left = `${(i + f) * span}%`;
        const top = 2 + 4 * GARLAND_SAG * f * (1 - f);
        const k = n++;
        const style = { left, top, animationDelay: `${-((k * 0.37) % 3)}s` };
        if (item === "flag") {
          return (
            <svg key={k} viewBox="0 0 16 20" className="halloween-garland__flag" style={style} xmlns="http://www.w3.org/2000/svg">
              <path d="M0 0h16L8 19z" fill={FLAG_COLORS[k % FLAG_COLORS.length]} stroke="rgba(255,255,255,0.14)" strokeWidth="0.8" />
            </svg>
          );
        }
        if (item === "spider") {
          return (
            <div key={k} className="halloween-garland__spider-drop" style={{ left, top }}>
              <div className="halloween-garland__spider">
                <span className="halloween-garland__thread" />
                <svg viewBox="0 0 24 20" xmlns="http://www.w3.org/2000/svg">
                  <path d="M9 10L3 6M9 12L2 12M9 13l-6 4M10 14l-4 5M15 10l6-4M15 12l7 0M15 13l6 4M14 14l4 5" stroke="#1C1820" strokeWidth="1.3" strokeLinecap="round" fill="none" />
                  <ellipse cx="12" cy="12" rx="4.4" ry="4.8" fill="#1C1820" />
                  <circle cx="10.4" cy="10.6" r="1.3" fill="#FFF4DC" />
                  <circle cx="13.6" cy="10.6" r="1.3" fill="#FFF4DC" />
                  <circle cx="10.6" cy="10.9" r="0.6" fill="#1C1820" />
                  <circle cx="13.8" cy="10.9" r="0.6" fill="#1C1820" />
                </svg>
              </div>
            </div>
          );
        }
        return (
          <div key={k} className="halloween-garland__charm" style={style}>
            <span className="halloween-garland__cord" />
            {item === "ghost"
              ? <GhostGlyph className="halloween-garland__ghost" />
              : <CutePumpkinGlyph mood={item} className="halloween-garland__lantern" />}
          </div>
        );
      }))}
    </div>
  );
}

const BAT_KEY = "yumina:halloween-bat";

/** One bat across the top of the window, once per visit. */
export function BatFlyby() {
  const on = useHalloweenDecor();
  const [flying, setFlying] = useState(false);
  useEffect(() => {
    if (!on) return;
    try {
      if (sessionStorage.getItem(BAT_KEY)) return;
      sessionStorage.setItem(BAT_KEY, "1");
    } catch { return; }
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const start = setTimeout(() => setFlying(true), 2500);
    const stop = setTimeout(() => setFlying(false), 2500 + 7000);
    return () => { clearTimeout(start); clearTimeout(stop); };
  }, [on]);
  if (!on || !flying) return null;
  return (
    <div className="halloween-bat" aria-hidden>
      <svg viewBox="0 0 48 24" xmlns="http://www.w3.org/2000/svg">
        <g className="halloween-bat__wing halloween-bat__wing--left">
          <path d="M22 12C18 6 12 4 3 6c3 1.6 4 3.4 3.6 5.6 2-1.4 4.4-1.2 5.6.6 1.4-1.4 4-1.4 5.4.4z" fill="#8E74B8" />
        </g>
        <g className="halloween-bat__wing halloween-bat__wing--right">
          <path d="M26 12c4-6 10-8 19-6-3 1.6-4 3.4-3.6 5.6-2-1.4-4.4-1.2-5.6.6-1.4-1.4-4-1.4-5.4.4z" fill="#8E74B8" />
        </g>
        <ellipse cx="24" cy="13" rx="3.6" ry="4.6" fill="#A58BCB" />
        <path d="M21.4 9.4l.9-2.6 1.3 2.2zM26.6 9.4l-.9-2.6-1.3 2.2z" fill="#A58BCB" />
        <circle cx="22.7" cy="12" r="0.8" fill="#FFE08A" />
        <circle cx="25.3" cy="12" r="0.8" fill="#FFE08A" />
      </svg>
    </div>
  );
}

/** The route-loading spinner's stand-in: a pumpkin rocking side to side. */
export function HalloweenSpinner() {
  return <PumpkinGlyph className="halloween-spinner" />;
}

/** A ghost peeking over an empty state. Renders nothing out of season. */
export function EmptyStateGhost({ className = "" }: { className?: string }) {
  const on = useHalloweenDecor();
  if (!on) return null;
  return <GhostGlyph className={`halloween-empty-ghost ${className}`} />;
}

/** The Library header: a cobweb in the corner and a bat hanging off it. */
export function LibraryHeaderDecor() {
  const on = useHalloweenDecor();
  if (!on) return null;
  return (
    <>
      <CobwebCorner className="halloween-library-web" />
      <span className="halloween-library-thread" aria-hidden />
      <BatGlyph className="halloween-hanging-bat halloween-library-bat" />
    </>
  );
}
