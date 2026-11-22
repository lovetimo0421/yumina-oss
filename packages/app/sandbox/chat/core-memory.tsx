// Core memory: the part of "Memory" every player has, with or without the
// Session Memory & Story Summary extension. Opened from "Memory" in the
// composer's "+" menu (MemoryPanelHostMount in component-host).
//
//   • The overview bar: of this session's messages, which the AI reads word
//     for word (story memory), which are folded into a recap, and which it no
//     longer sees at all.
//   • The recap: its size against the share of story memory the player picked
//     in AI settings, and, for a long backlog, the price to add it or skip it.
//   • Pinned notes: facts the player wants the AI to keep. Free, never
//     auto-edited, sent every turn.
//
// The extension's own panel shows the bar and the recap too; a player without
// it gets CoreMemoryPanel, with a way to the extension for the auto notes.
// Copy is kept to labels and numbers: the panel is read mid-story.

import { useCallback, useEffect, useState } from "react";
import { BookOpen, Brain, Loader2, Pin, Sparkles, X } from "lucide-react";
import { formatModelId, RECAP_ALL_THINKING_ERROR, type MemoryOverview } from "@yumina/shared";
import { useYumina } from "../sandbox-context";
import { pickLang } from "./i18n";
import { SandboxPlatformOverlay } from "../platform-overlay-portal";

type Lang = "en" | "zh" | "zhHant" | "ja" | "es" | "ko" | "id" | "ru";

