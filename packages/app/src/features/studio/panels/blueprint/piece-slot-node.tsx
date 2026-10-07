import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/** How tall a module reserves for a piece that is still in the air. Deep
 *  enough to read as "a block goes here", short enough that the module does
 *  not lurch while the cursor crosses it. */
export const PIECE_SLOT_H = 76;

export type PieceSlotNodeData = {
  width?: number;
  fillHeight?: number;
};

/** The gap a module opens for the piece being carried. It is laid out by the
 *  same tile pass as the blocks, so the things below it move down by exactly
 *  what the piece will take — the hole IS the preview. */
export function PieceSlotNode({ data }: { data: PieceSlotNodeData }) {
  const { t } = useTranslation("editor");
  return (
    <div
      className={cn(
        "pointer-events-none flex items-center justify-center",
        "border-2 border-dashed border-amber-400/70 bg-amber-400/[0.07]",
        "text-[11px] font-semibold text-amber-200/90",
      )}
      style={{ width: data.width, height: data.fillHeight ?? PIECE_SLOT_H }}
    >
      {t("blueprint.piece.dropHere")}
    </div>
  );
}
