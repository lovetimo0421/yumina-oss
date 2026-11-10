import { useEffect, useRef, useState, type ReactNode } from "react";
import { BookmarkPlus, Loader2, Play, RefreshCw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { whenSessionStateSettled } from "@/lib/session-state-queue";
import { useChatStore } from "@/stores/chat";
import { TwoTapDeleteButton } from "@/components/ui/two-tap-delete-button";
import { cn } from "@/lib/utils";

const apiBase = import.meta.env.VITE_API_URL || "";
interface TestStart { id: string; name: string; messageCount: number; createdAt: string | null }
type Props = {
  worldId: string; sessionId: string | null; selectedId: string; onSelect: (id: string) => void;
  onRun: (id: string) => Promise<void>; busy: boolean;
  /** Phone: one line, no explainer, with the panel's own controls at its end. */
  compact?: boolean; trailing?: ReactNode;
};
export function PlaytestStarts(props: Props) {
  return <CardTestStarts key={props.worldId} {...props} />;
}
const isTestStart = (value: unknown): value is TestStart => {
  const row = value as Partial<TestStart> | null;
  return !!row && typeof row.id === "string" && !!row.id && typeof row.name === "string" &&
    typeof row.messageCount === "number" && Number.isFinite(row.messageCount) && (row.createdAt === null || typeof row.createdAt === "string");
};
function CardTestStarts({ worldId, sessionId, selectedId, onSelect, onRun, busy, compact = false, trailing }: Props) {
  const { t } = useTranslation("editor");
  const streaming = useChatStore((s) => s.isStreaming);
  const [starts, setStarts] = useState<TestStart[]>([]);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const mutation = useRef<AbortController | null>(null);
  const selection = useRef({ id: selectedId, onSelect });
  selection.current = { id: selectedId, onSelect };
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; mutation.current?.abort(); };
  }, []);
  useEffect(() => {
    // An issued save/delete may already have committed. Reconcile its result
    // even after this card restarts; only a different card invalidates it.
    if (!mutation.current) { setNaming(false); setName(""); }
  }, [sessionId]);
  const disabled = busy || streaming || pending || loading;
  useEffect(() => {
    const controller = new AbortController();
    setError(null); setLoading(true);
    fetch(`${apiBase}/api/sessions/studio-test-starts?worldId=${encodeURIComponent(worldId)}`, { credentials: "include", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok || !Array.isArray(body.data) || !body.data.every(isTestStart)) throw new Error("Invalid test starts response");
        if (!controller.signal.aborted) {
          setStarts(body.data);
          const selected = selection.current;
          if (selected.id && !body.data.some((row: TestStart) => row.id === selected.id)) selected.onSelect("");
        }
      }).catch(() => { if (!controller.signal.aborted) setError("studio.testStarts.loadError"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [worldId, reload]);
  async function save() {
    if (!sessionId || disabled || mutation.current || !name.trim()) return;
    const controller = new AbortController(); mutation.current = controller;
    const current = () => mounted.current && !controller.signal.aborted && mutation.current === controller;
    setPending(true); setError(null);
    try {
      // Save returned playtest state, not the edited card. Drain frontend
      // variable writes already issued before capturing the server snapshot.
      await whenSessionStateSettled();
      if (!current()) return;
      const chat = useChatStore.getState();
      if (chat.session?.id !== sessionId || chat.isStreaming) { setError("studio.testStarts.stateNotReady"); return; }
      const response = await fetch(`${apiBase}/api/sessions/${sessionId}/studio-test-starts`, {
        method: "POST", credentials: "include", signal: controller.signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ worldId, name: name.trim(), expectedState: { ...chat.session.state, variables: chat.gameState } }),
      });
      const body = await response.json();
      if (!current()) return;
      if (!response.ok) { setError(body.code === "TEST_START_STATE_CHANGED" ? "studio.testStarts.stateNotReady" :
        body.code === "TEST_START_LIMIT" ? "studio.testStarts.limit" : "studio.testStarts.saveError"); return; }
      if (!isTestStart(body.data)) throw new Error("Invalid saved test start");
      setStarts((rows) => [body.data, ...rows]); onSelect(body.data.id); setName(""); setNaming(false);
    } catch { if (current()) setError("studio.testStarts.saveError"); }
    finally { if (current()) { mutation.current = null; setPending(false); } }
  }
  async function remove() {
    if (!selectedId || disabled || mutation.current) return;
    const controller = new AbortController(); mutation.current = controller;
    const current = () => mounted.current && !controller.signal.aborted && mutation.current === controller;
    setPending(true); setError(null);
    try {
      const response = await fetch(`${apiBase}/api/sessions/studio-test-starts/${selectedId}?worldId=${encodeURIComponent(worldId)}`, { method: "DELETE", credentials: "include", signal: controller.signal });
      if (!current()) return;
      if (!response.ok) throw new Error("Delete failed");
      setStarts((rows) => rows.filter((row) => row.id !== selectedId)); onSelect("");
    } catch { if (current()) setError("studio.testStarts.deleteError"); }
    finally { if (current()) { mutation.current = null; setPending(false); } }
  }
  return <div className={compact ? "shrink-0 space-y-1.5 border-b border-border/70 bg-card/40 px-2 py-1" : "shrink-0 space-y-2 border-b border-border/70 bg-card/40 px-3 py-2"}>
    <div className="flex items-center gap-1.5">
      <label htmlFor="studio-test-start" className={compact ? "sr-only" : "shrink-0 text-[11px] text-muted-foreground"}>{t("studio.testStarts.title", { defaultValue: "测试起点" })}</label>
      <select id="studio-test-start" value={selectedId} disabled={disabled} onChange={(event) => onSelect(event.target.value)}
        title={compact ? t("studio.testStarts.hint", { defaultValue: "起点保留状态与对话，退出后仍可使用。运行前保存当前草稿，每次创建独立试玩。" }) : undefined}
        className={cn("min-w-0 rounded border border-border bg-background px-1.5 py-1 text-[11px]", compact ? "max-w-[15rem] [@media(max-width:767px)]:flex-1" : "flex-1")}>
        <option value="">{t("studio.testStarts.fresh", { defaultValue: "从头开始" })}</option>
        {starts.map((start) => <option key={start.id} value={start.id}>{start.name} · {t("studio.testStarts.messages", { count: start.messageCount, defaultValue: "{{count}} 条对话" })}</option>)}
      </select>
      <button type="button" disabled={disabled} onClick={() => void onRun(selectedId)} className="rounded p-1.5 text-emerald-300 hover:bg-accent disabled:opacity-40"
        title={t("studio.testStarts.run", { defaultValue: "用当前草稿运行" })} aria-label={t("studio.testStarts.run", { defaultValue: "用当前草稿运行" })}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
      </button>
      <button type="button" disabled={disabled || !sessionId} onClick={() => setNaming((value) => !value)} className="rounded p-1.5 text-muted-foreground hover:bg-accent disabled:opacity-40"
        title={t("studio.testStarts.saveCurrent", { defaultValue: "保存当前试玩为新起点" })} aria-label={t("studio.testStarts.saveCurrent", { defaultValue: "保存当前试玩为新起点" })}>
        <BookmarkPlus className="h-3.5 w-3.5" />
      </button>
      {selectedId && <TwoTapDeleteButton key={selectedId} disabled={disabled} onConfirm={() => void remove()} className="rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
        title={t("studio.testStarts.delete", { defaultValue: "删除所选起点" })} armedTitle={t("twoTapConfirm")}><Trash2 className="h-3.5 w-3.5" /></TwoTapDeleteButton>}
      {compact && <span className="hidden flex-1 md:block" />}
      {trailing}
    </div>
    {naming && <form className="flex gap-1.5" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <input autoFocus value={name} onChange={(event) => setName(event.target.value)} maxLength={80} disabled={disabled}
        aria-label={t("studio.testStarts.name", { defaultValue: "起点名称" })} placeholder={t("studio.testStarts.nameHint", { defaultValue: "例如：进入副本 B 前" })}
        className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs" />
      <button type="submit" disabled={disabled || !name.trim()} className="rounded bg-primary/15 px-2 py-1 text-[11px] text-primary disabled:opacity-40">
        {t("studio.testStarts.save", { defaultValue: "保存起点" })}
      </button>
    </form>}
    {!compact && <p className="text-[10px] leading-relaxed text-muted-foreground">
      {t("studio.testStarts.hint", { defaultValue: "起点保留状态与对话，退出后仍可使用。运行前保存当前草稿，每次创建独立试玩。" })}
    </p>}
    {error && <div className="flex items-center gap-2">
      <p role="alert" className="flex-1 text-[11px] text-destructive">{t(error as never)}</p>
      <button type="button" disabled={loading || pending} onClick={() => setReload(value => value + 1)}
        aria-label={t("studio.testStarts.retry")} className="inline-flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-40">
        <RefreshCw className="h-3 w-3" />{t("studio.testStarts.retry")}
      </button>
    </div>}
  </div>;
}
