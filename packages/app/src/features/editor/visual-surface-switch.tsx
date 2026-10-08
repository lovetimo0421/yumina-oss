/**
 * The 画布 switch. It sits top-left in all three editors, right after the
 * back arrow, and looks identical everywhere: on in the canvas, off in the
 * simple and the 完整 editor. Turning it on goes to the canvas; turning it off
 * (only possible on the canvas) goes to 完整. 简单 / 完整 are items in each
 * editor's ⋮ menu rather than a third state here.
 *
 * The canvas ships as a beta: the pill wears a Beta tag, and the first time a
 * creator opens an editor with the switch off, a small card under the pill
 * says what the canvas is and offers to turn it on. Dismissed or tried once,
 * it never comes back on that browser.
 *
 * The switch only reports the flip. Each surface already owns the way out
 * (first save of a new card, the unsaved-changes guard, the canvas's layout
 * save, the route between /edit and /studio).
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Workflow, X } from "lucide-react";
import { cn } from "@/lib/utils";

const INTRO_SEEN_KEY = "yumina-canvas-beta-intro-seen";
/** Phones land on the 完整 editor by design; the card would only cover the name box. */
const INTRO_MIN_WIDTH = 768;

function introSeen(): boolean {
  try {
    return localStorage.getItem(INTRO_SEEN_KEY) === "1";
  } catch {
    return true;
  }
}

function markIntroSeen(): void {
  try {
    localStorage.setItem(INTRO_SEEN_KEY, "1");
  } catch {
    /* a browser that refuses to remember just sees it again */
  }
}

/** Test hook: show the intro again. */
export function resetCanvasBetaIntro(): void {
  try {
    localStorage.removeItem(INTRO_SEEN_KEY);
  } catch {
    /* ignore */
  }
}

interface VisualSurfaceSwitchProps {
  /** `true` on the canvas, `false` in the simple and 完整 editors. */
  on: boolean;
  onToggle: () => void;
  disabled?: boolean;
  /** `data-tour` anchor for the guided tours that point at the switch. */
  tour?: string;
  /** The one-time beta intro under the pill (off by default on the canvas). */
  intro?: boolean;
  className?: string;
  /** What the switch is named: the canvas on a wide screen, Studio on a phone,
   *  where the surface behind it is the phone shell and not a board. */
  surface?: "canvas" | "studio";
}

export function VisualSurfaceSwitch({ on, onToggle, disabled, tour = "studio", intro = !on, className, surface = "canvas" }: VisualSurfaceSwitchProps) {
  const { t } = useTranslation("editor");
  const studio = surface === "studio";
  const [showIntro, setShowIntro] = useState(false);

  useEffect(() => {
    if (!intro || on || introSeen()) return;
    if (typeof window !== "undefined" && window.innerWidth < INTRO_MIN_WIDTH) return;
    setShowIntro(true);
  }, [intro, on]);

  const dismiss = () => {
    markIntroSeen();
    setShowIntro(false);
  };

  return (
    <div className={cn("relative shrink-0", showIntro && "z-40")}>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        // The canvas lessons point at the way out under this name.
        data-visual-surface-switch=""
        data-tour={tour}
        onClick={onToggle}
        disabled={disabled}
        title={t(on ? (studio ? "shell.studioExitHint" : "shell.visualExitHint") : (studio ? "shell.studioEnterHint" : "shell.visualEnterHint"))}
        className={cn(
          "group flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors disabled:opacity-40",
          on
            ? "border-primary/40 bg-primary/10 text-primary hover:border-primary/60 hover:bg-primary/[0.18]"
            : "border-border/70 text-muted-foreground hover:border-border hover:bg-accent hover:text-foreground",
          className,
        )}
      >
        <Workflow className="h-3.5 w-3.5" />
        <span>{t(studio ? "shell.studioSwitch" : "shell.visualSwitch")}</span>
        <span
          aria-hidden
          className={cn(
            "relative h-3.5 w-7 rounded-full transition-colors",
            on ? "bg-primary/60" : "bg-muted-foreground/25",
          )}
        >
          <span
            className={cn(
              "absolute top-[2px] h-2.5 w-2.5 rounded-full bg-background shadow-sm transition-all duration-200",
              on ? "left-[15px]" : "left-[3px]",
            )}
          />
        </span>
        <span
          data-visual-surface-beta=""
          className={cn(
            "rounded-full border px-1.5 py-px text-[9px] font-bold uppercase leading-none tracking-wide",
            on ? "border-primary/40 text-primary" : "border-border text-muted-foreground/80",
          )}
        >
          {t("shell.visualBeta")}
        </span>
      </button>

      {showIntro && (
        <div
          role="dialog"
          aria-label={t("shell.visualIntroTitle")}
          data-visual-surface-intro=""
          className="absolute left-0 top-full mt-2 w-[19rem] rounded-xl border border-primary/30 bg-popover p-3.5 text-left text-popover-foreground shadow-xl"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-1.5 text-sm font-semibold">
              <Workflow className="h-4 w-4 text-primary" />
              {t("shell.visualIntroTitle")}
            </div>
            <button
              type="button"
              onClick={dismiss}
              aria-label={t("shell.visualIntroLater")}
              className="hover-surface -mr-1 -mt-1 rounded-md p-1 text-muted-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{t("shell.visualIntroBody")}</p>
          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={dismiss}
              className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              {t("shell.visualIntroLater")}
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => { dismiss(); onToggle(); }}
              className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {t("shell.visualIntroTry")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