const STRINGS = {
  title: { en: "Memory", zh: "记忆", zhHant: "記憶", ja: "記憶", es: "Memoria", ko: "기억", id: "Memori", ru: "Память" },
  close: { en: "Close", zh: "关闭", zhHant: "關閉", ja: "閉じる", es: "Cerrar", ko: "닫기", id: "Tutup", ru: "Закрыть" },
  barTitle: { en: "What the AI sees", zh: "AI 能看到的", zhHant: "AI 能看到的", ja: "AI が見ているもの", es: "Lo que ve la IA", ko: "AI가 보는 내용", id: "Yang dilihat AI", ru: "Что видит ИИ" },
  recent: { en: "Word for word", zh: "原文", zhHant: "原文", ja: "原文", es: "Tal cual", ko: "원문 그대로", id: "Kata per kata", ru: "Дословно" },
  folded: { en: "Recap", zh: "前情提要", zhHant: "前情提要", ja: "あらすじ", es: "Resumen", ko: "요약", id: "Ringkasan cerita", ru: "Краткое содержание" },
  unseen: { en: "Not seen", zh: "看不到", zhHant: "看不到", ja: "見えない", es: "No ve", ko: "보이지 않음", id: "Tidak terlihat", ru: "Не видно" },
  messages: { en: "{n}", zh: "{n} 条", zhHant: "{n} 條", ja: "{n} 件", es: "{n}", ko: "{n}", id: "{n}", ru: "{n}" },
  recapTitle: { en: "Recap", zh: "前情提要", zhHant: "前情提要", ja: "あらすじ", es: "Resumen previo", ko: "요약", id: "Ringkasan cerita", ru: "Краткое содержание" },
  recapSize: { en: "{share} · {tokens} / {max} tokens", zh: "{share} · {tokens} / {max} token", zhHant: "{share} · {tokens} / {max} token", ja: "{share} · {tokens} / {max} トークン", es: "{share} · {tokens} / {max} tokens", ko: "{share} · {tokens} / {max} 토큰", id: "{share} · {tokens} / {max} token", ru: "{share} · токенов: {tokens} / {max}" },
  recapOff: { en: "Off", zh: "已关闭", zhHant: "已關閉", ja: "オフ", es: "Desactivado", ko: "끄기", id: "Mati", ru: "Выкл." },
  recapChange: { en: "Change", zh: "调整", zhHant: "調整", ja: "変更", es: "Cambiar", ko: "변경", id: "Ubah", ru: "Изменить" },
  recapUpdating: { en: "Updating…", zh: "整理中…", zhHant: "整理中…", ja: "まとめ中…", es: "Actualizando…", ko: "업데이트 중…", id: "Memperbarui…", ru: "Обновление…" },
  recapStop: { en: "Stop", zh: "停止", zhHant: "停止", ja: "停止", es: "Detener", ko: "중지", id: "Berhenti", ru: "Стоп" },
  allThinking: { en: "This model spent its whole reply thinking and wrote no recap. Pick a model that doesn't think for the recap.", zh: "这个模型把整段回复都用在思考上，没写出前情提要。请给前情提要换一个不思考的模型。", zhHant: "這個模型把整段回覆都用在思考上，沒寫出前情提要。請給前情提要換一個不思考的模型。", ja: "このモデルは返答をすべて思考に使い、あらすじを書けませんでした。思考しないモデルを選んでください。", es: "Este modelo gastó toda la respuesta pensando y no escribió el resumen. Elige un modelo que no piense para el resumen.", ko: "이 모델이 답변 전체를 생각하는 데 쓰느라 요약을 작성하지 못했어요. 요약에는 생각하지 않는 모델을 선택해 주세요.", id: "Model ini menghabiskan seluruh balasannya untuk berpikir dan tidak menulis ringkasan cerita. Pilih model yang tidak berpikir untuk ringkasan cerita.", ru: "Эта модель потратила весь ответ на размышления и не написала краткое содержание. Выбери для него модель, которая не размышляет." },
  autoFold: { en: "Auto-fold · word for word {now} / {max} tokens", zh: "自动整理 · 原文 {now} / {max} token", zhHant: "自動整理 · 原文 {now} / {max} token", ja: "自動まとめ · 原文 {now} / {max} トークン", es: "Resumen automático · tal cual {now} / {max} tokens", ko: "자동 정리 · 원문 {now} / {max} 토큰", id: "Lipat otomatis · kata per kata {now} / {max} token", ru: "Автосжатие · дословно, токенов: {now} / {max}" },
  pending: { en: "{n} more after the next reply", zh: "下回合后再整理 {n} 条", zhHant: "下回合後再整理 {n} 條", ja: "次の返信後に {n} 件追加", es: "{n} más tras la próxima respuesta", ko: "다음 답변 후 {n}개 더 정리돼요", id: "{n} lagi setelah balasan berikutnya", ru: "Ещё после следующего ответа: {n}" },
  shareLean: { en: "Lean", zh: "省", zhHant: "省", ja: "節約", es: "Ligero", ko: "간결", id: "Hemat", ru: "Кратко" },
  shareStandard: { en: "Standard", zh: "标准", zhHant: "標準", ja: "標準", es: "Estándar", ko: "표준", id: "Standar", ru: "Стандарт" },
  shareDetailed: { en: "Detailed", zh: "详细", zhHant: "詳細", ja: "詳細", es: "Detallado", ko: "상세", id: "Detail", ru: "Подробно" },
  backfillTitle: { en: "Add what the AI can't see to the recap?", zh: "把看不到的补进前情提要？", zhHant: "把看不到的補進前情提要？", ja: "見えない部分をあらすじに追加？", es: "¿Añadir al resumen lo que la IA no ve?", ko: "AI가 볼 수 없는 내용을 요약에 추가할까요?", id: "Tambahkan hal yang tidak terlihat AI ke ringkasan cerita?", ru: "Добавить в краткое содержание то, чего ИИ не видит?" },
  backfillAll: { en: "Add them", zh: "补上", zhHant: "補上", ja: "追加する", es: "Añadirlos", ko: "추가하기", id: "Tambahkan", ru: "Добавить" },
  backfillSkip: { en: "Skip", zh: "不补", zhHant: "不補", ja: "しない", es: "Omitir", ko: "건너뛰기", id: "Lewati", ru: "Пропустить" },
  credits: { en: "{n} mushies", zh: "{n} 币", zhHant: "{n} 幣", ja: "{n} コイン", es: "{n} setas", ko: "버섯코인 {n}개", id: "{n} mushies", ru: "{n} mushies" },
  pinnedTitle: { en: "Pinned notes", zh: "固定记忆", zhHant: "固定記憶", ja: "固定メモ", es: "Notas fijas", ko: "고정 노트", id: "Catatan tersemat", ru: "Закреплённые заметки" },
  pinnedHint: { en: "Free, sent every turn", zh: "免费，每回合都带上", zhHant: "免費，每回合都帶上", ja: "無料・毎ターン送信", es: "Gratis, en cada turno", ko: "무료, 매 턴마다 전송돼요", id: "Gratis, dikirim setiap giliran", ru: "Бесплатно, отправляются каждый ход" },
  pinnedPlaceholder: { en: "What the AI must always remember", zh: "写下 AI 要一直记住的事", zhHant: "寫下 AI 要一直記住的事", ja: "AI にずっと覚えていてほしいこと", es: "Lo que la IA debe recordar siempre", ko: "AI가 항상 기억해야 할 내용", id: "Hal yang harus selalu diingat AI", ru: "Что ИИ должен помнить всегда" },
  save: { en: "Save", zh: "保存", zhHant: "儲存", ja: "保存", es: "Guardar", ko: "저장", id: "Simpan", ru: "Сохранить" },
  saved: { en: "Saved", zh: "已保存", zhHant: "已儲存", ja: "保存しました", es: "Guardado", ko: "저장됨", id: "Tersimpan", ru: "Сохранено" },
  extTitle: { en: "Auto notes", zh: "自动要点", zhHant: "自動要點", ja: "自動メモ", es: "Notas automáticas", ko: "자동 노트", id: "Catatan otomatis", ru: "Автозаметки" },
  extBody: { en: "The AI keeps its own key facts", zh: "AI 自己记关键事实", zhHant: "AI 自己記關鍵事實", ja: "AI が重要な事実を自分でメモ", es: "La IA anota los datos clave", ko: "AI가 핵심 사실을 직접 기억해요", id: "AI mencatat fakta penting sendiri", ru: "ИИ сам запоминает ключевые факты" },
  extButton: { en: "Turn on", zh: "开启", zhHant: "開啟", ja: "オン", es: "Activar", ko: "켜기", id: "Aktifkan", ru: "Включить" },
  loadFailed: { en: "Couldn't load. Tap to retry.", zh: "没加载出来，点一下重试", zhHant: "沒載入出來，點一下重試", ja: "読み込めませんでした。タップで再試行", es: "No se pudo cargar. Toca para reintentar.", ko: "불러오지 못했어요. 탭해서 다시 시도하세요.", id: "Gagal memuat. Ketuk untuk mencoba lagi.", ru: "Не удалось загрузить. Нажми, чтобы повторить." },
} satisfies Record<string, Record<Lang, string>>;

