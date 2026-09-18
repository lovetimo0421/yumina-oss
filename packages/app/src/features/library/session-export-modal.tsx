import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRouter } from "@tanstack/react-router";
import { feedback } from "@/lib/feedback";
import { Clock, Download, FileText, Loader2, MessageCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { uploadSessionTextAsset } from "@/features/chat/export-chat";
import { fetchFullSessionMessages } from "@/features/chat/full-session-history";
import type { Message, SessionData } from "@/stores/chat";
import { useUserAssetStore } from "@/stores/user-assets";
import { storeCommunityThreadHandoff } from "@/lib/community-thread-handoff";
import { HOSTED_ROUTES } from "@/edition/routes";
import { useFeature } from "@/edition/edition";

const apiBase = import.meta.env.VITE_API_URL || "";

interface SessionSummary {
  id: string;
  name: string | null;
  worldId: string;
  worldName: string | null;
  playtimeSeconds: number | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessagePreview: string | null;
}

interface CompletedExport {
  assetId: string;
  content: string;
  communityTitle: string;
  sizeBytes: number;
}

interface SessionExportModalProps {
  worldId: string;
  worldName: string;
  /** When the card belongs to a language group, scope the session list to the
   *  whole group so saves on sibling variants are listed. Library cards dedup
   *  to one row per group (rep = earliest variant), so a worldId-only query
   *  would hide saves made on other variants. Mirrors the play picker. */
  languageGroupId?: string | null;
  open: boolean;
  onClose: () => void;
}

function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}


