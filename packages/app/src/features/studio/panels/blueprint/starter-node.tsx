import { memo } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import { BookOpen, MessageCircle, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

export const STARTER_NODE_WIDTH = 300;
export const STARTER_PLACEHOLDER_HEIGHT = 156;

export type StarterNodeData = Record<string, unknown> & {
  kind: "setting" | "opening";
  /** Laid inside a module tile: full row width, shared edges, no corner. */
  width?: number;
  flush?: boolean;
  fillHeight?: number;
  readOnly?: boolean;
  onCreate?: () => void;
  onSelect?: (id: string) => void;
};

export function starterNodeHeight(_data: StarterNodeData): number {
  return STARTER_PLACEHOLDER_HEIGHT;
}

/** View-only invitations. Creating, opening, and expanding are owned by the board. */
export const StarterNode = memo(function StarterNode({ data }: NodeProps<Node<StarterNodeData>>) {
  const { t } = useTranslation("editor");
  const setting = data.kind === "setting";
  const Icon = setting ? BookOpen : MessageCircle;
  return (
    <section
      className={cn("nodrag nowheel flex flex-col rounded-xl border bg-[#17161d] p-4 text-zinc-100 shadow-sm", setting ? "border-violet-500/30" : "border-emerald-500/30")}
      style={{ width: STARTER_NODE_WIDTH, height: STARTER_PLACEHOLDER_HEIGHT }}
      aria-label={t(`blueprint.starter.${data.kind}Title`)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <Icon className={cn("h-4 w-4 shrink-0", setting ? "text-violet-300" : "text-emerald-300")} />
        {t(`blueprint.starter.${data.kind}Title`)}
      </div>
      <p className="mb-3 mt-2 flex-1 text-[12px] leading-[18px] text-zinc-400">{t(`blueprint.starter.${data.kind}Hint`)}</p>
      <button
        type="button"
        onClick={data.onCreate}
        disabled={data.readOnly || !data.onCreate}
        className={cn("flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 disabled:cursor-not-allowed disabled:opacity-40", setting ? "border-violet-400/25 bg-violet-500/10 text-violet-200 hover:bg-violet-500/20" : "border-emerald-400/25 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20")}
      >
        <Plus className="h-3.5 w-3.5" />
        {t(`blueprint.starter.${data.kind}Create`)}
      </button>
    </section>
  );
});