function useLang(): Lang {
  const api = useYumina();
  if (/^zh[-_](hant|tw|hk|mo)(?:$|[-_])/i.test(api.language ?? "")) return "zhHant";
  return pickLang(api.language);
}

const PINNED_CHANGED_EVENT = "yumina:pinned-notes-changed";

function fill(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key] ?? ""));
}

export function useMemoryOverview(open: boolean) {
  const api = useYumina();
  const [overview, setOverview] = useState<MemoryOverview | null>(null);
  const [failed, setFailed] = useState(false);
  const reload = useCallback(() => {
    setFailed(false);
    api.getMemoryOverview().then(setOverview, () => setFailed(true));
  }, [api]);
  useEffect(() => {
    if (open) reload();
  }, [open, reload]);
  // 「记住这段」 can finish after the panel opened; without this the editor
  // would keep the older notes and a save there would drop the new line.
  useEffect(() => {
    if (!open) return;
    window.addEventListener(PINNED_CHANGED_EVENT, reload);
    return () => window.removeEventListener(PINNED_CHANGED_EVENT, reload);
  }, [open, reload]);
  // While the recap is folding (a backfill can take a while), follow it.
  const updating = open && overview?.recap?.status === "updating";
  useEffect(() => {
    if (!updating) return;
    const timer = setInterval(() => api.getMemoryOverview().then(setOverview, () => {}), 4_000);
    return () => clearInterval(timer);
  }, [api, updating]);
  return { overview, setOverview, failed, reload };
}

/** The recap: its size against the player's chosen budget, and, when it has
 *  more older history than it folds on its own, the player's choice with the
 *  price on the button. */
