import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, Loader2, X } from "lucide-react";
import { useEditorStore } from "@/stores/editor";
import { feedback } from "@/lib/feedback";

const apiBase = import.meta.env.VITE_API_URL || "";

/** Fired by the studio store after a big text file is stored as a source. */
export const SOURCES_CHANGED_EVENT = "yumina:studio-sources-changed";

interface SourceRow {
  id: string; name: string; chars: number; chapters: number;
  /** Present while the book is being read into a reference. */
  digest?: { phase: "read" | "merge" | "check" | "save"; done: number; total: number };
}

/**
 * The card's source texts, above the assistant's input: a big .txt attached
 * there is kept with the card (not pasted into the chat), and this is where
 * the creator sees that it is — and takes it away again.
 */
export function SourceTexts() {
  const { t, i18n } = useTranslation("editor");
  const worldId = useEditorStore((s) => s.serverWorldId);
  const [rows, setRows] = useState<SourceRow[]>([]);

  const load = useCallback(async () => {
    if (!worldId) { setRows([]); return; }
    try {
      const res = await fetch(`${apiBase}/api/studio/${encodeURIComponent(worldId)}/sources`, { credentials: "include" });
      if (res.ok) setRows(((await res.json()).data ?? []) as SourceRow[]);
    } catch {
      // Not knowing is not worth an error: the list just stays as it was.
    }
  }, [worldId]);

  useEffect(() => {
    void load();
    const onChange = () => void load();
    window.addEventListener(SOURCES_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(SOURCES_CHANGED_EVENT, onChange);
  }, [load]);

  // A digest runs on the server for tens of minutes; follow it while it does,
  // and pick up the finished reference when it lands.
  const digesting = rows.some((r) => r.digest);
  useEffect(() => {
    if (!digesting) return;
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [digesting, load]);

  if (rows.length === 0) return null;
  const compact = new Intl.NumberFormat(i18n.language, { notation: "compact", maximumFractionDigits: 1 });
  return (
    <div className="mb-2 flex flex-wrap gap-1.5 px-1" data-testid="source-texts">
      {rows.map((row) => (
        <span key={row.id} className="group inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/60 bg-muted/60 px-2 py-1 text-[10.5px] text-muted-foreground">
          <BookOpen className="h-3 w-3 shrink-0" />
          <span className="min-w-0 truncate text-foreground/80">{row.name}</span>
          {row.digest ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-primary" data-testid="source-digest">
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
              {t(`studio.sources.digest.${row.digest.phase}` as never, { done: row.digest.done, total: row.digest.total })}
            </span>
          ) : (
            <span className="shrink-0">{t("studio.sources.size", { n: compact.format(row.chars) })}</span>
          )}
          <button
            type="button"
            title={t("studio.sources.remove")}
            aria-label={t("studio.sources.remove")}
            onClick={async () => {
              if (!worldId) return;
              const res = await fetch(`${apiBase}/api/studio/${encodeURIComponent(worldId)}/sources/${encodeURIComponent(row.id)}`, { method: "DELETE", credentials: "include" }).catch(() => null);
              if (res?.ok) { setRows((r) => r.filter((x) => x.id !== row.id)); feedback.notice(t("studio.sources.removed", { name: row.name })); }
            }}
            className="shrink-0 rounded p-0.5 opacity-60 transition-opacity hover:bg-accent hover:opacity-100"
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </span>
      ))}
    </div>
  );
}
