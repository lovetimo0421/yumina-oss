import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Loader2, X, Play, MessageCircle, Clock, Clapperboard } from "lucide-react";

const apiBase = import.meta.env.VITE_API_URL || "";

interface SessionSummary {
  id: string;
  name: string | null;
  worldId: string;
  worldName: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessagePreview: string | null;
}

interface SharePlaythroughPickerProps {
  /** When set, only this world's sessions are listed (library detail). When
   *  omitted, all of the user's sessions across worlds are listed (DM). */
  worldId?: string;
  worldName?: string;
  /** When the card belongs to a language group, scope the list to the whole
   *  group so saves on sibling variants are listed. Library cards dedup to one
   *  row per group (rep = earliest variant), so a worldId-only query would hide
   *  saves made on other variants. Mirrors the play picker. */
  languageGroupId?: string | null;
  open: boolean;
  onClose: () => void;
  /** User picked a session to publish. `worldId` is the session's own world. */
  onPick: (sessionId: string, defaultTitle: string, worldId: string) => void;
}

/**
 * Picks which of the player's sessions to publish to the hub as a shared
 * playthrough. Distinct from SessionExportModal — this does NOT touch the asset
 * library; it hands the chosen session to the share dialog, which publishes it
 * to Discover so others can open and continue it.
 */
export function SharePlaythroughPicker({ worldId, worldName, languageGroupId, open, onClose, onPick }: SharePlaythroughPickerProps) {
  const { t } = useTranslation("library");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const allWorlds = !worldId;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    const url = languageGroupId
      ? `${apiBase}/api/sessions?languageGroupId=${encodeURIComponent(languageGroupId)}`
      : worldId
        ? `${apiBase}/api/sessions?worldId=${encodeURIComponent(worldId)}`
        : `${apiBase}/api/sessions`;
    fetch(url, { credentials: "include" })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("failed"))))
      .then(({ data }) => {
        if (!cancelled) setSessions(Array.isArray(data) ? data : []);
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

  if (!open) return null;

  const titleFor = (s: SessionSummary) =>
    s.name?.trim() ||
    t("detail.sessionExport.defaultSessionName", { date: new Date(s.createdAt).toLocaleDateString() });

  return createPortal(
    <div className="fixed inset-0 z-[94] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/78 animate-in fade-in duration-150" onClick={onClose} />
      <div className="relative z-10 mx-4 flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-white/[0.07] bg-[#1B1C22] shadow-[0_24px_70px_rgba(0,0,0,0.5)] animate-in fade-in zoom-in-95 duration-200">
        <div className="h-1 w-full bg-gradient-to-r from-primary/60 via-amber-400/70 to-transparent" />
        <div className="flex items-start gap-3 px-5 pb-3 pt-5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary ring-1 ring-primary/20">
            <Clapperboard className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1 pt-0.5">
            <h2 className="text-[0.95rem] font-semibold text-foreground">{t("detail.sharePlaythrough")}</h2>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground/55">
              {allWorlds
                ? t("detail.sharePicker.subtitleAll")
                : t("detail.sharePicker.subtitle", { name: worldName ?? "" })}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label={t("dialog.cancel")}
            className="-mr-1 -mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground/40 transition-colors hover:bg-white/5 hover:text-muted-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mx-5 h-px bg-white/[0.06]" />

        <div className="flex-1 space-y-2 overflow-y-auto px-4 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
            </div>
          ) : sessions.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] py-10 text-center">
              <Play className="h-6 w-6 fill-current text-muted-foreground/30" />
              <span className="text-sm text-muted-foreground/60">{t("detail.sessionExport.noSessions")}</span>
              <span className="text-xs text-muted-foreground/35">{t("detail.sharePicker.emptyHint")}</span>
            </div>
          ) : (
            sessions.map((session) => (
              <button
                key={session.id}
                type="button"
                onClick={() => onPick(session.id, titleFor(session), session.worldId)}
                className="group flex w-full items-start gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 text-left transition-all hover:border-primary/30 hover:bg-white/[0.05]"
              >
                <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary/20">
                  <Play className="h-4 w-4 fill-current" />
                </div>
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-white">{titleFor(session)}</span>
                  {allWorlds && session.worldName && (
                    <span className="mt-0.5 block truncate text-[11px] text-primary/70">{session.worldName}</span>
                  )}
                  <div className="mt-1 flex items-center gap-3 text-[11px] text-muted-foreground/55">
                    <span className="inline-flex items-center gap-1">
                      <MessageCircle className="h-3 w-3" />
                      {t("detail.sessionExport.messageCount", { count: session.messageCount })}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {new Date(session.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  {session.lastMessagePreview && (
                    <p className="mt-2 line-clamp-2 text-xs text-muted-foreground/55">{session.lastMessagePreview}</p>
                  )}
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
