import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { GhostGlyph, PumpkinGlyph } from "@/components/halloween-decor";
import { useAuthGuard } from "@/hooks/use-auth-guard";
import { halloweenRunning, useHalloweenStore, type PumpkinSpot } from "./halloween-store";
import "./halloween.css";

type Moment =
  | { phase: "treat"; amount: number }
  | { phase: "stolen"; amount: number }
  | { phase: "returned"; amount: number };

/**
 * One of the five pumpkins hidden around the site. It sits quietly where it's
 * placed, wobbles now and then, and opens once: candy most of the time, a
 * ghost that "steals" it and gives back double the rest. Gone once opened.
 */
export function HiddenPumpkin({ spot, size = 22, className = "" }: { spot: PumpkinSpot; size?: number; className?: string }) {
  const { t } = useTranslation("common");
  const { isAuthenticated, requireAuth } = useAuthGuard();
  const state = useHalloweenStore((s) => s.state);
  const open = useHalloweenStore((s) => s.open);
  const ref = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [moment, setMoment] = useState<Moment | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const [gone, setGone] = useState(false);

  if (!halloweenRunning(state)) return null;
  if (gone || (state?.found?.[spot] !== undefined && !moment)) return null;

  const onClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (busy || moment) return;
    if (!isAuthenticated) { requireAuth(t("halloween.loginToOpen")); return; }
    if (state?.eligible === false) { toast(t("halloween.playFirst")); return; }
    const rect = ref.current?.getBoundingClientRect();
    // Clamp so the bubble stays on screen for the pumpkins peeking in from an edge.
    if (rect) setAnchor({ x: Math.min(Math.max(rect.left + rect.width / 2, 110), window.innerWidth - 110), y: Math.max(rect.top, 90) });
    setBusy(true);
    const result = await open(spot);
    setBusy(false);
    if (result.kind === "error") {
      toast.error(result.code === "HALLOWEEN_CLOSED" ? t("halloween.closed") : t("halloween.failed"));
      return;
    }
    if (result.kind === "already") { setGone(true); return; }
    const finish = () => {
      setTimeout(() => { setMoment(null); setGone(true); }, 2600);
      if (result.bonus > 0) {
        setTimeout(() => toast.success(t("halloween.allFound", { bonus: result.bonus })), 900);
      }
    };
    if (result.trick) {
      setMoment({ phase: "stolen", amount: result.amount });
      setTimeout(() => { setMoment({ phase: "returned", amount: result.amount }); finish(); }, 1700);
    } else {
      setMoment({ phase: "treat", amount: result.amount });
      finish();
    }
  };

  return (
    <>
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        aria-label={t("halloween.pumpkinLabel")}
        title={t("halloween.pumpkinLabel")}
        className={`halloween-pumpkin ${moment ? "halloween-pumpkin--open" : ""} ${className}`}
        style={{ width: size, height: size }}
      >
        <PumpkinGlyph className="h-full w-full" />
      </button>
      {moment && anchor && createPortal(
        <div className="halloween-burst" style={{ left: anchor.x, top: anchor.y }} role="status">
          {moment.phase === "stolen" ? (
            <>
              <GhostGlyph className="halloween-burst__ghost" />
              <span className="halloween-burst__text">{t("halloween.stolen")}</span>
            </>
          ) : (
            <>
              {moment.phase === "returned" && <GhostGlyph className="halloween-burst__ghost halloween-burst__ghost--leave" />}
              <span className="halloween-burst__amount">+{moment.amount}</span>
              <span className="halloween-burst__text">
                {moment.phase === "returned" ? t("halloween.returned") : t("halloween.treat")}
              </span>
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}

/**
 * The play and Studio pumpkins peek in from the window edge rather than sit in
 * a header: fullscreen cards hide the play header, and the Studio canvas has
 * no fixed spot every layout shares. The edge is on screen in all of them.
 */
export function PeekingPumpkins() {
  const location = useLocation();
  const path = location.pathname;
  if (path.startsWith("/app/chat/")) {
    return <div className="halloween-peek halloween-peek--right"><HiddenPumpkin spot="play" size={26} /></div>;
  }
  if (/^\/app\/(studio\/|worlds\/[^/]+\/edit)/.test(path)) {
    return <div className="halloween-peek halloween-peek--left"><HiddenPumpkin spot="studio" size={26} /></div>;
  }
  return null;
}
