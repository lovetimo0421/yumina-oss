import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Folder, Images, Loader2, LockKeyhole, Trash2 } from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { mediaRequest, SessionMediaError, type MediaLibrary, type MediaDetail, type MediaReference } from "@/lib/session-media";
import { LibraryAssetsTab } from "./library-assets-tab";
const button = "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm transition-colors hover:bg-accent disabled:opacity-40";
const select = "min-h-10 max-w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground";
const size = (bytes: number) => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
export function LibraryResourcesTab(props: {
    highlightedAssetId?: string;
    showBindingHint?: boolean;
}) {
    const { t } = useTranslation("library");
    const { data: session } = useSession();
    const [section, setSection] = useState<"assets" | "media">("assets");
    useEffect(() => { if (props.highlightedAssetId)
        setSection("assets"); }, [props.highlightedAssetId]);
    const nav = <div className="flex flex-wrap gap-2" role="group" aria-label={t("tabs.assets")}>
    {(["assets", "media"] as const).map(key => <button key={key} onClick={() => setSection(key)} aria-pressed={section === key} className={`${button} ${section === key ? "!border-primary/50 !bg-primary/10 !text-primary" : "text-muted-foreground"}`}>
      {key === "assets" ? <Folder size={16}/> : <Images size={16}/>}{key === "assets" ? t("media.assets", "Creative assets") : t("media.title", "Save images")}</button>)}
  </div>;
    return section === "assets" ? <LibraryAssetsTab {...props} resourceNav={nav}/> : <LibrarySessionMedia key={session?.user.id ?? "guest"} resourceNav={nav}/>;
}
function LibrarySessionMedia({ resourceNav }: {
    resourceNav: ReactNode;
}) {
    const { t } = useTranslation("library");
    const [data, setData] = useState<MediaLibrary | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState("");
    const [sessionId, setSessionId] = useState(""), [filter, setFilter] = useState("all"), [order, setOrder] = useState("recent"), [offset, setOffset] = useState(0);
    const [active, setActive] = useState<string | null>(null), [detail, setDetail] = useState<MediaDetail | null>(null), [selected, setSelected] = useState(new Set<string>());
    const [deleting, setDeleting] = useState<MediaDetail[] | null>(null), [unlinking, setUnlinking] = useState<MediaReference | null>(null);
    const [ack, setAck] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
    const [refresh, setRefresh] = useState(0);
    const live = useRef(true);
    useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
    const reload = () => setRefresh(n => n + 1);
    const errorText = useCallback((e: unknown) => e instanceof SessionMediaError && e.code === "MEDIA_REFERENCE_CONFLICT" ? t("media.conflict", "References changed. Review the latest details and try again.") : t("media.failed", "Couldn't complete this action. Please retry."), [t]);
    useEffect(() => { if(deleting||unlinking||busy)return;const timer = setInterval(() => setRefresh(n => n + 1), 240000); const focus = () => setRefresh(n => n + 1); window.addEventListener("focus", focus); return () => { clearInterval(timer); window.removeEventListener("focus", focus); }; }, [deleting,unlinking,busy]);
    useEffect(() => {
        const abort = new AbortController();
        setLoading(true);
        setError("");
        const query = new URLSearchParams({ filter, order, offset: String(offset) });
        if (sessionId)
            query.set("sessionId", sessionId);
        mediaRequest<MediaLibrary>(`session-media?${query}`, { signal: abort.signal }).then(result => {
            if (abort.signal.aborted)
                return;
            setData(result);
            setSelected(prev => new Set([...prev].filter(id => result.items.some(x => x.id === id))));
            setActive(prev => result.items.some(x => x.id === prev) ? prev : result.items[0]?.id ?? null);
        }).catch(e => { if (!abort.signal.aborted)
            setError(errorText(e)); }).finally(() => { if (!abort.signal.aborted)
            setLoading(false); });
        return () => abort.abort();
    }, [sessionId, filter, order, offset, refresh, errorText]);
    useEffect(() => {
        setDetail(null);
        if (!active)
            return;
        const abort = new AbortController();
        mediaRequest<MediaDetail>(`session-media/${encodeURIComponent(active)}`, { signal: abort.signal }).then(result => { if (!abort.signal.aborted)
            setDetail(result); }).catch(e => { if (!abort.signal.aborted)
            setError(errorText(e)); });
        return () => abort.abort();
    }, [active, refresh, errorText]);
    function updateFilter(setter: (value: string) => void, value: string) { setter(value); setOffset(0); setSelected(new Set()); setDetail(null); }
    async function previewDelete(ids: string[]) {
        setBusy(true);
        setError("");
        try {
            const records = await Promise.all(ids.map(id => mediaRequest<MediaDetail>(`session-media/${encodeURIComponent(id)}`)));
            if (live.current) {
                setDeleting(records);
                setAck(false);
            }
        }
        catch (e) {
            if (live.current)
                setError(errorText(e));
        }
        finally {
            if (live.current)
                setBusy(false);
        }
    }
    async function confirmDelete() {
        if (!deleting || !ack)
            return;
        setBusy(true);
        setError("");
        const results = await Promise.allSettled(deleting.map(d => mediaRequest<{
            deleted: boolean;
            pending?: boolean;
        }>(`session-media/${encodeURIComponent(d.id)}`, { method: "DELETE", body: JSON.stringify({ revision: d.revision }) })));
        if (!live.current)
            return;
        const failed = results.find(r => r.status === "rejected");
        if (failed?.status === "rejected")
            setError(errorText(failed.reason));
        setNotice(results.some(r => r.status === "fulfilled" && r.value.pending) ? t("media.pending", "Deletion queued. Space is released after cleanup.") : failed ? "" : t("media.deleted", "Images permanently deleted. Storage updated."));
        setDeleting(null);
        setBusy(false);
        setSelected(new Set());
        reload();
    }
    async function confirmUnlink() {
        if (!unlinking?.sessionId)
            return;
        setBusy(true);
        setError("");
        try {
            await mediaRequest(`session-media/session/${encodeURIComponent(unlinking.sessionId)}/entries/${encodeURIComponent(unlinking.entryId)}`, { method: "DELETE", body: JSON.stringify({ version: unlinking.version }) });
            if (live.current) {
                setUnlinking(null);
                setNotice(t("media.unlinked", "Removed from this save. Storage usage is unchanged."));
                reload();
            }
        }
        catch (e) {
            if (live.current) {
                setError(errorText(e));
                setUnlinking(null);
                reload();
            }
        }
        finally {
            if (live.current)
                setBusy(false);
        }
    }
    const refsLabel = (r: MediaReference) => r.shareId ? t("media.share", "Shared replay") : r.checkpointId ? t("media.checkpoint", "Checkpoint") : r.historical ? t("media.history", "Save history") : t("media.save", "Save");
    const references = deleting?.flatMap(d => d.references) ?? [];
    const referencesTotal = deleting?.reduce((n, d) => n + d.referenceCount, 0) ?? 0;
    const distinctReferences = [...new Map(references.map(r => [`${r.sessionId || r.checkpointId || r.shareId}:${r.historical}`, r])).values()];
    return <div className="library-section-stack mb-10">
    <div className="library-overview-surface flex flex-col justify-between gap-5 rounded-xl p-6 md:flex-row md:items-center">
      <div><h2 className="mb-1 flex items-center gap-2 text-xl font-bold text-foreground"><Images size={20} className="text-primary"/>{t("media.title", "Save images")}</h2><p className="text-sm text-muted-foreground">{t("media.description", "Private images saved in your games")}</p></div>
      {data && <div className="w-full md:max-w-xs"><div className="mb-2 flex justify-between gap-3 text-xs"><span>{t("media.storage", "Account storage")}</span><span>{size(data.storage.used)} / {size(data.storage.limit)}</span></div><div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={t("media.storage")} aria-valuemin={0} aria-valuemax={data.storage.limit} aria-valuenow={data.storage.used}><div className="h-full bg-primary" style={{ width: `${Math.min(100, data.storage.used / data.storage.limit * 100)}%` }}/></div><p className="mt-2 text-xs text-muted-foreground">{t("media.sharedQuota", "Shares capacity with creative assets")} · {size(data.storage.mediaBytes)}</p>{data.storage.reserved > 0 && <p className="mt-1 text-xs text-muted-foreground">{t("media.reserved", "Temporary upload reservation")}: {size(data.storage.reserved)}</p>}</div>}
    </div>
    {resourceNav}
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap gap-2"><select aria-label={t("media.save")} className={select} value={sessionId} onChange={e => updateFilter(setSessionId, e.target.value)}><option value="">{t("media.allSaves", "All saves")}</option>{data?.sessions.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select><select aria-label={t("media.filter", "Usage")} className={select} value={filter} onChange={e => updateFilter(setFilter, e.target.value)}><option value="all">{t("media.all", "All images")}</option><option value="shared">{t("media.shared", "Used in shares")}</option><option value="unused">{t("media.unused", "Unused")}</option></select></div>
      <select aria-label={t("media.sort", "Sort")} className={select} value={order} onChange={e => updateFilter(setOrder, e.target.value)}><option value="recent">{t("media.recent", "Recently saved")}</option><option value="size">{t("media.largest", "Largest first")}</option></select>
    </div>
    {error && <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-destructive">{error}<button className={button} onClick={reload}>{t("media.retry", "Retry")}</button></div>}
    {loading && !data ? <Loader2 className="animate-spin" aria-label={t("media.loading", "Loading")}/> : <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_240px]">
      <div>
        {data?.configured === false ? <p className="py-10 text-sm text-muted-foreground">{t("media.notReady", "Cloud save images are not available yet.")}</p> : data?.items.length === 0 ? <p className="py-10 text-sm text-muted-foreground">{t("media.empty", "No images match this view.")}</p> : null}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {data?.items.map(item => <article key={item.id} className={`relative min-w-0 overflow-hidden rounded-xl border bg-card ${active === item.id ? "border-primary/60" : "border-border"}`}>
            <label className="absolute left-2 top-2 z-10 flex h-8 w-8 items-center justify-center rounded-md bg-card/95"><input type="checkbox" aria-label={`${t("media.select", "Select")} ${item.filename}`} checked={selected.has(item.id)} onChange={e => setSelected(prev => { const next = new Set(prev); e.target.checked ? next.add(item.id) : next.delete(item.id); return next; })}/></label>
            <button className="block w-full text-left" onClick={() => setActive(item.id)} aria-pressed={active === item.id}>
              {item.thumbnailUrl ? <img src={item.thumbnailUrl} referrerPolicy="no-referrer" loading="lazy" className="aspect-[4/3] w-full bg-muted object-contain" alt={item.filename}/> : <div className="flex aspect-[4/3] items-center justify-center bg-muted"><Images size={24}/></div>}
              <div className="p-3"><p className="truncate text-sm" title={item.filename}>{item.filename}</p><p className="mt-1 text-xs text-muted-foreground">{size(item.sizeBytes)} · {item.status === "deleting" ? t("media.cleaning", "Deleting") : item.usage==='shared'?t("media.shared"):item.usage==='unused'?t("media.unused"):t("media.save")}</p></div>
            </button>
          </article>)}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border pt-4 text-sm"><label className="flex items-center gap-2"><input type="checkbox" checked={!!data?.items.length && data.items.every(x => selected.has(x.id))} onChange={e => setSelected(e.target.checked ? new Set(data?.items.map(x => x.id)) : new Set())}/>{t("media.selectAll", "Select page")}</label><span className="mr-auto text-muted-foreground">{selected.size ? `${selected.size} ${t("media.selected", "selected")}` : ""}</span><button className={`${button} text-destructive`} disabled={!selected.size || busy} onClick={() => void previewDelete([...selected])}><Trash2 size={15}/>{t("media.delete", "Delete permanently")}</button></div>
        <div className="mt-4 flex justify-end gap-2"><button className={button} disabled={offset === 0 || loading} onClick={() => { setOffset(n => Math.max(0, n - 50)); setSelected(new Set()); }}>{t("media.previous", "Previous")}</button><button className={button} disabled={!data?.hasMore || loading} onClick={() => { setOffset(n => n + 50); setSelected(new Set()); }}>{t("media.next", "Next")}</button></div>
      </div>
      <aside className="min-w-0 border-t border-border pt-4 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
        {detail ? <>{detail.url && <img src={detail.url} referrerPolicy="no-referrer" className="mb-3 max-h-48 w-full rounded-lg bg-muted object-contain" alt={detail.filename}/>}<h3 className="break-words font-medium">{detail.filename}</h3><p className="mt-1 text-xs text-muted-foreground">{size(detail.sizeBytes)} · WebP</p><p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground"><LockKeyhole size={13}/>{t("media.private", "Private · access follows each share")}</p><h4 className="mb-1 mt-5 text-xs text-muted-foreground">{t("media.references", "Used by")}</h4>
          {detail.references.map(r => <div key={r.id} className="border-b border-border py-2 text-sm"><p className="break-words">{r.name}</p><p className="text-xs text-muted-foreground">{refsLabel(r)}</p></div>)}
          {detail.referenceCount > detail.references.length && <p className="mt-2 text-xs text-muted-foreground">{t("media.moreRefs", "Additional references")}: {detail.referenceCount - detail.references.length}</p>}
          {!detail.referenceCount && <p className="text-sm text-muted-foreground">{t("media.recovery", "Unused images are reclaimed after 7 days.")}</p>}
          {detail.references.some(r=>r.sessionId&&!r.historical)&&<button className={`${button} mt-5 w-full`} disabled={busy} onClick={()=>setUnlinking(detail.references.find(r=>r.sessionId===sessionId&&!r.historical)??detail.references.find(r=>r.sessionId&&!r.historical)!)}>{t("media.unlink","Remove from this save")}</button>}
          <button className={`${button} mt-2 w-full text-destructive`} disabled={busy} onClick={() => void previewDelete([detail.id])}><Trash2 size={15}/>{t("media.delete", "Delete permanently")}</button>
        </> : <p className="text-sm text-muted-foreground">{t("media.choose", "Select an image to view its references.")}</p>}
      </aside>
    </div>}
    <p role="status" aria-live="polite" className="text-sm text-muted-foreground">{notice}</p>
    <Dialog open={!!deleting} onOpenChange={open => { if (!open && !busy)
        setDeleting(null); }}><DialogContent><DialogHeader><DialogTitle>{t("media.deleteTitle", "Permanently delete these images?")}</DialogTitle><DialogDescription>{t("media.deleteWarning", "Affected saves, checkpoints and shares will no longer display these images. This cannot be undone.")}</DialogDescription></DialogHeader><div className="space-y-2 rounded-lg bg-muted p-3 text-sm">{distinctReferences.slice(0, 8).map((r, i) => <p key={i}>{r.name} · {refsLabel(r)}</p>)}{referencesTotal > references.length || distinctReferences.length > 8 ? <p>{t("media.moreRefs", "Additional references")}: {Math.max(referencesTotal - references.length, distinctReferences.length - 8)}</p> : null}{!referencesTotal && <p>{t("media.noRefs", "No saves or shares use these images.")}</p>}</div><p className="text-sm text-muted-foreground">{t("media.release", "Space is released after cleanup. Downloaded copies are unaffected.")} {size(deleting?.reduce((n, d) => n + d.sizeBytes, 0) ?? 0)}</p><label className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)}/>{t("media.ack", "I understand the impact and want to delete permanently.")}</label><DialogFooter><button className={button} disabled={busy} onClick={() => setDeleting(null)}>{t("media.cancel", "Cancel")}</button><button className={`${button} !bg-destructive !text-white`} disabled={!ack || busy} onClick={() => void confirmDelete()}>{busy ? <Loader2 size={16} className="animate-spin"/> : null}{t("media.delete", "Delete permanently")}</button></DialogFooter></DialogContent></Dialog>
    <Dialog open={!!unlinking} onOpenChange={open => { if (!open && !busy)
        setUnlinking(null); }}><DialogContent><DialogHeader><DialogTitle>{t("media.unlink", "Remove from this save")}</DialogTitle><DialogDescription>{detail?.filename}</DialogDescription></DialogHeader><label className="flex flex-col gap-2 text-sm">{t("media.save")}<select className={select} value={unlinking?.id??""} disabled={busy} onChange={e=>setUnlinking(detail?.references.find(r=>r.id===e.target.value)??null)}>{detail?.references.filter(r=>r.sessionId&&!r.historical).map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select></label><p className="text-sm">{t("media.unlinkWarning", "Only this save's current reference is removed. Save history, checkpoints and shares remain available. Storage usage does not decrease.")}</p><DialogFooter><button className={button} disabled={busy} onClick={() => setUnlinking(null)}>{t("media.cancel", "Cancel")}</button><button className={button} disabled={busy} onClick={() => void confirmUnlink()}>{t("media.unlink", "Remove from this save")}</button></DialogFooter></DialogContent></Dialog>
  </div>;
}
