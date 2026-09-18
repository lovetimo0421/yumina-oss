import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { Minus, Plus, Search } from "lucide-react";
import { useUiStore } from "@/stores/ui";

const MIN_PLAY_ZOOM = 20;
const MAX_PLAY_ZOOM = 200;
const STEP = 10;

export function PlayZoomControl() {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const [draftValue, setDraftValue] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelStyle, setPanelStyle] = useState<{ left: number; top: number; width: number }>({
    left: 0,
    top: 0,
    width: 220,
  });
  const playZoomPercent = useUiStore((s) => s.playZoomPercent);
  const setPlayZoomPercent = useUiStore((s) => s.setPlayZoomPercent);

  const clamp = (v: number) =>
    Math.min(MAX_PLAY_ZOOM, Math.max(MIN_PLAY_ZOOM, Math.round(v)));

  const commitDraftValue = () => {
    const parsed = Number(draftValue);
    if (!Number.isFinite(parsed)) {
      setDraftValue(String(playZoomPercent));
      return;
    }
    const clamped = clamp(parsed);
    setPlayZoomPercent(clamped);
    setDraftValue(String(clamped));
  };

  const stepZoom = (delta: number) => {
    const next = clamp(playZoomPercent + delta);
    setPlayZoomPercent(next);
    setDraftValue(String(next));
  };

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      const clickedButton = buttonRef.current?.contains(target);
      const clickedPanel = panelRef.current?.contains(target);
      if (!clickedButton && !clickedPanel) {
        setOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      setDraftValue(String(playZoomPercent));
    }
  }, [open, playZoomPercent]);

  useLayoutEffect(() => {
    if (!open) return;

    const updatePosition = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = 220;
      const viewportWidth = window.innerWidth;
      const left = Math.min(
        Math.max(12, rect.left),
        Math.max(12, viewportWidth - width - 12),
      );

      setPanelStyle({
        left,
        top: rect.bottom + 8,
        width,
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={buttonRef}
        onClick={() => setOpen((value) => !value)}
        className="play-zoom-trigger hover-surface flex h-8 min-w-8 max-w-[4.5rem] items-center justify-center gap-1 rounded-lg px-2 text-muted-foreground"
        title={t("zoom.adjustZoom")}
      >
        <Search className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate text-[11px] font-medium">{playZoomPercent}%</span>
      </button>

      {open && createPortal(
        <div
          ref={panelRef}
          className="fixed z-[120] rounded-xl border border-white/10 bg-card/95 p-3 shadow-xl backdrop-blur-md"
          style={{
            left: panelStyle.left,
            top: panelStyle.top,
            width: panelStyle.width,
          }}
        >
          {/* Minus / input / Plus row */}
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => stepZoom(-STEP)}
              disabled={playZoomPercent <= MIN_PLAY_ZOOM}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
            >
              <Minus className="h-3.5 w-3.5" />
            </button>

            <div className="relative flex-1">
              <input
                type="text"
                inputMode="numeric"
                value={draftValue}
                onChange={(event) => {
                  setDraftValue(event.target.value.replace(/[^\d]/g, ""));
                }}
                onBlur={commitDraftValue}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitDraftValue();
                    event.currentTarget.blur();
                  }
                  if (event.key === "Escape") {
                    setDraftValue(String(playZoomPercent));
                    event.currentTarget.blur();
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    stepZoom(STEP);
                  }
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    stepZoom(-STEP);
                  }
                }}
                onFocus={(event) => event.currentTarget.select()}
                className="w-full rounded-lg border border-white/10 bg-black/20 py-1.5 pr-7 pl-3 text-center text-sm font-medium text-foreground outline-none transition-colors focus:border-primary/60"
                aria-label={t("zoom.zoomLabel")}
              />
              <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground/50">
                %
              </span>
            </div>

            <button
              onClick={() => stepZoom(STEP)}
              disabled={playZoomPercent >= MAX_PLAY_ZOOM}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Slider */}
          <input
            type="range"
            min={MIN_PLAY_ZOOM}
            max={MAX_PLAY_ZOOM}
            step={1}
            value={playZoomPercent}
            onChange={(e) => {
              const v = clamp(Number(e.target.value));
              setPlayZoomPercent(v);
              setDraftValue(String(v));
            }}
            className="play-zoom-slider mt-2 h-1 w-full cursor-pointer appearance-none rounded-full bg-white/10 accent-primary"
          />
        </div>,
        document.body
      )}
    </div>
  );
}
