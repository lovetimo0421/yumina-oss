import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useRouter } from "@tanstack/react-router";
import { AlertTriangle, Check, Loader2, WifiOff } from "lucide-react";
import { LANGUAGE_OPTIONS } from "@/lib/languages";
import { useEditorStore } from "@/stores/editor";

const apiBase = import.meta.env.VITE_API_URL || "";
/** Languages the translator supports (server: CARD_TRANSLATE_LANGS). */
export const AI_TRANSLATE_LANGS = ["en", "zh", "es", "ko", "id", "ru"] as const;
const JOB_KEY = (worldId: string) => `yumina:translate-job:${worldId}`;

interface Quote { targetLang: string; estimateMushies: number; quoteMushies: number; balance: number; existingVariantId: string | null; updatable?: boolean }
type ProblemKind = "missing" | "refused" | "untranslated" | "placeholders" | "duplicate" | "too_short" | "state_value" | "interface_kept";
type ProblemField = "title" | "description" | "opening" | "entry" | "variable" | "behavior" | "interface";
interface Problem { kind: ProblemKind; field: ProblemField; where: string }
interface Job {
  id: string; status: "running" | "succeeded" | "failed"; step: string; done: number; total: number;
  targetLang: string; quoteMushies: number; chargedMushies?: number; variantId?: string; variantName?: string; updateVariantId?: string;
  problems?: Problem[]; error?: string;
}
/** A failed request, as a key under translate.error plus what the message needs. */
interface RequestError { code: string; values?: Record<string, unknown>; variantId?: string; jobId?: string }

const PROBLEM_ORDER: ProblemKind[] = ["refused", "missing", "state_value", "interface_kept", "untranslated", "placeholders", "too_short", "duplicate"];
const KNOWN_ERRORS = new Set(["network", "unauthorized", "rate_limited", "not_found", "bad_language", "no_source_language", "same_language", "exists", "insufficient_credits", "unavailable", "running", "too_many"]);
const KNOWN_FAILS = new Set(["interrupted", "refused", "model_error", "save_failed", "not_found", "unavailable"]);

function readStoredJob(worldId: string): string | null {
  try { return localStorage.getItem(JOB_KEY(worldId)); } catch { return null; }
}
function storeJob(worldId: string, jobId: string | null) {
  try { if (jobId) localStorage.setItem(JOB_KEY(worldId), jobId); else localStorage.removeItem(JOB_KEY(worldId)); } catch { /* per-viewer convenience only */ }
}

/** One place that turns every way a call can fail into a known error code. */
async function request<T>(url: string, init?: RequestInit): Promise<{ data: T } | { error: RequestError }> {
  let res: Response;
  try { res = await fetch(url, { credentials: "include", ...init }); } catch { return { error: { code: "network" } }; }
  let body: any = null;
  try { body = await res.json(); } catch { /* an HTML error page or an empty body */ }
  if (res.ok && body?.data) return { data: body.data as T };
  if (res.status === 401) return { error: { code: "unauthorized" } };
  if (res.status === 429) return { error: { code: "rate_limited" } };
  const code = typeof body?.code === "string" && KNOWN_ERRORS.has(body.code) ? body.code : res.status >= 500 ? "unavailable" : "unknown";
  return { error: { code, values: { need: body?.quoteMushies, balance: body?.balance != null ? Math.floor(body.balance) : undefined }, variantId: body?.variantId, jobId: body?.jobId } };
}

/**
 * "AI 翻译成…": pick a language, see the likely and the maximum price, run the translation in
 * the background, open the draft it creates. Closing the dialog does not stop the job; reopening
 * it picks the job back up. Every failure says what happened and that nothing was charged.
 */
