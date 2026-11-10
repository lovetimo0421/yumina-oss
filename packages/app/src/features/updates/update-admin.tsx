/**
 * Admin tools for the update log: the entry editor and the change history.
 * Everything here talks to /api/changelog/admin/*, which only admins pass.
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import DOMPurify from "dompurify";
import { Languages, Loader2 } from "lucide-react";
import {
  CHANGELOG_AREAS,
  CHANGELOG_LANGS,
  changelogAreaLabel,
  type ChangelogEditable,
  type ChangelogLang,
  type ChangelogRevisionView,
} from "@yumina/shared";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { confirmAction } from "@/components/ui/global-confirm-dialog";
import { formatDateTime } from "@/lib/locale-date";
import { cn } from "@/lib/utils";

const apiBase = import.meta.env.VITE_API_URL || "";

export interface AdminResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
  field?: string | null;
}

export async function changelogAdmin<T>(path: string, method = "GET", body?: unknown): Promise<AdminResult<T>> {
  try {
    const res = await fetch(`${apiBase}/api/changelog/admin${path}`, {
      method,
      credentials: "include",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { data?: T; error?: string; field?: string | null };
    return { ok: res.ok, status: res.status, data: json.data, error: json.error, field: json.field };
  } catch {
    return { ok: false, status: 0 };
  }
}

/** Each language named in itself — the tab labels, the same in every UI language. */
export const LANG_NAMES: Record<ChangelogLang, string> = {
  zh: "简体中文",
  en: "English",
  "zh-Hant": "繁體中文",
  es: "Español",
  ja: "日本語",
};
const REQUIRED = new Set<ChangelogLang>(["zh", "en"]);
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const emptyLangs = () => Object.fromEntries(CHANGELOG_LANGS.map((l) => [l, ""])) as Record<ChangelogLang, string>;

interface Form {
  date: string;
  slug: string;
  audience: "public" | "internal" | "unrestricted";
  areas: string[];
  title: Record<ChangelogLang, string>;
  body: Record<ChangelogLang, string>;
  highlight: boolean;
  kind: "standard" | "roundup";
  revision: string | null;
}

type FieldError = { field: string | null; message: string; detail?: string };

const inputClass =
  "h-10 w-full rounded-lg border border-border bg-input px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-primary/60";
const labelClass = "mb-1.5 block text-xs font-medium text-muted-foreground";

const PREVIEW_CLASS = cn(
  "min-w-0 text-[14px] leading-7 text-foreground/85 [overflow-wrap:anywhere]",
  "[&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li::marker]:text-primary/70",
  "[&_strong]:font-semibold [&_strong]:text-foreground [&_a]:text-primary [&_a]:underline [&_h3]:mt-3 [&_h3]:font-semibold",
);

