import { Lock, BookOpen, Download, X, Check } from "lucide-react";
import { useTranslation } from "react-i18next";

interface TombstoneCardProps {
  worldName: string;
  thumbnailUrl: string | null;
  /** Omit to hide the button entirely — session history isn't built yet, and
   *  a control whose only reply is "coming soon" is worse than no control. */
  onViewHistory?: () => void;
  onExport: () => void;
  onRemove: () => void;
  selectable?: boolean;
  selected?: boolean;
  onSelectChange?: (selected: boolean) => void;
}

export function LibraryTombstoneCard({
  worldName,
  thumbnailUrl,
  onViewHistory,
  onExport,
  onRemove,
  selectable,
  selected,
  onSelectChange,
}: TombstoneCardProps) {
  const { t } = useTranslation("library");

  return (
    <div
      className={`group flex flex-col text-left transition-all duration-200 ${
        selectable
          ? selected
            ? "cursor-pointer scale-[0.97]"
            : "cursor-pointer opacity-75 hover:opacity-100"
          : ""
      }`}
      onClick={selectable ? () => onSelectChange?.(!selected) : undefined}
    >
      <div className={`library-overview-surface library-overview-surface--interactive relative mb-2 aspect-[3/4] w-full overflow-hidden rounded-xl shadow-lg transition-all duration-200 ${selectable && selected ? "ring-2 ring-primary ring-offset-2 ring-offset-background shadow-[0_8px_25px_rgba(232,184,49,0.25)]" : ""}`}>
        {selectable && selected && (
          <>
            <div className="pointer-events-none absolute inset-0 z-20 bg-primary/10" />
            <div className="absolute bottom-2 right-2 z-30 flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-[0_2px_8px_rgba(0,0,0,0.4)]">
              <Check size={13} strokeWidth={3} />
            </div>
          </>
        )}
        <div className="absolute inset-0 overflow-hidden">
          {thumbnailUrl ? (
            <img
              src={thumbnailUrl}
              alt={worldName}
              className="h-full w-full object-cover grayscale opacity-30 transition-[transform,filter] duration-700 ease-out group-hover:scale-105 group-hover:blur-[2px]"
            />
          ) : (
            <div className="h-full w-full bg-gradient-to-br from-[#2a2a2e] to-[#181818] opacity-30 transition-[transform,filter] duration-700 ease-out group-hover:scale-105 group-hover:blur-[2px]" />
          )}
        </div>

        <div className="absolute inset-0 flex items-center justify-center bg-black/60">
          <Lock size={36} className="text-white/30" />
        </div>

        <div className="library-overview-hover-overlay absolute inset-0 z-10 opacity-0 transition-opacity duration-300 group-hover:opacity-100" />

        {!selectable && <div className="library-tombstone-actions pointer-events-none absolute inset-0 z-20 flex items-center justify-center opacity-0 transition-opacity duration-300 group-hover:pointer-events-auto group-hover:opacity-100">
          <div className="flex items-center gap-2">
            {onViewHistory && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onViewHistory();
                }}
                className="library-overview-action-button flex h-9 w-9 items-center justify-center rounded-full text-white shadow-lg transition-all hover:scale-110"
                title={t("detail.viewHistory")}
              >
                <BookOpen size={14} />
              </button>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onExport();
              }}
              className="library-overview-action-button flex h-9 w-9 items-center justify-center rounded-full text-white shadow-lg transition-all hover:scale-110"
              title={t("detail.export")}
            >
              <Download size={14} />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
              className="library-overview-action-button library-overview-action-button--danger flex h-9 w-9 items-center justify-center rounded-full text-red-400/80 shadow-lg transition-all hover:scale-110"
              title={t("detail.remove")}
            >
              <X size={14} />
            </button>
          </div>
        </div>}
      </div>

      <h3 className="w-full truncate text-[13px] font-bold text-muted-foreground line-through">
        {worldName}
      </h3>
      <p className="text-[11px] text-muted-foreground/60">{t("detail.noLongerAvailable")}</p>
    </div>
  );
}
