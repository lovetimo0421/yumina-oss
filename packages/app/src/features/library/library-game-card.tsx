import { Play, Heart, Trash2, Download, Pencil, Check, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { WorldItem } from "@/stores/worlds";
import { CroppedImage } from "@/lib/cover-crop";

const CASTLE_ICON = "\u{1F3F0}";

interface LibraryGameCardProps {
  item: WorldItem;
  onClick: () => void;
  status?: "installed" | "draft" | "published" | "cloud" | "update" | "pending_review" | "rejected";
  hasUpdate?: boolean;
  onCopyToProject?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  deleteTitle?: string;
  onPlay?: () => void;
  /** The session for this card is being created: spinner on Play, no double-fire. */
  playPending?: boolean;
  onDownload?: () => void;
  onToggleFavorite?: () => void;
  isFavorited?: boolean;
  selectable?: boolean;
  selected?: boolean;
  onSelectChange?: (selected: boolean) => void;
}

export function LibraryGameCard({
  item,
  onClick,
  status,
  hasUpdate,
  onPlay,
  playPending,
  onEdit,
  onDelete,
  deleteTitle,
  onDownload,
  onCopyToProject,
  onToggleFavorite,
  isFavorited,
  selectable,
  selected,
  onSelectChange,
}: LibraryGameCardProps) {
  const { t } = useTranslation("library");
  const handleCardClick = (e: React.MouseEvent) => {
    if (selectable) {
      e.stopPropagation();
      onSelectChange?.(!selected);
      return;
    }
    onClick();
  };
  return (
    <div
      className={`group flex cursor-pointer flex-col text-left transition-all duration-200 ${
        selectable
          ? selected
            ? "scale-[0.97]"
            : "opacity-75 hover:opacity-100 active:opacity-100"
          : "hover:-translate-y-1 active:scale-[0.985]"
      }`}
      style={{ contentVisibility: "auto", containIntrinsicSize: "0 280px" }}
      onClick={handleCardClick}
    >
      <div
        className={`library-overview-surface library-overview-surface--interactive relative mb-2 aspect-[3/4] w-full overflow-hidden rounded-xl shadow-lg transition-all duration-200 ${
          !selectable ? "group-hover:shadow-[0_8px_25px_rgba(232,184,49,0.15)]" : ""
        } ${isFavorited ? "library-overview-surface--favorite" : ""} ${
          selectable && selected
            ? "ring-2 ring-primary ring-offset-2 ring-offset-background shadow-[0_8px_25px_rgba(232,184,49,0.25)]"
            : ""
        }`}
      >
        <div className="absolute inset-0 overflow-hidden">
          {item.thumbnailUrl ? (
            <CroppedImage
              // Raw src + width prop for a real 1x/2x srcset (pre-transformed
              // src made the width prop a no-op). 480 matches the hub card so
              // the same edge/browser-cached variant is reused across surfaces.
              src={item.thumbnailUrl}
              alt={item.name}
              crop={item.coverCrop}
              className="h-full w-full transition-[transform,filter] duration-700 ease-out will-change-transform group-hover:scale-105 group-hover:blur-[2px]"
              decoding="async"
              width={480}
              height={400}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-[#2a2a2e] to-[#181818] text-[#f2e8cf]/70 transition-[transform,filter] duration-700 ease-out group-hover:scale-105 group-hover:blur-[2px]">
              <span className="text-[2.55rem] leading-none">{CASTLE_ICON}</span>
            </div>
          )}
        </div>

        {hasUpdate && !selectable && (
          <div className="absolute top-2 right-2 z-20 h-3 w-3 rounded-full bg-blue-500 ring-2 ring-zinc-900" />
        )}

        {selectable && selected && (
          <>
            <div className="pointer-events-none absolute inset-0 z-20 bg-primary/10" />
            <div className="absolute bottom-2 right-2 z-30 flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-[0_2px_8px_rgba(0,0,0,0.4)]">
              <Check size={13} strokeWidth={3} />
            </div>
          </>
        )}

        <div className="library-overview-hover-overlay absolute inset-0 z-10 opacity-0 transition-opacity duration-300 group-hover:opacity-100" />

        {status === "update" && (
          <div className="absolute top-2.5 left-2.5 z-20 rounded-full bg-primary px-2 py-0.5 text-[9px] font-bold text-primary-foreground shadow-[0_0_10px_rgba(201,162,94,0.8)]">
            UPDATE
          </div>
        )}

        {status === "pending_review" && (
          <div className="absolute top-2.5 left-2.5 z-20 rounded-full bg-blue-500/90 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white shadow-[0_0_10px_rgba(59,130,246,0.6)] animate-pulse">
            {t("projects.inReviewBadge")}
          </div>
        )}

        {status === "rejected" && (
          <div className="absolute top-2.5 left-2.5 z-20 rounded-full bg-red-500/90 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white shadow-[0_0_10px_rgba(239,68,68,0.6)]">
            {t("projects.rejectedBadge")}
          </div>
        )}

        {onToggleFavorite && !selectable && (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onToggleFavorite();
            }}
            className={`library-game-card-favorite touch-reveal absolute z-20 inline-flex h-11 w-11 items-center justify-center transition-opacity ${
              isFavorited ? "opacity-100" : "opacity-0 group-hover:opacity-100"
            } hover:scale-110`}
            style={{ top: 0, right: 0 }}
            aria-label={isFavorited ? t("card.unfavorite") : t("card.favorite")}
            aria-pressed={isFavorited}
            title={isFavorited ? t("card.unfavorite") : t("card.favorite")}
          >
            <Heart
              size={18}
              aria-hidden="true"
              className={
                isFavorited
                  ? "fill-primary text-primary drop-shadow-[0_1px_4px_rgba(0,0,0,0.8)]"
                  : "text-white drop-shadow-[0_1px_4px_rgba(0,0,0,0.8)]"
              }
            />
          </button>
        )}

        {onPlay && !selectable && (
          <div
            className={`library-game-card-play touch-reveal pointer-events-none absolute inset-0 z-20 flex items-center justify-center transition-opacity duration-300 group-hover:opacity-100 ${
              playPending ? "opacity-100" : "opacity-0"
            }`}
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (playPending) return;
                onPlay();
              }}
              disabled={playPending}
              aria-busy={playPending || undefined}
              className="library-game-card-action-button library-overview-action-button library-overview-action-button--accent pointer-events-auto flex h-12 w-12 items-center justify-center rounded-full text-white shadow-xl transition-transform hover:scale-110 disabled:cursor-progress disabled:hover:scale-100"
              title={t("card.play")}
            >
              {playPending ? (
                <Loader2 size={20} className="animate-spin" aria-hidden="true" />
              ) : (
                <Play fill="currentColor" size={22} strokeWidth={0} className="ml-1" />
              )}
            </button>
          </div>
        )}

        {!selectable && <div className="library-game-card-actions touch-reveal absolute bottom-1.5 right-1.5 z-20 flex items-center gap-1 opacity-0 transition-opacity duration-300 group-hover:opacity-100">
          {(onEdit || onCopyToProject) && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                (onEdit || onCopyToProject)?.();
              }}
              className="library-game-card-action-button library-overview-action-button flex h-6 w-6 items-center justify-center rounded-full text-white shadow-lg transition-transform hover:scale-110"
              title={onEdit ? t("card.editProject") : t("card.editAsMyProject")}
            >
              <Pencil size={10} />
            </button>
          )}

          {onDelete && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              className="library-game-card-action-button library-overview-action-button library-overview-action-button--danger flex h-6 w-6 items-center justify-center rounded-full text-white shadow-lg transition-transform hover:scale-110"
              title={deleteTitle || t("detail.delete")}
            >
              <Trash2 size={10} />
            </button>
          )}

          {!onDelete && onDownload && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDownload();
              }}
              className="library-game-card-action-button library-overview-action-button flex h-6 w-6 items-center justify-center rounded-full text-white shadow-lg transition-transform hover:scale-110"
              title={t("detail.download")}
            >
              <Download size={10} />
            </button>
          )}
        </div>}
      </div>

      <h3 className="w-full truncate text-[13px] font-bold text-foreground transition-colors group-hover:text-primary">
        {item.name}
      </h3>
    </div>
  );
}
