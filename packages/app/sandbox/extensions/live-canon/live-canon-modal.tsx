import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, BookOpenCheck, Check, Loader2, Plus, RotateCcw, Save, SlidersHorizontal, Trash2, X } from "lucide-react";
import type { LiveCanonApiResult, LiveCanonEntryInput, LiveCanonPayload, LiveCanonSessionEntryDTO } from "@yumina/shared";
import { useYumina } from "../../sandbox-context";
import { pickLang } from "../../chat/i18n";
import { SandboxPlatformOverlay } from "../../platform-overlay-portal";

type Tab = "state" | "lore";

function pickLiveCanonLang(language: string | undefined): keyof typeof COPY {
  const normalized = (language ?? "en").toLowerCase();
  if (/^zh(?:-|_)(?:tw|hk|mo|hant)/.test(normalized)) return "zh-Hant";
  return pickLang(language);
}

const COPY = {
  en: {
    title: "Lore Shift",
    scope: "Changes apply only to this session. The author's world is unchanged.",
    state: "Story State",
    lore: "Session Lore",
    save: "Save changes",
    saving: "Saving…",
    close: "Close",
    blockedTitle: "Lore Shift is unavailable for this story",
    blockedBody: "The author has disabled session lore editing. You can keep playing, but Lore Shift cannot change this story's state or lore.",
    loading: "Checking the author's permissions…",
    emptyState: "The author has not made any story-state fields editable.",
    editableLore: "Editable World Lore",
    yourLore: "Your Session Entries",
    noLore: "The author has not made any world lore editable.",
    authorAllowed: "Author allowed",
    original: "Author version",
    override: "Session version",
    revert: "Revert",
    add: "Add session lore",
    name: "Name",
    content: "Content",
    keywords: "Keywords, separated by commas",
    always: "Always include",
    enabled: "Enabled",
    additionsClosed: "The author does not allow new session lore, but approved world lore can still be edited.",
    streaming: "Wait for the current reply to finish before editing story state.",
    error: "Lore Shift could not load.",
    saved: "Saved",
  },
  zh: {
    title: "Lore Shift", scope: "所有更改只影响当前会话，不会修改作者的原世界。", state: "故事状态", lore: "会话设定",
    save: "保存更改", saving: "正在保存…", close: "关闭", blockedTitle: "此故事无法使用 Lore Shift",
    blockedBody: "作者已关闭会话设定编辑。你可以继续游玩，但 Lore Shift 无法修改这个故事的状态或设定。", loading: "正在检查作者权限…",
    emptyState: "作者没有开放任何可编辑的故事状态。", editableLore: "可编辑的世界设定", yourLore: "你的会话条目", noLore: "作者没有开放任何世界设定。",
    authorAllowed: "作者已允许", original: "作者版本", override: "会话版本", revert: "恢复", add: "新增会话设定", name: "名称", content: "内容",
    keywords: "关键词，用逗号分隔", always: "每回合提供", enabled: "启用", additionsClosed: "作者不允许新增会话设定，但仍可编辑已批准的世界设定。",
    streaming: "请等待当前回复结束后再修改故事状态。", error: "无法加载 Lore Shift。", saved: "已保存",
  },
  "zh-Hant": {
    title: "Lore Shift", scope: "所有變更只影響目前工作階段，不會修改作者的原始世界。", state: "故事狀態", lore: "工作階段設定",
    save: "儲存變更", saving: "正在儲存…", close: "關閉", blockedTitle: "此故事無法使用 Lore Shift",
    blockedBody: "作者已關閉工作階段設定編輯。你可以繼續遊玩，但 Lore Shift 無法修改這個故事的狀態或設定。", loading: "正在檢查作者權限…",
    emptyState: "作者沒有開放任何可編輯的故事狀態。", editableLore: "可編輯的世界設定", yourLore: "你的工作階段條目", noLore: "作者沒有開放任何世界設定。",
    authorAllowed: "作者已允許", original: "作者版本", override: "工作階段版本", revert: "還原", add: "新增工作階段設定", name: "名稱", content: "內容",
    keywords: "關鍵字，以逗號分隔", always: "每回合提供", enabled: "啟用", additionsClosed: "作者不允許新增工作階段設定，但仍可編輯已核准的世界設定。",
    streaming: "請等待目前回覆結束後再修改故事狀態。", error: "無法載入 Lore Shift。", saved: "已儲存",
  },
  ja: {
    title: "Lore Shift", scope: "変更はこのセッションだけに適用され、作者の元ワールドは変わりません。", state: "ストーリー状態", lore: "セッション設定",
    save: "変更を保存", saving: "保存中…", close: "閉じる", blockedTitle: "この物語では Lore Shift を使えません",
    blockedBody: "作者がセッション設定の編集を無効にしています。プレイは続けられますが、Lore Shift で状態や設定は変更できません。", loading: "作者の権限を確認中…",
    emptyState: "作者が編集を許可したストーリー状態はありません。", editableLore: "編集可能なワールド設定", yourLore: "自分のセッション項目", noLore: "作者が編集を許可したワールド設定はありません。",
    authorAllowed: "作者が許可", original: "作者版", override: "セッション版", revert: "元に戻す", add: "セッション設定を追加", name: "名前", content: "内容",
    keywords: "キーワード（カンマ区切り）", always: "常に含める", enabled: "有効", additionsClosed: "新しい項目は追加できませんが、許可されたワールド設定は編集できます。",
    streaming: "現在の返信が終わってからストーリー状態を編集してください。", error: "Lore Shift を読み込めませんでした。", saved: "保存しました",
  },
  es: {
    title: "Lore Shift", scope: "Los cambios solo se aplican a esta sesión. El mundo del autor no cambia.", state: "Estado de la historia", lore: "Lore de sesión",
    save: "Guardar cambios", saving: "Guardando…", close: "Cerrar", blockedTitle: "Lore Shift no está disponible para esta historia",
    blockedBody: "El autor ha desactivado la edición de lore en la sesión. Puedes seguir jugando, pero Lore Shift no puede cambiar el estado ni el lore de esta historia.", loading: "Comprobando los permisos del autor…",
    emptyState: "El autor no ha permitido editar ningún campo de estado.", editableLore: "Lore del mundo editable", yourLore: "Tus entradas de sesión", noLore: "El autor no ha permitido editar lore del mundo.",
    authorAllowed: "Permitido por el autor", original: "Versión del autor", override: "Versión de la sesión", revert: "Restaurar", add: "Añadir lore de sesión", name: "Nombre", content: "Contenido",
    keywords: "Palabras clave separadas por comas", always: "Incluir siempre", enabled: "Activada", additionsClosed: "El autor no permite lore nuevo, pero aún puedes editar el lore aprobado.",
    streaming: "Espera a que termine la respuesta actual antes de editar el estado.", error: "No se pudo cargar Lore Shift.", saved: "Guardado",
  },
} as const;

