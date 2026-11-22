import { useState, type CSSProperties, type ReactNode } from "react";

/** Two stacked frames for a gallery flip: the picture just asked for slides in
 *  from its side while the one before it slides out, then the old frame is
 *  dropped. Rapid clicks keep only the latest pair, so nothing piles up. */
export function GallerySwap({ index, direction, render, className, shift }: {
  index: number;
  /** 1 = moving forward (the new picture enters from the right), -1 = back. */
  direction: 1 | -1;
  render: (index: number) => ReactNode;
  className?: string;
  /** How far the picture travels (default: its full width). */
  shift?: string;
}) {
  const [shown, setShown] = useState({ index, flips: 0 });
  const [leaving, setLeaving] = useState<{ index: number; direction: 1 | -1; key: number } | null>(null);
  if (shown.index !== index) {
    // Adjusting state while rendering (React's derived-state pattern) puts the
    // outgoing frame in the same paint as the incoming one; an effect would
    // flash a frame with only the new image.
    const flips = shown.flips + 1;
    setShown({ index, flips });
    setLeaving({ index: shown.index, direction, key: flips });
  }
  const flips = shown.flips;
  const dir = leaving?.direction ?? direction;
  const style = (shift ? { "--gallery-swap-shift": shift } : {}) as CSSProperties;
  return (
    <span className={`relative block overflow-hidden ${className ?? ""}`} style={style}>
      {leaving && leaving.index !== index && (
        <span key={`out-${leaving.key}`} aria-hidden="true"
          className={`gallery-swap-layer ${dir === 1 ? "gallery-swap-out-next" : "gallery-swap-out-prev"}`}
          onAnimationEnd={() => setLeaving((cur) => cur?.key === leaving.key ? null : cur)}>
          {render(leaving.index)}
        </span>
      )}
      <span key={`in-${index}-${flips}`}
        className={`gallery-swap-layer ${leaving ? (dir === 1 ? "gallery-swap-in-next" : "gallery-swap-in-prev") : ""}`}>
        {render(index)}
      </span>
    </span>
  );
}