export function RecapSection({ overview, onChanged, onNavigate }: {
  overview: MemoryOverview;
  onChanged: (next: MemoryOverview) => void;
  /** Called before leaving for AI settings (closes the panel). */
  onNavigate?: () => void;
}) {
  const api = useYumina();
  const lang = useLang();
  const s = (key: keyof typeof STRINGS) => STRINGS[key][lang];
  const [busy, setBusy] = useState<"all" | "skip" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recap = overview.recap;
  if (!recap) return null;
  const shareLabel = recap.share === "lean" ? s("shareLean") : recap.share === "detailed" ? s("shareDetailed") : s("shareStandard");
  const backfill = recap.backfill;
  const askingBackfill = overview.layeredOn && !!backfill?.needsApproval && recap.status !== "updating";
  // Older messages that fold on their own after the next reply.
  const pending = overview.layeredOn && !backfill?.needsApproval
    ? Math.max(0, overview.unseenMessages - (overview.skippedMessages ?? 0))
    : 0;
  const choose = async (mode: "all" | "skip") => {
    setBusy(mode);
    setError(null);
    try {
      onChanged(await api.recapBackfill(mode));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };
  const stop = async () => {
    setBusy("stop");
    setError(null);
    try {
      onChanged(await api.stopRecap());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };
  const toSettings = () => { onNavigate?.(); api.navigate("/app/settings#ai-config"); };
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <BookOpen className="h-3.5 w-3.5 shrink-0 text-sky-300/80" aria-hidden="true" />
        <p className="shrink-0 text-xs font-semibold text-white/85">{s("recapTitle")}</p>
        <p className="min-w-0 flex-1 truncate text-[11.5px] tabular-nums text-white/55">
          {!overview.layeredOn
            ? s("recapOff")
            : recap.status === "updating"
              ? <span className="inline-flex items-center gap-1.5 text-sky-100/75"><Loader2 className="h-3 w-3 animate-spin" />{s("recapUpdating")}</span>
              : fill(s("recapSize"), { share: shareLabel, tokens: recap.tokens.toLocaleString(), max: recap.budgetTokens.toLocaleString() })
                + (recap.model ? ` · ${formatModelId(recap.model)}` : "")}
        </p>
        {overview.layeredOn && recap.status === "updating" && (
          <button
            type="button"
            data-recap-stop=""
            disabled={busy === "stop"}
            onClick={() => void stop()}
            className="shrink-0 rounded-md border border-white/[0.14] px-2 py-0.5 text-[11px] text-white/75 transition-colors hover:border-rose-300/50 hover:text-rose-100 disabled:opacity-40"
          >
            {s("recapStop")}
          </button>
        )}
        <button type="button" onClick={toSettings} className="shrink-0 text-[11px] text-primary/80 underline-offset-2 hover:underline">
          {s("recapChange")}
        </button>
      </div>
      {overview.layeredOn && typeof overview.recentTokens === "number" && (
        // How close the word-for-word history is to story memory: the recap
        // folds on its own only once it fills.
        <p className="text-[11px] tabular-nums text-white/45">
          {fill(s("autoFold"), { now: overview.recentTokens.toLocaleString(), max: overview.storyMemoryTokens.toLocaleString() })}
        </p>
      )}
      {error && !askingBackfill && <p className="text-[11px] text-rose-300">{error}</p>}
      {overview.layeredOn && recap.status === "failed" && recap.error && (
        <p className="text-[11.5px] text-rose-200/80">{recap.error === RECAP_ALL_THINKING_ERROR ? s("allThinking") : recap.error}</p>
      )}
      {pending > 0 && recap.status !== "updating" && (
        <p className="text-[11px] text-sky-100/60">{fill(s("pending"), { n: pending.toLocaleString() })}</p>
      )}
      {askingBackfill && backfill && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300/20 bg-amber-300/[0.06] px-2.5 py-2">
          <p className="min-w-0 flex-1 text-[12px] text-amber-50/85">
            {s("backfillTitle")}
          </p>
          <div className="flex shrink-0 gap-1.5">
            {!backfill.rebuild && <button
              type="button"
              disabled={busy !== null}
              onClick={() => void choose("skip")}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.14] px-2.5 py-1 text-[12px] text-white/75 transition-colors hover:border-primary/50 hover:text-white disabled:opacity-40"
            >
              {busy === "skip" && <Loader2 className="h-3 w-3 animate-spin" />}
              {s("backfillSkip")}
            </button>}
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void choose("all")}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary/90 px-2.5 py-1 text-[12px] font-semibold text-black transition-colors hover:bg-primary disabled:opacity-40"
            >
              {busy === "all" && <Loader2 className="h-3 w-3 animate-spin" />}
              {s("backfillAll")}
              {backfill.estimatedCredits != null && (
                <span className="tabular-nums opacity-70">· {fill(s("credits"), { n: backfill.estimatedCredits.toLocaleString() })}</span>
              )}
            </button>
          </div>
          {error && <p className="w-full text-[11px] text-rose-300">{error}</p>}
        </div>
      )}
    </section>
  );
}