export function TranslateVariantDialog({ open, onClose, worldId, currentLanguage, existingLanguages, destination, onChangeLanguage }: {
  open: boolean;
  onClose: () => void;
  worldId: string;
  currentLanguage: string | null;
  existingLanguages: ReadonlySet<string>;
  destination: "/app/worlds/$worldId/edit" | "/app/studio/$worldId";
  /** Opens the editor's own "change language" picker (for a card with no or an unsupported language). */
  onChangeLanguage?: () => void;
}) {
  const { t } = useTranslation("editor");
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RequestError | null>(null);
  const [connectionLost, setConnectionLost] = useState(false);

  const sourceSupported = !!currentLanguage && (AI_TRANSLATE_LANGS as readonly string[]).includes(currentLanguage);
  // Languages that already have a version stay pickable: from the original, picking one refreshes it.
  const choices = LANGUAGE_OPTIONS.filter((l) => (AI_TRANSLATE_LANGS as readonly string[]).includes(l.code) && l.code !== currentLanguage);

  const poll = useCallback(async (jobId: string) => {
    const r = await request<Job>(`${apiBase}/api/worlds/${worldId}/translate/jobs/${jobId}`);
    if ("error" in r) {
      // A dropped connection does not stop the job on the server: keep polling and say so.
      if (r.error.code === "network" || r.error.code === "unavailable") { setConnectionLost(true); return; }
      // A remembered job that has expired (24 h) or never existed: forget it quietly and show the picker.
      storeJob(worldId, null);
      setJob(null);
      if (r.error.code === "unauthorized") setError(r.error);
      return;
    }
    setConnectionLost(false);
    setJob(r.data);
    // A finished job stays remembered until the creator acts on it (open / try again): it may
    // finish while the dialog is closed, and reopening should still show what it cost and what to check.
    if (r.data.status === "succeeded") void useEditorStore.getState().loadVariants();
  }, [worldId]);

  // The parent passes a fresh onClose each render; reading it through a ref keeps the
  // open-effect below from re-running (and resetting the dialog) on every render.
  const onCloseRef = useRef(onClose);
  // Closing after a finished job has been shown forgets it, so the next open starts fresh.
  const jobRef = useRef<Job | null>(null);
  jobRef.current = job;
  onCloseRef.current = () => {
    if (jobRef.current && jobRef.current.status !== "running") storeJob(worldId, null);
    onClose();
  };

  // Reopening picks up a job that is still running (or just finished) for this card.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setConnectionLost(false);
    const stored = readStoredJob(worldId);
    if (stored) void poll(stored);
    else { setJob(null); setQuote(null); }
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); onCloseRef.current(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, worldId, poll]);

  useEffect(() => {
    if (!open || job?.status !== "running") return;
    const timer = setInterval(() => void poll(job.id), 4000);
    return () => clearInterval(timer);
  }, [open, job, poll]);

  const pick = async (lang: string) => {
    setBusy(true); setError(null);
    try {
      const r = await request<Quote>(`${apiBase}/api/worlds/${worldId}/translate/quote?language=${lang}`);
      if ("error" in r) setError(r.error); else setQuote(r.data);
    } finally { setBusy(false); }
  };

  const start = async () => {
    if (!quote) return;
    setBusy(true); setError(null);
    try {
      // Translate what is saved: unsaved edits in the editor would otherwise be left out.
      const editor = useEditorStore.getState();
      if (editor.isDirty && !(await editor.saveDraft())) { setError({ code: "save_first" }); return; }
      const r = await request<Job>(`${apiBase}/api/worlds/${worldId}/translate`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ language: quote.targetLang, ...(quote.existingVariantId ? { update: true } : {}) }),
      });
      if ("error" in r) {
        // Already running (another tab, or the assistant): follow that run instead of failing.
        if (r.error.code === "running" && r.error.jobId) { storeJob(worldId, r.error.jobId); void poll(r.error.jobId); return; }
        setError(r.error);
        return;
      }
      storeJob(worldId, r.data.id);
      setJob(r.data);
    } finally { setBusy(false); }
  };

  const openVariant = (id: string) => {
    storeJob(worldId, null);
    onClose();
    router.navigate({ to: destination, params: { worldId: id } });
  };
  const reset = () => { storeJob(worldId, null); setJob(null); setQuote(null); setError(null); };

  if (!open) return null;
  const langLabel = (code: string) => LANGUAGE_OPTIONS.find((l) => l.code === code)?.label ?? code;
  const stepLabel = (j: Job) => {
    const name = t(`translate.step.${j.step}`, j.step);
    return j.total > 1 && j.step !== "done" ? `${name} ${j.done}/${j.total}` : name;
  };
  const errorText = (e: RequestError) =>
    e.code === "save_first" ? t("variantBar.saveFirst")
      : t(`translate.error.${KNOWN_ERRORS.has(e.code) ? e.code : "unknown"}`, { ...(e.values ?? {}), defaultValue: t("translate.error.unknown") });
  const where = (p: Problem) => (p.where ? t("translate.where", { field: t(`translate.field.${p.field}`), name: p.where }) : t(`translate.field.${p.field}`));
  const grouped = PROBLEM_ORDER
    .map((kind) => ({ kind, items: [...new Set((job?.problems ?? []).filter((p) => p.kind === kind).map(where))] }))
    .filter((g) => g.items.length);
  const problemCount = grouped.reduce((n, g) => n + g.items.length, 0);

  return createPortal(
    <>
      <div className="fixed inset-0 z-50 modal-backdrop" onClick={() => onCloseRef.current()} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div ref={ref} role="dialog" aria-modal="true" aria-label={t("translate.title")} tabIndex={-1}
          className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto overscroll-contain rounded-2xl border border-border bg-card p-6 shadow-2xl outline-none">
          <h2 className="mb-4 text-lg font-semibold text-foreground">
            {job ? t("translate.titleTo", { language: langLabel(job.targetLang) }) : quote ? t("translate.titleTo", { language: langLabel(quote.targetLang) }) : t("translate.title")}
          </h2>

          {!job && !quote && (
            !sourceSupported ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">{t("translate.error.no_source_language")}</p>
                {onChangeLanguage && (
                  <button type="button" onClick={() => { onClose(); onChangeLanguage(); }} className="w-full rounded-xl border border-border p-3 text-sm hover:bg-accent">
                    {t("translate.changeLanguage")}
                  </button>
                )}
              </div>
            ) : choices.length ? (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {choices.map((lang) => (
                  <button key={lang.code} type="button" disabled={busy} onClick={() => void pick(lang.code)}
                    className="flex min-w-0 items-center gap-2 rounded-xl border border-border p-2.5 transition-colors hover:bg-accent disabled:opacity-50">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/10 text-xs font-bold">{lang.short}</span>
                    <span className="min-w-0 text-left">
                      <span className="block text-sm font-medium text-foreground">{lang.label}</span>
                      {existingLanguages.has(lang.code) && <span className="block text-[11px] text-muted-foreground">{t("translate.updateTag")}</span>}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t("translate.noneLeft")}</p>
            )
          )}

          {!job && quote && (
            quote.existingVariantId && !quote.updatable ? (
              <button type="button" onClick={() => openVariant(quote.existingVariantId!)} className="w-full rounded-xl border border-border p-3 text-sm hover:bg-accent">
                {t("translate.alreadyExists")}
              </button>
            ) : (
              <div className="space-y-3">
                <div className="flex items-baseline justify-between rounded-xl border border-border px-4 py-3">
                  <span className="text-sm text-muted-foreground">{t("translate.price")}</span>
                  <span className="text-right"><span className="block text-sm font-semibold text-foreground">{t("translate.about", { count: quote.estimateMushies })}</span><span className="block text-xs text-muted-foreground">{t("translate.atMost", { count: quote.quoteMushies })}</span></span>
                </div>
                <div className="flex items-baseline justify-between px-1 text-xs text-muted-foreground">
                  <span>{t("translate.balance")}</span><span>{Math.floor(quote.balance).toLocaleString()}</span>
                </div>
                <button type="button" disabled={busy || quote.balance < quote.quoteMushies} onClick={() => void start()}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary p-3 text-sm font-semibold text-primary-foreground disabled:opacity-50">
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                  {quote.balance < quote.quoteMushies ? t("translate.notEnough") : quote.existingVariantId ? t("translate.updateStart", { language: langLabel(quote.targetLang) }) : t("translate.start")}
                </button>
                {quote.existingVariantId && (
                  <button type="button" onClick={() => openVariant(quote.existingVariantId!)} className="w-full rounded-xl p-2 text-xs text-muted-foreground hover:text-foreground">
                    {t("translate.openExisting")}
                  </button>
                )}
              </div>
            )
          )}

          {job?.status === "running" && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-foreground">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />{stepLabel(job)}
              </div>
              {connectionLost ? (
                <p className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400"><WifiOff className="h-3.5 w-3.5" />{t("translate.connectionLost")}</p>
              ) : (
                <p className="text-xs text-muted-foreground">{t("translate.keepsRunning")}</p>
              )}
            </div>
          )}

          {job?.status === "succeeded" && job.variantId && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-foreground">
                <Check className="h-4 w-4 text-primary" />{t(job.updateVariantId ? "translate.doneUpdate" : "translate.doneDraft", { count: job.chargedMushies ?? 0 })}
              </div>
              {problemCount > 0 && (
                <details className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs">
                  <summary className="flex cursor-pointer items-center gap-1.5 text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="h-3.5 w-3.5" />{t("translate.issues", { count: problemCount })}
                  </summary>
                  <div className="mt-2 space-y-2">
                    {grouped.map((g) => (
                      <div key={g.kind}>
                        <p className="text-foreground/90">{t(`translate.problem.${g.kind}`)}</p>
                        <p className="text-muted-foreground">{g.items.slice(0, 8).join(t("translate.listSep"))}{g.items.length > 8 ? ` +${g.items.length - 8}` : ""}</p>
                      </div>
                    ))}
                  </div>
                </details>
              )}
              <button type="button" onClick={() => openVariant(job.variantId!)} className="w-full rounded-xl bg-primary p-3 text-sm font-semibold text-primary-foreground">
                {t("translate.open")}
              </button>
            </div>
          )}

          {job?.status === "failed" && (
            <div className="space-y-3">
              <div className="space-y-1">
                <p className="text-sm text-destructive">{t(`translate.fail.${KNOWN_FAILS.has(job.error ?? "") ? job.error : "model_error"}`, { defaultValue: t("translate.fail.model_error") })}</p>
                <p className="text-xs text-muted-foreground">{t("translate.notCharged")}</p>
              </div>
              {job.error !== "not_found" && (
                <button type="button" onClick={reset} className="w-full rounded-xl border border-border p-3 text-sm hover:bg-accent">
                  {t("translate.retry")}
                </button>
              )}
            </div>
          )}

          {error && (
            <div className="mt-3 space-y-2">
              <p className="text-sm text-destructive">{errorText(error)}</p>
              {error.code === "exists" && error.variantId && (
                <button type="button" onClick={() => openVariant(error.variantId!)} className="w-full rounded-xl border border-border p-3 text-sm hover:bg-accent">{t("translate.openExisting")}</button>
              )}
              {error.code === "no_source_language" && onChangeLanguage && (
                <button type="button" onClick={() => { onClose(); onChangeLanguage(); }} className="w-full rounded-xl border border-border p-3 text-sm hover:bg-accent">{t("translate.changeLanguage")}</button>
              )}
            </div>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}
