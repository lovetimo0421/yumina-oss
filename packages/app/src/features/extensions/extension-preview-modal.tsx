import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { feedback } from "@/lib/feedback";
import i18n from "@/lib/i18n";
import { X, Star, Download, Trash2, RotateCcw, Loader2 } from "lucide-react";
import { useAuthGuard } from "@/hooks/use-auth-guard";
import { SESSION_MEMORY_EXTENSION_KEY, type ExtensionSummary, type ExtensionInstallStatus } from "@yumina/shared";
import { useExtensionPreview, type ExtensionPreviewTab } from "./extension-preview-store";
import { useExtensionsStore } from "@/stores/extensions";
import { useExtensionReviews, ExtensionReviewList } from "@/edition/slots";
import { useFeature } from "@/edition/edition";
import { ExtensionIcon } from "./extension-icon";
import { useLocalizedExtension, useLocalizedExtensionDetail } from "./use-localized-extension";

/** The session-memory extension bills its background updates (owner promised a
 *  token-usage warning on first activation — community thread, 2026-08-28).
 *  Fired after every successful install/reinstall of that one extension. Users
 *  said they missed a timed version of this, so it now stays until closed. */
export function notifyMemoryCost(key: string, message: string): void {
  if (key !== SESSION_MEMORY_EXTENSION_KEY) return;
  const closeLabel = (i18n.t as (k: string, o?: Record<string, unknown>) => string)(
    "common:action.close",
    { defaultValue: "Close" },
  );
  feedback.persistent(message, { label: closeLabel, onClick: () => {} });
}

export function ExtensionPreviewModal() {
  const extension = useExtensionPreview((s) => s.extension);
  const close = useExtensionPreview((s) => s.close);
  if (!extension) return null;
  if (typeof document === "undefined") return null;
  return createPortal(
    <ExtensionPreviewContent key={extension.key} extension={extension} onClose={close} />,
    document.body,
  );
}

