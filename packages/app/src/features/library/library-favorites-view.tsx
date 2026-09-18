import { ArrowLeft, Heart, Play } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useOpenWorldPreview } from "@/edition/slots";
import { useFavoritesStore } from "@/edition/slots.state";
import type { WorldItem } from "@/stores/worlds";

const CASTLE_ICON = "\u{1F3F0}";

interface LibraryFavoritesViewProps {
  worlds: WorldItem[];
  onSelectItem: (item: WorldItem) => void;
  onBack: () => void;
}

export function LibraryFavoritesView({
  worlds,
  onSelectItem,
  onBack,
}: LibraryFavoritesViewProps) {
  const { t } = useTranslation("library");
  const { openWorldPreview } = useOpenWorldPreview();
  const favorites = useFavoritesStore((s) => s.favorites);

  return (
    <div data-scroll-restoration-id="library-favorites" className="flex h-full w-full min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden p-4 sm:p-8">
      <div className="mb-8">
        <button
          onClick={onBack}
          className="mb-4 flex items-center gap-1.5 text-sm text-[#B9B6AE] transition-colors hover:text-gold"
        >
          <ArrowLeft className="h-4 w-4" />
          {t("favorites.backToLibrary")}
        </button>
        <h1 className="flex items-center gap-3 text-[32px] font-black text-white">
          <Heart size={28} className="fill-gold text-gold" />
          {t("favorites.title")}
        </h1>
        <p className="mt-2 text-sm text-[#B9B6AE]">
          {t("favorites.count", { count: favorites.length })}
        </p>
      </div>

      {favorites.length > 0 ? (
        <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8 2xl:grid-cols-10">
          {favorites.map((fav) => {
            const libraryWorld = worlds.find(
              (w) => w.id === fav.worldId || w.sourceWorldId === fav.worldId
            );

            return (
              <button
                key={fav.id}
                onClick={() => {
                  if (libraryWorld) {
                    onSelectItem(libraryWorld);
                  } else {
                    void openWorldPreview(fav.worldId);
                  }
                }}
                className="group flex flex-col text-left transition-all hover:-translate-y-1"
              >
                <div className="relative mb-3 aspect-[3/4] w-full overflow-hidden rounded-xl border border-white/5 shadow-lg transition-all group-hover:border-gold/50 group-hover:shadow-[0_8px_25px_rgba(201,162,94,0.15)]">
                  {fav.worldThumbnailUrl ? (
                    <img
                      src={fav.worldThumbnailUrl}
                      alt={fav.worldName ?? ""}
                      className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-110"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-[#212124] to-[#181818] text-[#f2e8cf]/70">
                      <span className="text-[2.55rem] leading-none">{CASTLE_ICON}</span>
                    </div>
                  )}

                  <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent opacity-60 transition-opacity group-hover:opacity-80" />

                  <div className="absolute top-2 right-2">
                    <Heart size={14} className="fill-gold text-gold drop-shadow-lg" />
                  </div>

                  <div className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100">
                    <div className="flex h-12 w-12 scale-50 items-center justify-center rounded-full bg-gold/90 text-[#181818] shadow-[0_0_20px_rgba(201,162,94,0.5)] transition-transform duration-300 group-hover:scale-100">
                      <Play fill="currentColor" size={20} className="ml-1" />
                    </div>
                  </div>
                </div>

                <h3 className="w-full truncate text-[13px] font-bold text-white transition-colors group-hover:text-gold">
                  {fav.worldName ?? "Untitled"}
                </h3>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-20 text-[#B9B6AE]">
          <Heart size={48} className="mb-4 opacity-20" />
          <p className="text-[16px]">{t("favorites.noFavorites")}</p>
        </div>
      )}
    </div>
  );
}