function StateEditor({ payload, reload, onResult }: { payload: LiveCanonPayload; reload: () => Promise<void>; onResult: (result: LiveCanonApiResult<unknown>) => boolean }) {
  const api = useYumina();
  const lang = pickLiveCanonLang(api.language);
  const t = COPY[lang] ?? COPY.en;
  const [draft, setDraft] = useState<Record<string, number | string | boolean>>(() => Object.fromEntries(payload.variables.map((v) => [v.id, v.value])));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  if (payload.variables.length === 0) return <p className="py-10 text-center text-xs text-white/40">{t.emptyState}</p>;
  return (
    <div className="space-y-3">
      {api.isStreaming && <p className="rounded-lg border border-amber-300/15 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-100/75">{t.streaming}</p>}
      {payload.variables.map((variable) => (
        <label key={variable.id} className="block rounded-xl border border-white/[0.07] bg-white/[0.025] p-3">
          <span className="mb-2 block text-xs font-semibold text-white/80">{variable.name}</span>
          {variable.type === "boolean" ? (
            <input type="checkbox" checked={Boolean(draft[variable.id])} disabled={api.isStreaming} onChange={(e) => setDraft((current) => ({ ...current, [variable.id]: e.target.checked }))} className="h-4 w-4 accent-primary" />
          ) : (
            <input
              type={variable.type === "number" ? "number" : "text"}
              min={variable.min}
              max={variable.max}
              maxLength={variable.type === "string" ? 500 : undefined}
              disabled={api.isStreaming}
              value={String(draft[variable.id] ?? "")}
              onChange={(e) => setDraft((current) => ({ ...current, [variable.id]: variable.type === "number" ? Number(e.target.value) : e.target.value }))}
              className="w-full rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-sm text-white outline-none focus:border-primary/50"
            />
          )}
        </label>
      ))}
      <button
        type="button"
        disabled={saving || api.isStreaming}
        onClick={async () => {
          setSaving(true); setSaved(false);
          const result = await api.updateLiveCanonState(draft);
          if (onResult(result)) { await reload(); setSaved(true); }
          setSaving(false);
        }}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-40"
      >
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : saved ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
        {saving ? t.saving : saved ? t.saved : t.save}
      </button>
    </div>
  );
}

