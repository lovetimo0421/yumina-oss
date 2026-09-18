import { useEffect, useMemo, useState } from "react";
import { useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Blocks, Search, Loader2, PackageOpen } from "lucide-react";
import { useExtensionsStore, type ExtensionSort } from "@/stores/extensions";
import { ExtensionCard } from "./extension-card";
import { ExtensionManageCard } from "./extension-manage-card";

type Tab = "discover" | "manage";
const TABS: Tab[] = ["discover", "manage"];

export function ExtensionsPage() {
  const { t } = useTranslation("extensions");
  const { tab: tabParam } = useSearch({ from: "/app/extensions" });
  const [tab, setTab] = useState<Tab>(tabParam ?? "discover");

  // Keep the active tab in sync when the URL param changes mid-session (e.g.
  // navigating in from the profile section's "View More" / "Get More").
  useEffect(() => {
    if (tabParam) setTab(tabParam);
  }, [tabParam]);

  const installedList = useExtensionsStore((s) => s.installedList);
  const uninstalledList = useExtensionsStore((s) => s.uninstalledList);
  const manageLoading = useExtensionsStore((s) => s.manageLoading);
  const fetchManage = useExtensionsStore((s) => s.fetchManage);
  const catalog = useExtensionsStore((s) => s.catalog);
  const catalogLoading = useExtensionsStore((s) => s.catalogLoading);
  const fetchCatalog = useExtensionsStore((s) => s.fetchCatalog);

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [sort, setSort] = useState<ExtensionSort>("recommended");

  useEffect(() => {
    void fetchManage();
  }, [fetchManage]);

  useEffect(() => {
    const id = setTimeout(() => void fetchCatalog(query, category, sort), query ? 250 : 0);
    return () => clearTimeout(id);
  }, [query, category, sort, fetchCatalog]);

  const categories = useMemo(() => Array.from(new Set(catalog.map((e) => e.category))), [catalog]);
  const hasManage = installedList.length > 0 || uninstalledList.length > 0;

  return (
    <div className="flex h-full w-full min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden">
      {/* Header + tab selector */}
      <div className="w-full border-b border-white/10 px-4 pt-7 sm:px-6">
        <div className="mx-auto w-full max-w-[1100px]">
          <h1 className="flex items-center gap-2.5 text-3xl font-black text-main">
            <Blocks className="h-7 w-7 text-gold" />
            {t("title")}
          </h1>
          <p className="mt-1 text-sm text-sub/60">{t("subtitle")}</p>

          <nav className="mt-5 flex gap-7">
            {TABS.map((k) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={`inline-flex items-center border-b-2 pb-3 text-[15px] font-bold transition-all duration-300 ${
                  tab === k
                    ? "border-gold text-gold"
                    : "border-transparent text-sub/55 hover:border-white/30 hover:text-main"
                }`}
              >
                {t(k)}
              </button>
            ))}
          </nav>
        </div>
      </div>

      {/* Content */}
      <div className="mx-auto w-full max-w-[1100px] px-4 py-7 sm:px-6">
        {tab === "discover" ? (
          <section>
            {/* Control bar */}
            <div className="mb-5 flex flex-wrap items-center gap-3">
              <div className="relative min-w-[200px] flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/30" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("search")}
                  className="w-full rounded-xl border border-white/[0.08] bg-white/[0.03] py-2.5 pl-9 pr-3 text-sm text-white placeholder:text-white/35 focus:border-gold/30 focus:outline-none focus:ring-1 focus:ring-gold/10"
                />
              </div>
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as ExtensionSort)}
                className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2.5 text-sm text-white/80 focus:border-gold/30 focus:outline-none"
              >
                <option value="recommended">{t("sort.recommended")}</option>
                <option value="popular">{t("sort.popular")}</option>
                <option value="newest">{t("sort.newest")}</option>
              </select>
            </div>

            {/* Category chips */}
            {categories.length > 1 && (
              <div className="mb-5 flex flex-wrap gap-2">
                <CategoryChip label={t("category.all")} active={category === ""} onClick={() => setCategory("")} />
                {categories.map((cat) => (
                  <CategoryChip
                    key={cat}
                    label={t(`category.${cat}`, cat)}
                    active={category === cat}
                    onClick={() => setCategory(cat)}
                  />
                ))}
              </div>
            )}

            {/* Grid */}
            {catalogLoading && catalog.length === 0 ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="h-5 w-5 animate-spin text-gold/40" />
              </div>
            ) : catalog.length === 0 ? (
              <div className="py-16 text-center text-sm text-sub/50">{t("noResults")}</div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {catalog.map((e) => (
                  <ExtensionCard key={e.key} extension={e} />
                ))}
              </div>
            )}
          </section>
        ) : (
          <section>
            {manageLoading && !hasManage ? (
              <div className="flex items-center justify-center rounded-2xl border border-white/5 bg-white/[0.02] py-12">
                <Loader2 className="h-5 w-5 animate-spin text-gold/40" />
              </div>
            ) : !hasManage ? (
              <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 bg-white/[0.02] py-16 text-center">
                <PackageOpen className="mb-3 h-8 w-8 text-white/15" />
                <p className="text-sm font-medium text-sub/60">{t("empty")}</p>
                <p className="mt-1 text-xs text-sub/40">{t("emptyHint")}</p>
              </div>
            ) : (
              <div className="space-y-8">
                {installedList.length > 0 && (
                  <div>
                    <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-sub/50">
                      {t("installed")}
                    </div>
                    <div className="space-y-2">
                      {installedList.map((e) => (
                        <ExtensionManageCard key={e.key} extension={e} mode="installed" />
                      ))}
                    </div>
                  </div>
                )}
                {uninstalledList.length > 0 && (
                  <div>
                    <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-sub/50">
                      {t("previouslyInstalled")}
                    </div>
                    <div className="space-y-2">
                      {uninstalledList.map((e) => (
                        <ExtensionManageCard key={e.key} extension={e} mode="uninstalled" />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function CategoryChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-all ${
        active
          ? "border-gold/40 bg-gold/10 text-gold"
          : "border-white/10 bg-white/[0.02] text-sub/60 hover:border-white/20 hover:text-sub"
      }`}
    >
      {label}
    </button>
  );
}