export function SessionExportModal({ worldId, worldName, languageGroupId, open, onClose }: SessionExportModalProps) {
  const { t } = useTranslation("library");

  const formatRelativeTime = (dateStr: string): string => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const hours = Math.floor(diff / 3600000);
    if (hours < 1) return t("time.justNow");
    if (hours < 24) return t("time.hoursAgo", { count: hours });
    const days = Math.floor(hours / 24);
    if (days === 1) return t("time.yesterday");
    if (days < 7) return t("time.daysAgo", { count: days });
    if (days < 30) return t("time.weeksAgo", { count: Math.floor(days / 7) });
    return t("time.monthsAgo", { count: Math.floor(days / 30) });
  };
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [completed, setCompleted] = useState<CompletedExport | null>(null);
  const communityEnabled = useFeature("community");

  // Fetch sessions when the picker opens
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    const params = languageGroupId
      ? `languageGroupId=${encodeURIComponent(languageGroupId)}`
      : `worldId=${encodeURIComponent(worldId)}`;
    fetch(`${apiBase}/api/sessions?${params}`, {
      credentials: "include",
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("Failed to load sessions"))))
      .then(({ data }) => {
        if (cancelled) return;
        setSessions(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (!cancelled) setSessions([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, worldId, languageGroupId]);

  // Reset internal state when the modal is closed externally
  useEffect(() => {
    if (!open) {
      setSessions([]);
      setCompleted(null);
      setExportingId(null);
    }
  }, [open]);

  const handleExportSession = useCallback(
    async (sessionId: string) => {
      if (exportingId) return;
      setExportingId(sessionId);
      try {
        const res = await fetch(`${apiBase}/api/sessions/${sessionId}`, {
          credentials: "include",
        });
        if (!res.ok) {
          throw new Error(t("detail.sessionExport.failedToLoadSession"));
        }
        const { data } = await res.json();
        const session = data as SessionData;
        // The session endpoint returns only the newest window; page the rest
        // so exports of long sessions aren't silently cut off at the top.
        const messages = await fetchFullSessionMessages(
          sessionId,
          (data?.messages ?? []) as Message[],
          {
            messageTotal: typeof data?.messageTotal === "number" ? data.messageTotal : undefined,
            errorMessage: t("detail.sessionExport.failedToLoadSession"),
          },
        );

        const result = await uploadSessionTextAsset(session, messages);

        useUserAssetStore.setState((state) => {
          const alreadyPresent = state.assets.some((asset) => asset.id === result.asset.id);
          return alreadyPresent
            ? {}
            : {
                assets: [...state.assets, result.asset],
                storage: {
                  ...state.storage,
                  used: state.storage.used + (result.asset.sizeBytes ?? 0),
                },
              };
        });

        setCompleted({
          assetId: result.asset.id,
          content: result.content,
          communityTitle: result.communityTitle,
          sizeBytes: result.asset.sizeBytes ?? new TextEncoder().encode(result.content).length,
        });
      } catch {
        // R6/T0: the modal already spins per row and swaps to a completion
        // panel when it works, so only the failure speaks. No Retry action —
        // the row's own export button is still right there.
        feedback.error(t("detail.sessionExport.failedToSaveSession"));
      } finally {
        setExportingId(null);
      }
    },
    [exportingId, t],
  );

  const handleViewInAssets = useCallback(() => {
    if (!completed) return;
    const assetId = completed.assetId;
    setCompleted(null);
    onClose();
    router.navigate({
      to: "/app/library",
      search: { worldId: undefined, view: "assets", assetId },
    });
  }, [completed, onClose, router]);

  const handleShareInCommunity = useCallback(() => {
    if (!completed) return;
    storeCommunityThreadHandoff({
      title: completed.communityTitle,
      content: completed.content,
      forumSlug: "world-discussions",
      assetId: completed.assetId,
      worldId,
    });
    setCompleted(null);
    onClose();
    router.navigate({ to: `${HOSTED_ROUTES.communityNew}?forumSlug=world-discussions` });
  }, [completed, onClose, router, worldId]);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-w-xl border-white/10 bg-[#1F1D21] text-[#FFF5D6]">
        {completed ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("detail.sessionExport.downloadCompleteTitle")}</DialogTitle>
              <DialogDescription className="text-[#D1CEC6]/75">
                {t("detail.sessionExport.downloadCompleteDescription")}
              </DialogDescription>
            </DialogHeader>
            <p className="text-xs text-[#D1CEC6]/60">
              {t("detail.sessionExport.downloadSizeSummary", {
                size: formatByteSize(completed.sizeBytes),
              })}
            </p>
            <DialogFooter className="gap-2 sm:justify-end">
              <button
                onClick={() => setCompleted(null)}
                className="inline-flex min-h-[2.6rem] items-center justify-center rounded-xl border border-white/[0.08] px-4 py-2 text-sm font-medium text-white/70 transition-all hover:bg-white/[0.04] hover:text-white"
              >
                {t("detail.sessionExport.pickAnother")}
              </button>
              <button
                onClick={handleViewInAssets}
                className="inline-flex min-h-[2.6rem] items-center justify-center rounded-xl border border-[#C9A25E]/20 bg-[#C9A25E]/[0.08] px-4 py-2 text-sm font-medium text-[#E0C27A] transition-all hover:bg-[#C9A25E]/[0.14]"
              >
                {t("detail.sessionExport.viewInAssets")}
              </button>
              {communityEnabled && (
              <button
                onClick={handleShareInCommunity}
                className="inline-flex min-h-[2.6rem] items-center justify-center rounded-xl bg-gradient-to-r from-[#C9A25E] to-[#B8913D] px-4 py-2 text-sm font-bold text-[#1A1A22] transition-all hover:from-[#D4AD6A] hover:to-[#C9A25E]"
              >
                {t("detail.sessionExport.shareInCommunity")}
              </button>
              )}
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t("detail.sessionExport.pickerTitle")}</DialogTitle>
              <DialogDescription className="text-[#D1CEC6]/75">
                {t("detail.sessionExport.pickerDescription", { name: worldName })}
              </DialogDescription>
            </DialogHeader>

            <div className="max-h-[26rem] space-y-2 overflow-y-auto pr-1">
              {loading ? (
                <div className="flex items-center justify-center py-10">
                  <Loader2 className="h-5 w-5 animate-spin text-[#C9A25E]" />
                </div>
              ) : sessions.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] py-10 text-sm text-[#D1CEC6]/60">
                  <FileText className="h-6 w-6 opacity-40" />
                  <span>{t("detail.sessionExport.noSessions")}</span>
                </div>
              ) : (
                sessions.map((session) => {
                  const isExporting = exportingId === session.id;
                  return (
                    <button
                      key={session.id}
                      type="button"
                      onClick={() => handleExportSession(session.id)}
                      disabled={exportingId !== null}
                      className="group flex w-full items-start gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 text-left transition-all hover:border-[#C9A25E]/30 hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#C9A25E]/10 text-[#C9A25E]">
                        {isExporting ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Download className="h-4 w-4" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-3">
                          <span className="truncate text-sm font-semibold text-white">
                            {session.name?.trim() ||
                              t("detail.sessionExport.defaultSessionName", {
                                date: new Date(session.createdAt).toLocaleDateString(),
                              })}
                          </span>
                          <span className="shrink-0 text-[11px] text-[#D1CEC6]/60">
                            {formatRelativeTime(session.updatedAt)}
                          </span>
                        </div>
                        <div className="mt-1 flex items-center gap-3 text-[11px] text-[#D1CEC6]/55">
                          <span className="inline-flex items-center gap-1">
                            <MessageCircle className="h-3 w-3" />
                            {t("detail.sessionExport.messageCount", {
                              count: session.messageCount,
                            })}
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {new Date(session.createdAt).toLocaleDateString()}
                          </span>
                        </div>
                        {session.lastMessagePreview && (
                          <p className="mt-2 line-clamp-2 text-xs text-[#D1CEC6]/65">
                            {session.lastMessagePreview}
                          </p>
                        )}
                      </div>
                    </button>
                  );
                })
              )}
            </div>

            <DialogFooter className="gap-2 sm:justify-end">
              <button
                onClick={onClose}
                className="inline-flex min-h-[2.6rem] items-center justify-center rounded-xl border border-white/[0.08] px-4 py-2 text-sm font-medium text-white/70 transition-all hover:bg-white/[0.04] hover:text-white"
              >
                {t("dialog.cancel")}
              </button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