function SessionEntryEditor({ entry, reload, onResult }: { entry: LiveCanonSessionEntryDTO; reload: () => Promise<void>; onResult: (result: LiveCanonApiResult<unknown>) => boolean }) {
  const api = useYumina();
  const lang = pickLiveCanonLang(api.language);
  const t = COPY[lang] ?? COPY.en;
  const [draft, setDraft] = useState(entry);
  const [saving, setSaving] = useState(false);
  return (
    <div className="space-y-2 rounded-xl border border-white/[0.07] bg-white/[0.025] p-3">
      <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} aria-label={t.name} className="w-full rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-xs text-white outline-none" />
      <textarea value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} aria-label={t.content} rows={4} maxLength={4000} className="w-full resize-y rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-xs leading-relaxed text-white outline-none" />
      <input value={draft.keywords.join(", ")} onChange={(e) => setDraft({ ...draft, keywords: e.target.value.split(/[,，]/).map((v) => v.trim()).filter(Boolean) })} aria-label={t.keywords} placeholder={t.keywords} className="w-full rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-xs text-white outline-none" />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-4 text-[11px] text-white/55">
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />{t.enabled}</label>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={draft.alwaysSend} onChange={(e) => setDraft({ ...draft, alwaysSend: e.target.checked })} />{t.always}</label>
        </div>
        <div className="flex gap-2">
          <button type="button" className="rounded-lg p-2 text-red-300/70 hover:bg-red-500/10" onClick={async () => { if (onResult(await api.deleteLiveCanonEntry(entry.id))) await reload(); }}><Trash2 className="h-3.5 w-3.5" /></button>
          <button type="button" disabled={saving} className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-[11px] font-semibold text-primary-foreground disabled:opacity-40" onClick={async () => { setSaving(true); if (onResult(await api.updateLiveCanonEntry(entry.id, draft))) await reload(); setSaving(false); }}><Save className="h-3.5 w-3.5" />{t.save}</button>
        </div>
      </div>
    </div>
  );
}