function ExtensionPreviewContent({
  extension,
  onClose,
}: {
  extension: ExtensionSummary;
  onClose: () => void;
}) {
  const { t } = useTranslation(["extensions", "common"]);
  const localized = useLocalizedExtension(extension);
  const { requireAuth } = useAuthGuard();
  const initialTab = useExtensionPreview((s) => s.initialTab);
  const [tab, setTab] = useState<ExtensionPreviewTab>(initialTab ?? "overview");

  const detail = useExtensionsStore((s) => s.detailCache[extension.key]);
  const status = useExtensionsStore(
    (s) => s.installState[extension.key] ?? extension.installState?.status ?? "not-installed",
  ) as ExtensionInstallStatus;
  const pending = useExtensionsStore((s) => s.pendingAction[extension.key] ?? false);
  const fetchDetail = useExtensionsStore((s) => s.fetchDetail);
  const install = useExtensionsStore((s) => s.install);
  const uninstall = useExtensionsStore((s) => s.uninstall);
  const reinstall = useExtensionsStore((s) => s.reinstall);

  const reviewsEnabled = useFeature("reviews");
  const reviewsBag = useExtensionReviews({ extensionKey: extension.key, enabled: reviewsEnabled });
  const tabKeys: readonly ExtensionPreviewTab[] = reviewsEnabled ? ["overview", "reviews"] : ["overview"];

  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void fetchDetail(extension.key);
  }, [extension.key, fetchDetail]);

  // Escape to close + lock body scroll while open.
  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    modalRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      const modal = modalRef.current;
      if (e.key !== "Tab" || !modal?.contains(document.activeElement)) return;
      const focusable = [...modal.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) { e.preventDefault(); modal.focus(); return; }
      if (e.shiftKey && (document.activeElement === first || document.activeElement === modal)) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || document.activeElement === modal)) {
        e.preventDefault(); first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [onClose]);

  const localizedDetail = useLocalizedExtensionDetail(extension, detail);
  const stats = detail?.stats ?? extension.stats;
  const longDescription = localizedDetail?.longDescription ?? localized.shortDescription;
  const explanations = localizedDetail?.explanations ?? [];
  const paragraphs = longDescription.split("\n\n").filter(Boolean);

  const handlePrimary = async () => {
    if (status === "installed") {
      const ok = await uninstall(extension.key);
      if (!ok) {
        feedback.error(t("toast.uninstallFailed"), {
          label: t("common:action.retry"),
          onClick: () => void handlePrimary(),
        });
      }
      return;
    }
    if (!requireAuth("install extensions")) return;
    if (status === "uninstalled") {
      const ok = await reinstall(extension.key);
      if (!ok) {
        feedback.error(t("toast.installFailed"), {
          label: t("common:action.retry"),
          onClick: () => void handlePrimary(),
        });
      } else {
        notifyMemoryCost(extension.key, t("toast.memoryCostNotice"));
      }
    } else {
      const ok = await install(extension.key);
      if (!ok) {
        feedback.error(t("toast.installFailed"), {
          label: t("common:action.retry"),
          onClick: () => void handlePrimary(),
        });
      } else {
        notifyMemoryCost(extension.key, t("toast.memoryCostNotice"));
      }
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center overflow-y-auto overscroll-contain px-3 py-[calc(env(safe-area-inset-top,0px)+2.5rem)] md:p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label={localized.name}
        tabIndex={-1}
        className="relative flex w-full max-w-[820px] flex-col overflow-hidden rounded-[1.75rem] border border-white/[0.08] bg-[#1F1D21] shadow-[0_32px_80px_rgba(0,0,0,0.8),0_0_0_1px_rgba(255,255,255,0.03)] animate-in fade-in zoom-in-95 duration-200"
        style={{
          maxHeight: "calc(100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 5rem)",
        }}
      >
        {/* ═══ Hero ═══ */}
        <div className="relative shrink-0">
          <div
            className="relative flex items-center gap-5 overflow-hidden px-5 pt-7 pb-5 sm:px-7"
            style={{ minHeight: "clamp(150px, 22vh, 210px)" }}
          >
            <div className="absolute inset-0 bg-gradient-to-br from-[#2A272B] via-[#1F1D21] to-[#8C642A]/20" />
            <div className="absolute inset-0 bg-gradient-to-t from-[#1F1D21] via-transparent to-transparent" />

            {/* Close button */}
            <div className="absolute top-3 right-3 z-10 md:top-4 md:right-4">
              <button
                onClick={onClose}
                aria-label={t("common:action.close", { defaultValue: "Close" })}
                className="rounded-full p-2 bg-black/40 backdrop-blur-md border border-white/10 text-white/70 hover:text-white hover:bg-black/60 transition-all"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Icon tile */}
            <div className="relative z-[1] flex h-20 w-20 shrink-0 items-center justify-center rounded-2xl border border-[#C9A25E]/30 bg-gradient-to-br from-[#C9A25E]/20 to-white/5 shadow-[0_0_30px_rgba(201,162,94,0.12)]">
              <ExtensionIcon name={extension.icon} className="h-9 w-9 text-[#C9A25E]" />
            </div>

            {/* Title + meta */}
            <div className="relative z-[1] min-w-0 flex-1">
              {localized.tags.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {localized.tags.slice(0, 4).map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full bg-[#C9A25E]/90 px-2.5 py-0.5 text-[10px] font-bold text-[#121212] shadow-[0_2px_10px_rgba(201,162,94,0.3)]"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              <h1
                className="mb-1 text-[1.6rem] font-serif font-black leading-tight tracking-wide text-[#FFF5D6] sm:text-[1.8rem]"
                style={{ textShadow: "0 4px 20px rgba(0,0,0,0.8)" }}
              >
                {localized.name}
              </h1>
              <p className="mb-2 truncate text-xs text-white/55">
                {t("detail.byAuthor", { author: extension.author })} · v{extension.version}
              </p>
              {/* Ratings and download counts are hosted marketplace metadata. */}
              {reviewsEnabled && (
              <div className="flex items-center gap-4 text-xs">
                <span className="flex items-center gap-1.5 text-[#C9A25E]">
                  <Star className="h-3.5 w-3.5 fill-current" />
                  <span className="font-semibold">
                    {reviewsBag.ratingData.reviewCount > 0
                      ? reviewsBag.ratingData.averageRating.toFixed(1)
                      : "—"}
                  </span>
                  <span className="text-white/50">({reviewsBag.ratingData.reviewCount})</span>
                </span>
                <span className="flex items-center gap-1.5 text-white/60">
                  <Download className="h-3.5 w-3.5" />
                  <span className="font-semibold">{stats.downloadCount}</span>
                </span>
              </div>
              )}
            </div>
          </div>

          {/* Tabs */}
          <div className="flex items-center gap-6 border-b border-white/[0.06] px-5 sm:px-7">
            {tabKeys.map((tabKey) => (
              <button
                key={tabKey}
                onClick={() => setTab(tabKey)}
                className={`relative -mb-px py-3 text-sm font-semibold transition-colors ${
                  tab === tabKey ? "text-[#C9A25E]" : "text-white/45 hover:text-white/70"
                }`}
              >
                {tabKey === "overview"
                  ? t("detail.about")
                  : t("detail.reviewsWithCount", { count: reviewsBag.commentCount })}
                {tab === tabKey && <div className="absolute bottom-0 left-0 right-0 h-[2px] rounded-full bg-[#C9A25E]" />}
              </button>
            ))}
          </div>
        </div>

        {/* ═══ Body ═══ */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-7">
          {tab === "overview" ? (
            <div className="space-y-6">
              <div className="space-y-3">
                {paragraphs.map((p, i) => (
                  <p key={i} className="text-sm leading-relaxed text-[#D1CEC6]">
                    {p}
                  </p>
                ))}
              </div>

              {explanations.length > 0 && (
                <div className="space-y-3">
                  <h3 className="flex items-center gap-2 text-sm font-bold text-main">
                    <div className="h-3.5 w-1 rounded-full bg-gold" />
                    {t("detail.whatItDoes")}
                  </h3>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {explanations.map((ex, i) => (
                      <div
                        key={i}
                        className="rounded-2xl border border-[#C9A25E]/15 bg-gradient-to-br from-[#C9A25E]/[0.06] to-transparent p-4"
                      >
                        <div className="mb-1.5 text-sm font-semibold text-[#FFF5D6]">{ex.title}</div>
                        <p className="text-xs leading-relaxed text-white/65">{ex.body}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <ExtensionReviewList {...reviewsBag} />
          )}
        </div>

        {/* ═══ CTA footer ═══ */}
        <div className="flex shrink-0 items-center gap-3 border-t border-white/[0.06] bg-[#1A1820] px-5 py-4 sm:px-7">
          <button
            onClick={handlePrimary}
            disabled={pending}
            className={
              status === "installed"
                ? "inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/[0.03] px-5 py-3 text-sm font-bold text-white/80 transition-all hover:border-red-400/40 hover:bg-red-400/[0.08] hover:text-red-300 disabled:opacity-40"
                : "inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#C9A25E] to-[#B8913D] px-5 py-3 text-sm font-bold text-[#1A1A22] transition-all hover:shadow-[0_0_24px_rgba(201,162,94,0.35)] disabled:opacity-40"
            }
          >
            {pending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : status === "installed" ? (
              <Trash2 className="h-4 w-4" />
            ) : status === "uninstalled" ? (
              <RotateCcw className="h-4 w-4" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            {status === "installed"
              ? t("uninstall")
              : status === "uninstalled"
                ? t("reinstall")
                : t("install")}
          </button>
        </div>
      </div>
    </div>
  );
}