/** Of this session's messages: read word for word, folded into a recap, or
 *  no longer seen at all. */
export function MemoryOverviewBar({ overview }: { overview: MemoryOverview }) {
  const lang = useLang();
  const s = (key: keyof typeof STRINGS) => STRINGS[key][lang];
  const total = Math.max(1, overview.totalMessages);
  const recent = Math.min(overview.recentMessages, overview.totalMessages);
  const unseen = overview.unseenMessages;
  const folded = Math.max(0, overview.totalMessages - recent - unseen);
  const pct = (n: number) => `${(n / total) * 100}%`;
  const segments = [
    { key: "unseen", n: unseen, label: s("unseen"), bar: "bg-rose-400/45", dot: "bg-rose-400/80" },
    { key: "folded", n: folded, label: s("folded"), bar: "bg-sky-400/55", dot: "bg-sky-400/80" },
    { key: "recent", n: recent, label: s("recent"), bar: "bg-primary/70", dot: "bg-primary" },
  ].filter((segment) => segment.n > 0);
  return (
    <section className="space-y-2" aria-label={s("barTitle")}>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
        {segments.map((segment) => (
          <div key={segment.key} className={segment.bar} style={{ width: pct(segment.n) }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-white/60">
        {segments.map((segment) => (
          <span key={segment.key} className="inline-flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${segment.dot}`} />
            {segment.label}
            <span className="tabular-nums text-white/85">{fill(s("messages"), { n: segment.n.toLocaleString() })}</span>
          </span>
        ))}
      </div>
    </section>
  );
}

/** The player's pinned notes: free, never auto-edited, sent every turn. */
export function PinnedNotesEditor({ overview, onSaved }: { overview: MemoryOverview; onSaved: (next: MemoryOverview) => void }) {
  const api = useYumina();
  const lang = useLang();
  const s = (key: keyof typeof STRINGS) => STRINGS[key][lang];
  const [draft, setDraft] = useState(overview.pinned ?? "");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setDraft(overview.pinned ?? ""); }, [overview.pinned]);
  const changed = draft.trim() !== (overview.pinned ?? "").trim();
  const tooLong = draft.length > overview.pinnedMaxChars;
  // The count only shows once it matters.
  const showCount = draft.length > overview.pinnedMaxChars * 0.8;
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await api.savePinnedNotes(draft.trim() ? draft : null);
      onSaved(next);
      setStatus("saved");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <Pin className="h-3.5 w-3.5 shrink-0 text-primary/80" aria-hidden="true" />
        <p className="text-xs font-semibold text-white/85">{s("pinnedTitle")}</p>
        <p className="text-[11px] text-white/40">{s("pinnedHint")}</p>
      </div>
      <textarea
        id="core-memory-pinned"
        value={draft}
        onChange={(e) => { setDraft(e.target.value); setStatus("idle"); }}
        placeholder={s("pinnedPlaceholder")}
        rows={4}
        className="w-full resize-y rounded-lg border border-white/[0.1] bg-black/25 px-3 py-2 text-[13px] leading-relaxed text-white/90 placeholder:text-white/30 focus:border-primary/50 focus:outline-none"
      />
      <div className="flex items-center gap-2">
        {showCount && (
          <span className={`text-[11px] tabular-nums ${tooLong ? "text-rose-300" : "text-white/40"}`}>
            {draft.length.toLocaleString()} / {overview.pinnedMaxChars.toLocaleString()}
          </span>
        )}
        {status === "saved" && !changed && <span className="text-[11px] text-emerald-300/80">{s("saved")}</span>}
        {status === "error" && error && <span className="min-w-0 truncate text-[11px] text-rose-300">{error}</span>}
        <button
          type="button"
          onClick={() => void save()}
          disabled={!changed || saving || tooLong}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-primary/90 px-3 py-1.5 text-[12px] font-semibold text-black transition-colors hover:bg-primary disabled:opacity-40"
        >
          {saving && <Loader2 className="h-3 w-3 animate-spin" />}
          {s("save")}
        </button>
      </div>
    </section>
  );
}

/** "Memory" for a player without the memory extension. */
export function CoreMemoryPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const api = useYumina();
  const lang = useLang();
  const s = (key: keyof typeof STRINGS) => STRINGS[key][lang];
  const { overview, setOverview, failed, reload } = useMemoryOverview(open);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <SandboxPlatformOverlay>
      <div
        className="fixed inset-0 z-[9999] flex items-center justify-center pt-[calc(env(safe-area-inset-top,0px)+2.5rem)] pb-[calc(env(safe-area-inset-bottom,0px)+1.5rem)]"
        onClick={onClose}
        role="dialog"
        aria-modal="true"
        aria-label={s("title")}
      >
        <div className="absolute inset-0 modal-backdrop" />
        <div
          onClick={(e) => e.stopPropagation()}
          className="relative z-10 flex max-h-[min(640px,calc(100dvh-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px)-4rem))] w-[min(480px,calc(100vw-1rem))] flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-[#17181b]/95 shadow-2xl shadow-black/45 backdrop-blur-xl"
        >
          <div className="flex shrink-0 items-center justify-between border-b border-white/[0.06] px-4 py-2.5">
            <h2 className="flex items-center gap-2 text-sm font-bold text-white">
              <Brain className="h-4 w-4 text-primary" aria-hidden="true" />
              {s("title")}
            </h2>
            <button
              type="button"
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-white/35 transition-colors hover:bg-white/5 hover:text-white/70"
              title={s("close")}
              aria-label={s("close")}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
            {!overview ? (
              failed ? (
                <button type="button" onClick={reload} className="w-full py-10 text-center text-[13px] text-white/55 hover:text-white/80">{s("loadFailed")}</button>
              ) : (
                <div className="flex items-center justify-center py-12 text-white/40"><Loader2 className="h-4 w-4 animate-spin" /></div>
              )
            ) : (
              <>
                <MemoryOverviewBar overview={overview} />
                <RecapSection overview={overview} onChanged={setOverview} onNavigate={onClose} />
                <PinnedNotesEditor overview={overview} onSaved={setOverview} />
                <section className="flex items-center gap-2 border-t border-white/[0.06] pt-3">
                  <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary/80" aria-hidden="true" />
                  <p className="shrink-0 text-xs font-semibold text-white/85">{s("extTitle")}</p>
                  <p className="min-w-0 flex-1 truncate text-[11px] text-white/45">{s("extBody")}</p>
                  <button
                    type="button"
                    onClick={() => { onClose(); api.navigate("/app/extensions?tab=discover&extension=session-memory-summary"); }}
                    className="shrink-0 rounded-lg border border-white/[0.14] px-2.5 py-1 text-[12px] text-white/80 transition-colors hover:border-primary/50 hover:text-white"
                  >
                    {s("extButton")}
                  </button>
                </section>
              </>
            )}
          </div>
        </div>
      </div>
    </SandboxPlatformOverlay>
  );
}

/** Add a message's text to the pinned notes ("Remember this"). */
export async function rememberInPinnedNotes(
  api: { getMemoryOverview: () => Promise<MemoryOverview>; savePinnedNotes: (pinned: string | null) => Promise<MemoryOverview> },
  text: string,
): Promise<"saved" | "too-long" | "empty"> {
  const clean = text.replace(/\s+\n/g, "\n").trim();
  if (!clean) return "empty";
  const current = await api.getMemoryOverview();
  const existing = (current.pinned ?? "").trim();
  const next = existing ? `${existing}\n- ${clean}` : `- ${clean}`;
  if (next.length > current.pinnedMaxChars) return "too-long";
  await api.savePinnedNotes(next);
  window.dispatchEvent(new Event(PINNED_CHANGED_EVENT));
  return "saved";
}