export function UpdateEditor({
  entryId,
  locale,
  onClose,
  onSaved,
}: {
  /** null = create a new entry. */
  entryId: string | null;
  locale: string;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<Form | null>(
    entryId ? null : {
      date: today(), slug: "", audience: "public", areas: [], title: emptyLangs(), body: emptyLangs(),
      highlight: false, kind: "standard", revision: null,
    },
  );
  const [meta, setMeta] = useState<Pick<ChangelogEditable, "hasFile" | "fromWeb"> | null>(null);
  const [lang, setLang] = useState<ChangelogLang>("zh");
  const [error, setError] = useState<FieldError | null>(null);
  const [saving, setSaving] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [previewHtml, setPreviewHtml] = useState("");

  useEffect(() => {
    if (!entryId) return;
    let live = true;
    void changelogAdmin<ChangelogEditable>(`/entries/${encodeURIComponent(entryId)}`).then((res) => {
      if (!live) return;
      if (!res.ok || !res.data) {
        setError({ field: null, message: t("updates.admin.errGeneric"), detail: res.error });
        return;
      }
      const d = res.data;
      setForm({
        date: d.date, slug: "", audience: d.audience, areas: d.areas, title: d.title, body: d.body,
        highlight: d.highlight, kind: d.kind, revision: d.revision,
      });
      setMeta({ hasFile: d.hasFile, fromWeb: d.fromWeb });
    });
    return () => {
      live = false;
    };
  }, [entryId, t]);

  // Live preview, rendered by the same server code that renders the page.
  const markdown = form?.body[lang] ?? "";
  useEffect(() => {
    if (!markdown.trim()) {
      setPreviewHtml("");
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      void changelogAdmin<{ html: string }>("/preview", "POST", { markdown }).then((res) => {
        if (live && res.ok && res.data) setPreviewHtml(DOMPurify.sanitize(res.data.html, { ADD_ATTR: ["target"] }));
      });
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [markdown]);

  // Any change clears the last save error; the next save checks again.
  const set = (patch: Partial<Form>) => {
    setError(null);
    setForm((f) => (f ? { ...f, ...patch } : f));
  };
  const setLangText = (key: "title" | "body", value: string) => {
    setError(null);
    setForm((f) => (f ? { ...f, [key]: { ...f[key], [lang]: value } } : f));
  };

  const canTranslate = Boolean(form && form.title.zh.trim() && form.title.en.trim() && form.body.zh.trim() && form.body.en.trim());

  function messageFor(field: string | null | undefined, status: number, detail?: string): FieldError {
    const f = field ?? null;
    const langOf = (key: string) => LANG_NAMES[key.split(".")[1] as ChangelogLang] ?? key;
    if (status === 409 && !f) return { field: null, message: t("updates.admin.errConflict") };
    if (f === "date") return { field: f, message: t("updates.admin.errDate"), detail };
    if (f === "audience") return { field: f, message: t("updates.admin.errAudience"), detail };
    if (f === "areas") return { field: f, message: t("updates.admin.errAreas"), detail };
    if (f === "id") return { field: f, message: t("updates.admin.errId"), detail };
    if (f?.startsWith("title.")) return { field: f, message: t("updates.admin.errTitle", { lang: langOf(f) }), detail };
    if (f?.startsWith("body.")) return { field: f, message: t("updates.admin.errBody", { lang: langOf(f) }), detail };
    return { field: f, message: t("updates.admin.errGeneric"), detail };
  }

  async function save() {
    if (!form) return;
    setError(null);
    // Quick local checks for the common misses; the server applies the full rules.
    if (!entryId && !SLUG_RE.test(form.slug.trim())) return setError(messageFor("id", 400));
    if (!form.areas.length) return setError(messageFor("areas", 400));
    for (const l of ["zh", "en"] as const) {
      if (!form.title[l].trim()) {
        setLang(l);
        return setError(messageFor(`title.${l}`, 400));
      }
      if (!form.body[l].trim()) {
        setLang(l);
        return setError(messageFor(`body.${l}`, 400));
      }
    }
    setSaving(true);
    const payload = {
      date: form.date, audience: form.audience, areas: form.areas, title: form.title, body: form.body,
      highlight: form.highlight, kind: form.kind,
    };
    const res = entryId
      ? await changelogAdmin<ChangelogEditable>(`/entries/${encodeURIComponent(entryId)}`, "PUT", { ...payload, revision: form.revision })
      : await changelogAdmin<ChangelogEditable>("/entries", "POST", { ...payload, slug: form.slug.trim() });
    setSaving(false);
    if (!res.ok || !res.data) {
      const err = messageFor(res.field, res.status, res.error);
      const target = err.field?.split(".")[1] as ChangelogLang | undefined;
      if (target && (CHANGELOG_LANGS as readonly string[]).includes(target)) setLang(target);
      return setError(err);
    }
    onSaved(res.data.id);
  }

  async function translate() {
    if (!form || !canTranslate) {
      setNote(t("updates.admin.translateNeeds"));
      return;
    }
    const filled = (["zh-Hant", "es", "ja"] as const).some((l) => form.title[l].trim() || form.body[l].trim());
    if (filled && !(await confirmAction(t("updates.admin.translateOverwrite")))) return;
    setTranslating(true);
    setNote(null);
    const res = await changelogAdmin<Record<"zh-Hant" | "es" | "ja", { title: string; body: string }>>("/translate", "POST", {
      title: { zh: form.title.zh, en: form.title.en },
      body: { zh: form.body.zh, en: form.body.en },
    });
    setTranslating(false);
    if (!res.ok || !res.data) {
      setNote(t("updates.admin.translateFailed", { message: res.error ?? res.status }));
      return;
    }
    const out = res.data;
    setForm((f) =>
      f
        ? {
            ...f,
            title: { ...f.title, "zh-Hant": out["zh-Hant"].title, es: out.es.title, ja: out.ja.title },
            body: { ...f.body, "zh-Hant": out["zh-Hant"].body, es: out.es.body, ja: out.ja.body },
          }
        : f,
    );
    setNote(t("updates.admin.translated"));
    setLang("zh-Hant");
  }

  const fieldHas = (name: string) => error?.field === name;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        mobileSheet
        className="flex max-h-[94dvh] flex-col gap-0 overflow-hidden p-0 sm:max-h-[min(92dvh,56rem)] sm:max-w-4xl"
        onInteractOutside={(e) => e.preventDefault()}
      >
        <div className="border-b border-border px-5 pb-3 pt-5 sm:px-6">
          <DialogTitle className="pr-10 text-lg font-semibold">{entryId ? t("updates.admin.editorEdit") : t("updates.admin.editorNew")}</DialogTitle>
          <DialogDescription className={cn("mt-1 text-xs text-muted-foreground", !(meta?.hasFile && entryId) && "sr-only")}>
            {meta?.hasFile && entryId ? t("updates.admin.fromFileNote") : entryId ?? t("updates.admin.editorNew")}
          </DialogDescription>
        </div>

        {!form ? (
          <div className="flex items-center gap-2 px-6 py-10 text-sm text-muted-foreground">
            {error ? error.message : <><Loader2 className="h-4 w-4 animate-spin" />{t("updates.admin.loadingEntry")}</>}
          </div>
        ) : (
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-5 py-4 sm:px-6">
            <div className="grid gap-4 sm:grid-cols-[11rem_1fr]">
              <div>
                <label className={labelClass} htmlFor="update-date">{t("updates.admin.date")}</label>
                <input id="update-date" type="date" value={form.date} onChange={(e) => set({ date: e.target.value })}
                  className={cn(inputClass, "[color-scheme:dark]", fieldHas("date") && "border-destructive")} />
              </div>
              {entryId ? (
                <div className="min-w-0">
                  <span className={labelClass}>{t("updates.admin.link")}</span>
                  <p className="truncate rounded-lg border border-border bg-white/[0.02] px-3 py-2.5 font-mono text-xs text-muted-foreground">#{entryId}</p>
                </div>
              ) : (
                <div className="min-w-0">
                  <label className={labelClass} htmlFor="update-slug">{t("updates.admin.slug")}</label>
                  <div className={cn("flex h-10 items-center overflow-hidden rounded-lg border border-border bg-input focus-within:border-primary/60", fieldHas("id") && "border-destructive")}>
                    <span className="shrink-0 pl-3 font-mono text-xs text-muted-foreground/70">{form.date}-</span>
                    <input id="update-slug" value={form.slug} onChange={(e) => set({ slug: e.target.value.toLowerCase().replace(/\s+/g, "-") })}
                      placeholder="new-editor" className="h-full min-w-0 flex-1 bg-transparent pr-3 font-mono text-sm outline-none placeholder:text-muted-foreground/40" />
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground/70">{t("updates.admin.slugHint")}</p>
                </div>
              )}
            </div>

            <div>
              <span className={labelClass}>{t("updates.admin.audience")}</span>
              <div className="inline-flex rounded-full border border-border p-0.5">
                {(["public", "unrestricted", "internal"] as const).map((a) => (
                  <button key={a} type="button" aria-pressed={form.audience === a} onClick={() => set({ audience: a })}
                    className={cn("rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors",
                      form.audience === a ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground")}>
                    {a === "public" ? t("updates.admin.audiencePublic") : a === "unrestricted" ? t("updates.admin.audienceUnrestricted") : t("updates.admin.audienceInternal")}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <span className={labelClass}>{t("updates.admin.areas")}</span>
              <div className={cn("flex flex-wrap gap-2 rounded-xl", fieldHas("areas") && "ring-1 ring-destructive ring-offset-4 ring-offset-card")}>
                {CHANGELOG_AREAS.map(({ slug }) => {
                  const on = form.areas.includes(slug);
                  return (
                    <button key={slug} type="button" aria-pressed={on}
                      onClick={() => set({ areas: on ? form.areas.filter((a) => a !== slug) : [...form.areas, slug] })}
                      className={cn("rounded-full border px-3 py-1.5 text-[13px] font-medium transition-colors",
                        on ? "border-primary/60 bg-primary/15 text-primary" : "border-border bg-white/[0.02] text-muted-foreground hover:text-foreground")}>
                      {changelogAreaLabel(slug, locale)}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <div>
                <span className={labelClass}>{t("updates.admin.style")}</span>
                <div className="inline-flex rounded-full border border-border p-0.5">
                  {(["standard", "roundup"] as const).map((k) => (
                    <button key={k} type="button" aria-pressed={form.kind === k} onClick={() => set({ kind: k })}
                      className={cn("rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors",
                        form.kind === k ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground")}>
                      {k === "standard" ? t("updates.admin.kindStandard") : t("updates.admin.kindRoundup")}
                    </button>
                  ))}
                </div>
                <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-[13px] leading-snug text-foreground/85">
                  <input type="checkbox" checked={form.highlight} onChange={(e) => set({ highlight: e.target.checked })}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-[#C9A25E]" />
                  {t("updates.admin.highlightToggle")}
                </label>
              </div>
            </div>

            <div>
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div role="tablist" className="scrollbar-hide -mx-5 flex gap-1 overflow-x-auto px-5 sm:mx-0 sm:px-0">
                  {CHANGELOG_LANGS.map((l) => {
                    const filled = Boolean(form.title[l].trim() && form.body[l].trim());
                    const missing = REQUIRED.has(l) && !filled;
                    return (
                      <button key={l} type="button" role="tab" aria-selected={lang === l} onClick={() => setLang(l)}
                        className={cn("flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors",
                          lang === l ? "bg-white/[0.07] text-foreground" : "text-muted-foreground hover:text-foreground",
                          error?.field?.endsWith(`.${l}`) && "text-destructive")}>
                        <span className={cn("h-1.5 w-1.5 rounded-full", filled ? "bg-primary" : missing ? "bg-destructive/80" : "bg-white/15")} />
                        {LANG_NAMES[l]}
                        {REQUIRED.has(l) && <span className="text-[10px] text-muted-foreground/60">*</span>}
                      </button>
                    );
                  })}
                </div>
                <button type="button" onClick={() => void translate()} disabled={translating}
                  className={cn("flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-medium transition-colors",
                    canTranslate ? "border-primary/40 text-primary hover:bg-primary/10" : "border-border text-muted-foreground")}>
                  {translating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Languages className="h-3.5 w-3.5" />}
                  {translating ? t("updates.admin.translating") : t("updates.admin.translate")}
                </button>
              </div>
              {note && <p className="mt-2 text-xs text-primary/90">{note}</p>}

              <div className="mt-3 grid gap-4 lg:grid-cols-2">
                <div className="space-y-3">
                  <div>
                    <label className={labelClass} htmlFor="update-title">
                      {t("updates.admin.entryTitle")} · {LANG_NAMES[lang]}{REQUIRED.has(lang) && <span className="ml-1 text-muted-foreground/60">({t("updates.admin.required")})</span>}
                    </label>
                    <input id="update-title" value={form.title[lang]} onChange={(e) => setLangText("title", e.target.value)}
                      className={cn(inputClass, fieldHas(`title.${lang}`) && "border-destructive")} />
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="update-body">{t("updates.admin.body")}</label>
                    <textarea id="update-body" value={form.body[lang]} onChange={(e) => setLangText("body", e.target.value)} rows={9}
                      placeholder={"· …\n· …"}
                      className={cn("w-full resize-y rounded-lg border border-border bg-input px-3 py-2.5 text-[13px] leading-6 text-foreground outline-none focus:border-primary/60",
                        fieldHas(`body.${lang}`) && "border-destructive")} />
                  </div>
                </div>
                <div className="min-w-0">
                  <span className={labelClass}>{t("updates.admin.preview")}</span>
                  <div className="min-h-[8rem] rounded-xl border border-dashed border-border bg-white/[0.015] px-4 py-3">
                    {form.title[lang].trim() && <p className="mb-1 font-semibold text-foreground">{form.title[lang]}</p>}
                    {previewHtml ? (
                      <div className={PREVIEW_CLASS} dangerouslySetInnerHTML={{ __html: previewHtml }} />
                    ) : (
                      <p className="text-xs text-muted-foreground/60">{t("updates.admin.previewEmpty")}</p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="flex flex-col gap-3 border-t border-border px-5 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className={cn("min-h-[1.25rem] text-[13px] text-destructive", !(error && form) && "max-sm:hidden")} role="alert">
            {error && form && (
              <>
                {error.message}
                {error.detail && <span className="ml-1 text-xs text-destructive/70">({error.detail})</span>}
              </>
            )}
          </div>
          <div className="flex shrink-0 justify-end gap-2">
            <button type="button" onClick={onClose} className="h-10 rounded-full border border-border px-4 text-sm text-foreground/85 hover:bg-white/5">
              {t("updates.admin.cancel")}
            </button>
            <button type="button" onClick={() => void save()} disabled={!form || saving}
              className="flex h-10 items-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {saving ? t("updates.admin.saving") : t("updates.admin.save")}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const ACTION_KEYS = {
  create: "updates.admin.actCreate",
  edit: "updates.admin.actEdit",
  hide: "updates.admin.actHide",
  unhide: "updates.admin.actUnhide",
  restore: "updates.admin.actRestore",
  delete: "updates.admin.actDelete",
} as const satisfies Record<ChangelogRevisionView["action"], string>;

export function UpdateHistory({ entryId, locale, onClose }: { entryId: string; locale: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<ChangelogRevisionView[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    void changelogAdmin<ChangelogRevisionView[]>(`/entries/${encodeURIComponent(entryId)}/revisions`).then((res) => {
      if (res.ok && res.data) setRows(res.data);
      else setFailed(true);
    });
  }, [entryId]);
  const titleOf = useMemo(
    () => (r: ChangelogRevisionView) => r.snapshot.title?.[locale as ChangelogLang] ?? r.snapshot.title?.en ?? r.snapshot.title?.zh ?? "",
    [locale],
  );
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent mobileSheet className="sm:max-w-lg">
        <DialogTitle className="pr-10 text-lg font-semibold">{t("updates.admin.historyTitle")}</DialogTitle>
        <DialogDescription className="-mt-2 truncate font-mono text-xs text-muted-foreground">#{entryId}</DialogDescription>
        {!rows ? (
          <p className="text-sm text-muted-foreground">{failed ? t("updates.admin.actionFailed") : t("updates.admin.loadingEntry")}</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("updates.admin.historyEmpty")}</p>
        ) : (
          <ol className="space-y-3">
            {rows.map((r) => (
              <li key={r.id} className="rounded-xl border border-border bg-white/[0.02] px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  <span className="font-semibold text-primary">{t(ACTION_KEYS[r.action])}</span>
                  <span className="text-muted-foreground">{formatDateTime(r.createdAt, locale)}</span>
                  {r.by.name && <span className="text-muted-foreground">· {r.by.name}</span>}
                </div>
                {titleOf(r) && <p className="mt-1 text-sm text-foreground/90">{titleOf(r)}</p>}
                {r.snapshot.date && (
                  <p className="mt-0.5 text-[11px] text-muted-foreground/80">
                    {r.snapshot.date} · {r.snapshot.audience === "internal" ? t("updates.internal") : r.snapshot.audience === "unrestricted" ? t("updates.unrestrictedOnly") : t("updates.admin.audiencePublic")}
                    {r.snapshot.areas?.length ? ` · ${r.snapshot.areas.map((a) => changelogAreaLabel(a, locale)).join(" / ")}` : ""}
                    {r.snapshot.hidden ? ` · ${t("updates.admin.badgeHidden")}` : ""}
                  </p>
                )}
              </li>
            ))}
          </ol>
        )}
      </DialogContent>
    </Dialog>
  );
}
