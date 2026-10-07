import { memo } from "react";
import { useStore, type NodeProps } from "@xyflow/react";

/** Below this zoom the title grows to stay readable, the way the frames'
 *  own names do (FrameName in block-node). */
const TITLE_ZOOM = 0.75;

/** The outline of one group of situations on the board — a dashed box with
 *  how the player gets in as its title. Purely drawn: it is not a thing you
 *  select, drag or drop into. */
export const SituationGroupNode = memo(function SituationGroupNode({ data }: NodeProps) {
  const d = data as { title: string; count: number; width: number; height: number };
  const zoom = useStore((s) => s.transform[2]);
  const k = zoom >= TITLE_ZOOM ? 1 : Math.min(4, TITLE_ZOOM / zoom);
  // Zoomed out, every situation's own name also grows above its frame
  // (FrameName, same 0.75 threshold, ~24px tall before scaling) and the first
  // one sits right where this title would — so the title clears it.
  const lift = k > 1 ? Math.max(6, 24 * k - 10) : 6;
  return (
    <div
      className="pointer-events-none relative rounded-2xl border border-dashed border-white/12 bg-white/[0.015]"
      style={{ width: d.width, height: d.height }}
    >
      <div
        className="absolute left-4 top-2.5 flex items-baseline gap-2 whitespace-nowrap"
        style={{ transform: `scale(${k})`, transformOrigin: "left bottom", ...(k > 1 ? { top: "auto", bottom: "100%", marginBottom: lift } : {}) }}
      >
        <span className="rounded bg-[#0c0b0f]/80 px-1.5 text-[15px] font-bold text-zinc-200">{d.title}</span>
        <span className="text-[12px] text-zinc-500">{d.count}</span>
      </div>
    </div>
  );
});