export function LiveCanonModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const api = useYumina();
  const lang = pickLiveCanonLang(api.language);
  const t = COPY[lang] ?? COPY.en;
  const [tab, setTab] = useState<Tab>("state");
  const [payload, setPayload] = useState<LiveCanonPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef(0);

  const handleResult = useCallback((result: LiveCanonApiResult<unknown>): boolean => {
    if (result.code === "AUTHOR_DISABLED_LIVE_CANON") {
      setPayload(null); setBlocked(true); setError("");
      return false;
    }
    if (!result.ok) { setError(result.error || t.error); return false; }
    setError("");
    return true;
  }, [t.error]);

  const reload = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    const result = await api.getLiveCanon();
    if (id !== requestId.current) return;
    if (result.code === "AUTHOR_DISABLED_LIVE_CANON") {
      setPayload(null); setBlocked(true); setError(""); setLoading(false); return;
    }
    if (!result.ok || !result.data) {
      setPayload(null); setBlocked(false); setError(result.error || t.error); setLoading(false); return;
    }
    setPayload(result.data); setBlocked(false); setError(""); setLoading(false);
  }, [api, t.error]);

  useEffect(() => {
    if (!open) return;
    const initial = window.setTimeout(() => void reload(), 0);
    const interval = window.setInterval(() => void reload(), 15_000);
    const refresh = () => void reload();
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", visible);
    return () => {
      requestId.current += 1;
      window.clearTimeout(initial);
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [open, reload]);

  const [newEntry, setNewEntry] = useState<LiveCanonEntryInput>({ name: "", content: "", alwaysSend: true, enabled: true, keywords: [] });
  const canCreate = useMemo(() => Boolean(newEntry.name.trim() && newEntry.content.trim()), [newEntry]);
  if (!open) return null;

  return (
    <SandboxPlatformOverlay>
      <div className="fixed inset-0 z-[9999] flex items-center justify-center p-2 pt-[calc(env(safe-area-inset-top,0px)+2.5rem)]" role="dialog" aria-modal="true" aria-label={t.title} onClick={onClose}>
        <div className="absolute inset-0 modal-backdrop" />
        <div className="relative z-10 flex max-h-[min(780px,calc(100dvh-4rem))] w-[min(780px,calc(100vw-1rem))] flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-[#17181b]/95 shadow-2xl" onClick={(e) => e.stopPropagation()}>
          <header className="flex items-start justify-between border-b border-white/[0.06] px-5 py-4">
            <div className="flex gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary"><BookOpenCheck className="h-4 w-4" /></span><div><h2 className="text-sm font-bold text-white">{t.title}</h2><p className="mt-0.5 text-[11px] text-white/40">{t.scope}</p></div></div>
            <button type="button" onClick={onClose} title={t.close} className="rounded-lg p-2 text-white/40 hover:bg-white/5 hover:text-white"><X className="h-4 w-4" /></button>
          </header>

          {loading && !payload && !blocked ? (
            <div className="flex min-h-64 items-center justify-center gap-2 text-xs text-white/45"><Loader2 className="h-4 w-4 animate-spin" />{t.loading}</div>
          ) : blocked ? (
            <div className="flex min-h-72 flex-col items-center justify-center px-6 text-center">
              <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/10 text-amber-300"><AlertTriangle className="h-5 w-5" /></span>
              <h3 className="text-base font-bold text-white">{t.blockedTitle}</h3>
              <p className="mt-2 max-w-md text-xs leading-relaxed text-white/50">{t.blockedBody}</p>
              <button type="button" onClick={onClose} className="mt-6 rounded-lg bg-white/10 px-5 py-2 text-xs font-semibold text-white hover:bg-white/15">{t.close}</button>
            </div>
          ) : payload ? (
            <>
              <nav className="flex border-b border-white/[0.06] px-5">
                {(["state", "lore"] as const).map((item) => <button key={item} type="button" onClick={() => setTab(item)} className={`flex items-center gap-1.5 border-b-2 px-3 py-3 text-xs font-semibold ${tab === item ? "border-primary text-white" : "border-transparent text-white/40"}`}>{item === "state" ? <SlidersHorizontal className="h-3.5 w-3.5" /> : <BookOpenCheck className="h-3.5 w-3.5" />}{item === "state" ? t.state : t.lore}</button>)}
              </nav>
              <div className="flex-1 overflow-y-auto p-5">
                {error && <p className="mb-3 rounded-lg border border-red-400/15 bg-red-500/10 px-3 py-2 text-[11px] text-red-200/80">{error}</p>}
                {tab === "state" ? <StateEditor key={payload.variables.map((variable) => `${variable.id}:${JSON.stringify(variable.value)}`).join("|")} payload={payload} reload={reload} onResult={handleResult} /> : (
                  <div className="space-y-6">
                    <section className="space-y-3"><h3 className="text-xs font-bold uppercase tracking-wide text-white/55">{t.editableLore}</h3>
                      {payload.editableEntries.length === 0 ? <p className="py-5 text-center text-xs text-white/35">{t.noLore}</p> : payload.editableEntries.map((entry) => <div key={entry.id} className="space-y-2 rounded-xl border border-white/[0.07] bg-white/[0.025] p-3"><div className="flex items-center justify-between gap-2"><strong className="text-xs text-white/80">{entry.name}</strong><span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[9px] font-semibold text-emerald-300">{t.authorAllowed}</span></div><details className="text-[11px] text-white/40"><summary className="cursor-pointer">{t.original}</summary><p className="mt-1 whitespace-pre-wrap rounded-lg bg-black/20 p-2 leading-relaxed">{entry.content}</p></details><textarea defaultValue={entry.overrideContent ?? entry.content} key={entry.overrideContent ?? entry.content} id={`base-${entry.id}`} rows={5} maxLength={4000} aria-label={`${entry.name} ${t.override}`} className="w-full resize-y rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-xs leading-relaxed text-white outline-none" /><div className="flex justify-end gap-2">{entry.overrideId && <button type="button" onClick={async () => { if (handleResult(await api.revertLiveCanonBaseEntry(entry.id))) await reload(); }} className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-[11px] text-white/60"><RotateCcw className="h-3.5 w-3.5" />{t.revert}</button>}<button type="button" onClick={async () => { const el = document.getElementById(`base-${entry.id}`) as HTMLTextAreaElement | null; if (el && handleResult(await api.saveLiveCanonBaseEntry(entry.id, el.value))) await reload(); }} className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-[11px] font-semibold text-primary-foreground"><Save className="h-3.5 w-3.5" />{t.save}</button></div></div>)}
                    </section>
                    <section className="space-y-3"><h3 className="text-xs font-bold uppercase tracking-wide text-white/55">{t.yourLore}</h3>
                      {!payload.additionsAllowed && <p className="rounded-lg border border-amber-300/10 bg-amber-500/[0.06] px-3 py-2 text-[11px] text-amber-100/60">{t.additionsClosed}</p>}
                      {payload.sessionEntries.map((entry) => <SessionEntryEditor key={entry.id} entry={entry} reload={reload} onResult={handleResult} />)}
                      {payload.additionsAllowed && <div className="space-y-2 rounded-xl border border-dashed border-white/10 p-3"><input value={newEntry.name} onChange={(e) => setNewEntry({ ...newEntry, name: e.target.value })} placeholder={t.name} maxLength={120} className="w-full rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-xs text-white outline-none" /><textarea value={newEntry.content} onChange={(e) => setNewEntry({ ...newEntry, content: e.target.value })} placeholder={t.content} rows={4} maxLength={4000} className="w-full resize-y rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-xs text-white outline-none" /><input value={(newEntry.keywords ?? []).join(", ")} onChange={(e) => setNewEntry({ ...newEntry, keywords: e.target.value.split(/[,，]/).map((v) => v.trim()).filter(Boolean) })} placeholder={t.keywords} className="w-full rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-xs text-white outline-none" /><button type="button" disabled={!canCreate} onClick={async () => { if (handleResult(await api.createLiveCanonEntry(newEntry))) { setNewEntry({ name: "", content: "", alwaysSend: true, enabled: true, keywords: [] }); await reload(); } }} className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-white/10 px-3 py-2 text-xs font-semibold text-white disabled:opacity-35"><Plus className="h-3.5 w-3.5" />{t.add}</button></div>}
                    </section>
                  </div>
                )}
              </div>
            </>
          ) : <div className="flex min-h-64 items-center justify-center px-5 text-center text-xs text-red-200/70">{error || t.error}</div>}
        </div>
      </div>
    </SandboxPlatformOverlay>
  );
}
