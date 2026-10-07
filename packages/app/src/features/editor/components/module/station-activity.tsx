import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, RefreshCw } from "lucide-react";
import { useEditorStore } from "@/stores/editor";

/**
 * What this station has actually done, in the creator's own last session.
 *
 * A background AI's failure mode is silence: it wrote nothing, or it was never
 * woken, and both look identical from the studio. The console can say why the
 * WIRING is wrong before you play; this says what happened when you did.
 *
 * Reads the creator's most recent available session on the card. Temporary
 * playtests are deleted when closed. Nobody else's play is visible here.
 */

const apiBase = import.meta.env.VITE_API_URL || "";

interface RunRow {
  bookId: string;
  runIndex: number;
  closedAt: string;
  summary?: string;
  summaryStatus: string;
}
/** A run the module has not let go of yet - it is narrating right now. */
interface OpenRow {
  bookId: string;
  runIndex: number;
  fromAt: string;
}
interface WorkerRow {
  bookId: string;
  index: number;
  at: string;
  text?: string;
  status: string;
  cause?: string;
}

const when = (iso: string) => {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const min = Math.round(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
};

export function StationActivity({ bookId, kind }: { bookId: string; kind: "narrator" | "worker" }) {
  const { t } = useTranslation("editor");
  const { t: learning, i18n } = useTranslation("learning");
  const serverWorldId = useEditorStore((s) => s.serverWorldId);
  const request = useRef<AbortController | null>(null);
  const [state, setState] = useState<{ worldId?: string | null; loading: boolean; open: OpenRow[]; runs: RunRow[]; workers: WorkerRow[]; loaded: boolean; error?: boolean; at?: string }>({
    loading: false,
    open: [],
    runs: [],
    workers: [],
    loaded: false,
  });

  const load = useCallback(async () => {
    request.current?.abort();
    if (!serverWorldId) return;
    const controller = new AbortController();
    request.current = controller;
    const current = () => !controller.signal.aborted && request.current === controller && useEditorStore.getState().serverWorldId === serverWorldId;
    setState((s) => s.worldId === serverWorldId ? { ...s, loading: true, error: false } :
      { worldId: serverWorldId, loading: true, loaded: false, open: [], runs: [], workers: [] });
    try {
      const res = await fetch(`${apiBase}/api/studio/${serverWorldId}/station-activity`, {
        credentials: "include", signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!json?.data || !Array.isArray(json.data.runs) || !Array.isArray(json.data.workers)) throw new Error("Invalid activity response");
      if (!current()) return;
      setState({
        worldId: serverWorldId,
        loading: false,
        loaded: true,
        // Tolerated rather than required: a server that predates open runs
        // should cost the author that one row, not the whole panel.
        open: Array.isArray(json.data.open) ? json.data.open : [],
        runs: json.data.runs,
        workers: json.data.workers,
        at: typeof json.data.at === "string" ? json.data.at : undefined,
      });
    } catch {
      if (current()) setState((s) => ({ ...s, loading: false, error: true }));
    }
  }, [serverWorldId]);

  useEffect(() => {
    void load();
    return () => request.current?.abort();
  }, [load, bookId]);

  // Flagged when the list is built, not sniffed from the shape: a closed run
  // carries `fromAt` as well, so anything that looks for one field would paint
  // every archived run as still running.
  const mine: Array<(OpenRow & { open: true }) | RunRow | WorkerRow> =
    state.worldId !== serverWorldId ? [] : kind === "worker"
      ? state.workers.filter((w) => w.bookId === bookId)
      : [
          ...state.open.filter((o) => o.bookId === bookId).map((o) => ({ ...o, open: true as const })),
          ...state.runs.filter((r) => r.bookId === bookId),
        ];

  return (
    <div className="space-y-1.5 rounded-lg border border-border px-2.5 py-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold text-foreground">
          {t(kind === "worker" ? "blueprint.station.activityWorker" : "blueprint.station.activityRuns")}
        </span>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title={t("blueprint.station.activityRefresh")}
          aria-label={t("blueprint.station.activityRefresh")}
        >
          {state.loading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
        </button>
      </div>

      {state.worldId === serverWorldId && state.error && <p role="alert" className="text-[11px] leading-relaxed text-destructive">{learning("activity.error")}</p>}
      {state.worldId === serverWorldId && state.at && Number.isFinite(Date.parse(state.at)) && <p className="text-[10px] text-muted-foreground">{learning("activity.source", { at: new Date(state.at).toLocaleString(i18n.language) })}</p>}
      {state.worldId !== serverWorldId || !state.loaded || (state.error && mine.length === 0) ? null : mine.length === 0 ? (
        <p className="text-[10px] leading-relaxed text-muted-foreground/60">
          {t("blueprint.station.activityEmpty")}
        </p>
      ) : (
        <div className="space-y-1">
          {mine.slice(0, 5).map((row, i) => {
            const isOpen = "open" in row;
            const isWorker = "index" in row && kind === "worker";
            const status = isOpen ? "open" : isWorker ? (row as WorkerRow).status : (row as RunRow).summaryStatus;
            const text = isOpen ? undefined : isWorker ? (row as WorkerRow).text : (row as RunRow).summary;
            const stamp = isOpen ? (row as OpenRow).fromAt : isWorker ? (row as WorkerRow).at : (row as RunRow).closedAt;
            const n = isOpen ? (row as OpenRow).runIndex : isWorker ? (row as WorkerRow).index : (row as RunRow).runIndex;
            return (
              <div key={i} className="rounded border border-border/50 bg-background/40 px-1.5 py-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-[9px] font-semibold text-muted-foreground/70">#{n}</span>
                  <span
                    className={
                      status === "ready"
                        ? "text-[9px] text-emerald-400"
                        : status === "failed"
                          ? "text-[9px] text-rose-400"
                          : status === "open"
                            ? "text-[9px] text-sky-400"
                            : "text-[9px] text-amber-400"
                    }
                  >
                    {t(`blueprint.station.activityStatus.${status}` as never)}
                  </span>
                  <span className="ml-auto text-[9px] text-muted-foreground/40">{when(stamp)}</span>
                </div>
                {text && (
                  <p className="mt-0.5 line-clamp-3 text-[10px] leading-relaxed text-foreground/75">{text}</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
