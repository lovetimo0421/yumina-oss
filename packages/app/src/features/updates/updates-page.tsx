import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import DOMPurify from "dompurify";
import {
  Compass,
  CreditCard,
  Eye,
  EyeOff,
  Gauge,
  History,
  Image as ImageIcon,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  PenLine,
  Plus,
  RotateCcw,
  ScrollText,
  Shapes,
  Trash2,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import {
  clampChangelogLang,
  type ChangelogEntryView,
  type ChangelogResponse,
} from "@yumina/shared";
import { cn } from "@/lib/utils";
import { confirmAction } from "@/components/ui/global-confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { feedback } from "@/lib/feedback";
import { changelogAdmin, UpdateEditor, UpdateHistory } from "./update-admin";
import { isUnseen, markerBeforeOpen, markSeen, useSeenMarker } from "./update-seen";

const apiBase = import.meta.env.VITE_API_URL || "";
/** Roundups show this many bullets before "show all". */
const ROUNDUP_FOLD = 4;
/** The page opens on this many entries; the rest wait behind "show earlier". */
const INITIAL_COUNT = 3;

async function fetchChangelog(lang: string): Promise<ChangelogResponse> {
  const res = await fetch(`${apiBase}/api/changelog?lang=${encodeURIComponent(lang)}`, { credentials: "include" });
  if (!res.ok) throw new Error(`changelog ${res.status}`);
  return (await res.json()) as ChangelogResponse;
}

interface AdminHandlers {
  edit: (id: string) => void;
  history: (id: string) => void;
  changed: () => void;
}

function AdminMenu({ entry, handlers }: { entry: ChangelogEntryView; handlers: AdminHandlers }) {
  const { t } = useTranslation();
  const meta = entry.admin!;
  const id = encodeURIComponent(entry.id);
  const run = async (path: string, method: string, confirmText?: string) => {
    if (confirmText && !(await confirmAction(confirmText, { tone: method === "DELETE" ? "destructive" : "warning" }))) return;
    const res = await changelogAdmin(path, method);
    if (!res.ok) feedback.error(t("updates.admin.actionFailed"));
    handlers.changed();
  };
  const restorable = meta.hasFile && meta.fromWeb;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        aria-label={t("updates.admin.more")}
        title={t("updates.admin.more")}
        className="-mr-1.5 shrink-0 rounded-full p-1.5 text-muted-foreground/55 transition-colors hover:bg-white/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 data-[state=open]:bg-white/[0.06] data-[state=open]:text-foreground"
      >
        <MoreHorizontal className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[13rem]">
        <DropdownMenuItem onSelect={() => handlers.edit(entry.id)}>
          <Pencil className="h-4 w-4" />{t("updates.admin.edit")}
        </DropdownMenuItem>
        {meta.hidden ? (
          <DropdownMenuItem onSelect={() => void run(`/entries/${id}/unhide`, "POST")}>
            <Eye className="h-4 w-4" />{t("updates.admin.unhide")}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={() => void run(`/entries/${id}/hide`, "POST")}>
            <EyeOff className="h-4 w-4" />{t("updates.admin.hide")}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => handlers.history(entry.id)}>
          <History className="h-4 w-4" />{t("updates.admin.history")}
        </DropdownMenuItem>
        {(restorable || !meta.hasFile) && <DropdownMenuSeparator />}
        {restorable && (
          <DropdownMenuItem onSelect={() => void run(`/entries/${id}/restore`, "POST", t("updates.admin.confirmRestore"))}>
            <RotateCcw className="h-4 w-4" />{t("updates.admin.restore")}
          </DropdownMenuItem>
        )}
        {!meta.hasFile && (
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={() => void run(`/entries/${id}`, "DELETE", t("updates.admin.confirmDelete"))}
          >
            <Trash2 className="h-4 w-4" />{t("updates.admin.delete")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── look ──────────────────────────────────────────────────────────────────
// Ported from the approved mock (updates-mock-v2): app palette (#121316 page,
// #17181D cards, gold #C9A25E), Nunito Sans for text, Noto Serif SC for the
// page title, month names and the feature title.
const INK = "#EDE6D6";
const INK_3 = "#8A8377";
const SERIF = '"Noto Serif SC", "Songti SC", serif';
const SERIF_FONT_HREF = "https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@600;900&family=Nunito+Sans:wght@800&display=swap";

/** The serif is only used here, so it loads with the page instead of with the app. */
function useSerifFont() {
  useEffect(() => {
    if (document.querySelector(`link[data-updates-font]`)) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = SERIF_FONT_HREF;
    link.dataset.updatesFont = "";
    document.head.appendChild(link);
  }, []);
}

const AREA_ICONS: Record<string, LucideIcon> = {
  chat: MessageSquare,
  discover: Compass,
  image: ImageIcon,
  creator: PenLine,
  community: Users,
  account: CreditCard,
  performance: Gauge,
  other: Shapes,
};

function entryIcon(entry: ChangelogEntryView): LucideIcon {
  if (entry.kind === "roundup") return Wrench;
  if (entry.id.endsWith("-update-log")) return ScrollText;
  return AREA_ICONS[entry.areas[0] ?? "other"] ?? Shapes;
}

function utcDate(date: string): Date | null {
  const [y, m, d] = date.split("-").map(Number);
  return y && m && d ? new Date(Date.UTC(y, m - 1, d)) : null;
}
const CJK = /^(zh|ja)/;
/** "10 月 11 日" in Chinese/Japanese (as in the mock), "Oct 11" / "11 oct" elsewhere. */
function formatDay(date: string, locale: string): string {
  const [, m, d] = date.split("-").map(Number);
  if (CJK.test(locale) && m && d) return `${m} 月 ${d} 日`;
  const value = utcDate(date);
  try {
    return value ? new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: "UTC" }).format(value) : date;
  } catch {
    return date;
  }
}
/** "十月" / "October" for the month heading; "9 月" / "September" inside a sentence. */
function monthName(month: string, locale: string, inSentence = false): string {
  const m = Number(month.slice(5, 7));
  if (inSentence && CJK.test(locale)) return `${m} 月`;
  const value = utcDate(`${month}-01`);
  try {
    const text = value ? new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" }).format(value) : month;
    return inSentence && !locale.startsWith("en") ? text : text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
  } catch {
    return month;
  }
}

/** Bullets: a small rotated gold diamond, 15px/1.75 muted body, bold in ink. */
const LIST_CLASS = cn(
  "[overflow-wrap:anywhere]",
  "[&_p]:my-2 [&_ul]:mt-4 [&_ul]:grid [&_ul]:list-none [&_ul]:gap-[9px] [&_ul]:p-0 [&_ol]:mt-4 [&_ol]:list-decimal [&_ol]:pl-5",
  "[&_li]:relative [&_li]:pl-5 [&_li]:leading-[1.75]",
  "[&_ul>li]:before:absolute [&_ul>li]:before:left-1 [&_ul>li]:before:top-[0.75em] [&_ul>li]:before:h-[5px] [&_ul>li]:before:w-[5px] [&_ul>li]:before:rotate-45 [&_ul>li]:before:bg-[#C9A25E] [&_ul>li]:before:opacity-85 [&_ul>li]:before:content-['']",
  "[&_strong]:font-bold [&_strong]:text-[#EDE6D6] [&_b]:font-bold [&_b]:text-[#EDE6D6]",
  "[&_a]:text-[#C9A25E] [&_a]:underline [&_a]:decoration-[#C9A25E]/40 [&_a]:underline-offset-[3px]",
  "[&_code]:rounded [&_code]:bg-white/[0.06] [&_code]:px-1 [&_code]:text-[0.9em]",
);

function NewTag({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <span className={cn("ml-2 inline-flex items-center rounded-[5px] border border-[#C9A25E]/45 px-1.5 align-[3px] text-[11px] font-bold leading-[18px] text-[#C9A25E]", className)}>
      {t("updates.new")}
    </span>
  );
}

function useCopyLink(id: string) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    const url = `${window.location.origin}${window.location.pathname}#${id}`;
    window.history.replaceState(window.history.state, "", `#${id}`);
    navigator.clipboard?.writeText(url).then(() => setCopied(true)).catch(() => {});
  };
  return { copied, copy };
}

/** The entry's body (sanitized), with the roundup fold after four bullets. */
function EntryBody({ entry, className }: { entry: ChangelogEntryView; className?: string }) {
  const { t } = useTranslation();
  const [unfolded, setUnfolded] = useState(false);
  const html = useMemo(
    () => DOMPurify.sanitize(entry.html, { ADD_ATTR: ["target"], FORBID_TAGS: ["style", "form", "input", "iframe", "img"] }),
    [entry.html],
  );
  const bulletCount = useMemo(() => (html.match(/<li[\s>]/g) ?? []).length, [html]);
  const folds = entry.kind === "roundup" && bulletCount > ROUNDUP_FOLD;
  return (
    <>
      <div
        className={cn(LIST_CLASS, className, folds && !unfolded && "[&_li:nth-child(n+5)]:hidden")}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {folds && (
        <button
          type="button"
          aria-expanded={unfolded}
          onClick={() => setUnfolded((v) => !v)}
          className="relative mt-3.5 rounded text-[13px] font-bold text-[#C9A25E] hover:text-[#F1D49A] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C9A25E]/50"
        >
          {unfolded ? t("updates.collapse") : `${t("updates.expandAll", { count: bulletCount })} ›`}
        </button>
      )}
    </>
  );
}

function AdminCorner({ entry, admin }: { entry: ChangelogEntryView; admin?: AdminHandlers }) {
  if (!admin || !entry.admin) return null;
  return (
    <div className="absolute right-3 top-3 z-[1]">
      <AdminMenu entry={entry} handlers={admin} />
    </div>
  );
}

function AdminMarks({ entry }: { entry: ChangelogEntryView }) {
  const { t } = useTranslation();
  const marks: string[] = [];
  if (entry.audience === "internal") marks.push(t("updates.internal"));
  if (entry.audience === "unrestricted") marks.push(t("updates.unrestrictedOnly"));
  if (entry.admin?.hidden) marks.push(t("updates.admin.badgeHidden"));
  if (entry.admin?.fromWeb) marks.push(entry.admin.hasFile ? t("updates.admin.badgeEdited") : t("updates.admin.badgeWebOnly"));
  if (!marks.length) return null;
  return (
    <span className="ml-2 inline-flex flex-wrap gap-1.5 align-middle">
      {marks.map((mark) => (
        <span key={mark} className="rounded-[5px] border border-dashed border-white/15 px-1.5 text-[11px] font-semibold leading-[18px]" style={{ color: INK_3 }}>
          {mark}
        </span>
      ))}
    </span>
  );
}

interface EntryProps {
  entry: ChangelogEntryView;
  locale: string;
  isNew: boolean;
  targeted: boolean;
  admin?: AdminHandlers;
}

/** The newest entry, when it is a highlight: the big card at the top of the month. */
function FeatureEntry({ entry, locale, isNew, targeted, admin }: EntryProps) {
  const { t } = useTranslation();
  const { copied, copy } = useCopyLink(entry.id);
  const Icon = entryIcon(entry);
  return (
    <article
      id={entry.id}
      className={cn(
        "relative mb-4 scroll-mt-6 overflow-hidden rounded-[22px] border px-5 py-6 transition-shadow duration-700 min-[721px]:px-8 min-[721px]:pb-7 min-[721px]:pt-[30px]",
        targeted ? "border-[#C9A25E]/55 shadow-[0_0_0_4px_rgba(201,162,94,0.08)]" : "border-[#C9A25E]/[0.22]",
        entry.admin?.hidden && "opacity-55",
      )}
      style={{ background: "linear-gradient(160deg,rgba(201,162,94,.09),rgba(201,162,94,0) 55%),#18181d" }}
    >
      <AdminCorner entry={entry} admin={admin} />
      <a
        href={`#${entry.id}`}
        onClick={copy}
        title={copied ? t("updates.copied") : t("updates.copyLink")}
        className="inline-flex items-center gap-2 text-[12px] font-bold tracking-[0.16em] text-[#C9A25E] hover:text-[#F1D49A]"
      >
        <Icon className="h-[15px] w-[15px]" strokeWidth={1.8} aria-hidden />
        {copied ? t("updates.copied") : formatDay(entry.date, locale)}
        {isNew && <NewTag className="ml-1.5 tracking-normal" />}
      </a>
      <h2 className="mb-0 mt-3 text-[clamp(24px,3.4vw,32px)] font-black leading-[1.25]" style={{ fontFamily: SERIF, color: INK }}>
        {entry.title}
        <AdminMarks entry={entry} />
      </h2>
      <EntryBody entry={entry} className="max-w-[640px] text-[16px] text-[#D9D1C1]" />
    </article>
  );
}

/** Every other entry: a card with an icon chip, gold date and title. */
function CardEntry({ entry, locale, isNew, targeted, admin }: EntryProps) {
  const { t } = useTranslation();
  const { copied, copy } = useCopyLink(entry.id);
  const Icon = entryIcon(entry);
  const roundup = entry.kind === "roundup";
  // A roundup titled "改进与修复（9 月 29 日–10 月 10 日）" shows its date range muted, as in the mock.
  const rangeMatch = roundup ? /^(.+?)\s*[（(]([^（）()]+)[）)]\s*$/.exec(entry.title) : null;
  const range = rangeMatch ? { main: rangeMatch[1]!, rest: rangeMatch[2]! } : null;
  return (
    <article
      id={entry.id}
      className={cn(
        "relative scroll-mt-6 overflow-hidden rounded-[20px] border bg-[#17181D] px-[18px] py-5 transition-shadow duration-700 min-[721px]:px-6 min-[721px]:py-[22px]",
        targeted ? "border-[#C9A25E]/50 shadow-[0_0_0_4px_rgba(201,162,94,0.08)]" : "border-white/[0.065]",
        entry.admin?.hidden && "opacity-55",
      )}
    >
      <AdminCorner entry={entry} admin={admin} />
      <div className="relative flex items-start gap-3.5">
        <div className="grid h-[42px] w-[42px] flex-none place-items-center rounded-[13px] border border-[#C9A25E]/[0.18] bg-[#C9A25E]/[0.08] text-[#C9A25E]">
          <Icon className="h-[21px] w-[21px]" strokeWidth={1.8} aria-hidden />
        </div>
        <div className="min-w-0 pr-6">
          <a
            href={`#${entry.id}`}
            onClick={copy}
            title={copied ? t("updates.copied") : t("updates.copyLink")}
            className="text-[12px] font-bold tracking-[0.12em] text-[#C9A25E] hover:text-[#F1D49A]"
          >
            {copied ? t("updates.copied") : formatDay(entry.date, locale)}
          </a>
          <h3 className="mt-[3px] text-[19px] font-extrabold leading-[1.35]" style={{ color: INK }}>
            {range ? (
              <>
                {range.main}{" "}
                <span className="whitespace-nowrap text-[15px] font-semibold" style={{ color: INK_3 }}>{range.rest}</span>
              </>
            ) : (
              entry.title
            )}
            {isNew && <NewTag />}
            <AdminMarks entry={entry} />
          </h3>
        </div>
      </div>
      <EntryBody entry={entry} className={cn("text-[#B9B1A2]", roundup ? "text-[14px]" : "text-[15px]")} />
    </article>
  );
}

export function UpdatesPage() {
  const { t, i18n } = useTranslation();
  const lang = clampChangelogLang(i18n.resolvedLanguage ?? i18n.language);
  useSerifFont();
  const [state, setState] = useState<{ data: ChangelogResponse | null; error: boolean }>({ data: null, error: false });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    fetchChangelog(lang)
      .then((data) => live && setState({ data, error: false }))
      .catch(() => live && setState((s) => (s.data ? s : { data: null, error: true })));
    return () => {
      live = false;
    };
  }, [lang, attempt]);
  const data = state.data;
  const isError = state.error && !data;
  const isPending = !data && !state.error;
  const refetch = useCallback(() => {
    setState((s) => ({ ...s, error: false }));
    setAttempt((n) => n + 1);
  }, []);
  const entries = useMemo(() => data?.entries ?? [], [data]);
  const isAdmin = Boolean(data?.includesInternal);
  const readable = useMemo(() => entries.filter((e) => e.audience !== "internal" && !e.admin?.hidden), [entries]);

  // "New" is decided once, against the marker as it was when the page opened
  // (or, when the bell opened it, as it was before that click marked the newest seen).
  const marker = useSeenMarker();
  const [newIds, setNewIds] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (!data || newIds) return;
    const before = markerBeforeOpen(marker);
    setNewIds(new Set(readable.filter((e) => isUnseen(e, before)).map((e) => e.id)));
  }, [data, readable, marker, newIds]);
  // Remembered as soon as the list is there: a reader who glances and leaves has seen it.
  useEffect(() => {
    if (data) markSeen(readable);
  }, [data, readable]);

  // Admin editor: undefined = closed, null = new entry, string = that entry.
  const [editing, setEditing] = useState<string | null | undefined>(undefined);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const adminHandlers = useMemo<AdminHandlers>(
    () => ({ edit: (id) => setEditing(id), history: (id) => setHistoryFor(id), changed: refetch }),
    [refetch],
  );

  const filtered = entries;

  // The page opens on the newest few; everything older waits behind one button.
  // A link to an older entry (#entry-id) opens the full list so it can land.
  const [showAll, setShowAll] = useState(false);
  const hashId = typeof window === "undefined" ? "" : decodeURIComponent(window.location.hash.replace(/^#/, ""));
  const hashIsOlder = Boolean(hashId) && filtered.findIndex((e) => e.id === hashId) >= INITIAL_COUNT;
  const visible = showAll || hashIsOlder ? filtered : filtered.slice(0, INITIAL_COUNT);
  const hiddenCount = filtered.length - visible.length;
  // The newest visible entry gets the big card when it is a highlight.
  const featureId = visible[0]?.highlight ? visible[0].id : null;

  const months = useMemo(() => {
    const groups: Array<{ month: string; entries: ChangelogEntryView[] }> = [];
    for (const entry of visible) {
      const month = entry.date.slice(0, 7);
      const last = groups[groups.length - 1];
      if (last?.month === month) last.entries.push(entry);
      else groups.push({ month, entries: [entry] });
    }
    return groups;
  }, [visible]);

  // A shared link (#entry-id) lands on its entry once the list has loaded.
  const [targeted, setTargeted] = useState<string | null>(null);
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!hashId || !data || scrolledFor.current === hashId) return;
    const el = document.getElementById(hashId);
    if (!el) return;
    scrolledFor.current = hashId;
    el.scrollIntoView({ block: "start" });
    setTargeted(hashId);
    const timer = window.setTimeout(() => setTargeted(null), 2400);
    return () => window.clearTimeout(timer);
  }, [data, hashId, visible.length]);

  return (
    <main className="h-full overflow-y-auto" style={{ color: INK }}>
      <div className="mx-auto w-full max-w-[1080px] px-4 pb-20 pt-7 min-[721px]:px-[clamp(16px,4vw,56px)]">
        <section
          className="relative overflow-hidden rounded-[20px] border border-white/[0.07] px-[22px] pb-[22px] pt-7 min-[721px]:rounded-[24px] min-[721px]:px-10 min-[721px]:pb-[30px] min-[721px]:pt-10"
          style={{
            background:
              "radial-gradient(90% 130% at 100% 0%, rgba(201,162,94,.14) 0%, rgba(201,162,94,0) 55%), linear-gradient(135deg,#1b1724 0%,#16151c 55%,#141418 100%)",
          }}
        >
          {isAdmin && (
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="absolute right-4 top-4 z-[1] flex h-8 items-center gap-1 rounded-full border border-white/10 bg-black/10 px-3 text-[12.5px] transition-colors hover:border-white/25 hover:text-[#EDE6D6]"
              style={{ color: INK_3 }}
            >
              <Plus className="h-3.5 w-3.5" />
              {t("updates.admin.new")}
            </button>
          )}
          <h1 className="m-0 text-[clamp(34px,5vw,52px)] font-black tracking-[0.04em]" style={{ fontFamily: SERIF, color: "#E9CF9C" }}>
            {t("updates.title")}
          </h1>
        </section>

        {isPending && (
          <div className="mt-9 space-y-4">
            {[0, 1].map((i) => (
              <div key={i} className="h-44 animate-pulse rounded-[20px] border border-white/[0.05] bg-white/[0.02]" />
            ))}
          </div>
        )}
        {isError && (
          <div className="py-10 text-center text-sm" style={{ color: INK_3 }}>
            <p>{t("updates.error")}</p>
            <button type="button" onClick={refetch} className="mt-3 rounded-full border border-white/10 px-4 py-1.5 hover:bg-white/5" style={{ color: INK }}>
              {t("updates.retry")}
            </button>
          </div>
        )}
        {data && filtered.length === 0 && (
          <p className="py-10 text-sm" style={{ color: INK_3 }}>{t("updates.empty")}</p>
        )}

        {months.map(({ month, entries: monthEntries }) => {
          const feature = monthEntries.find((e) => e.id === featureId);
          const cards = monthEntries.filter((e) => e.id !== featureId);
          return (
            <section key={month} aria-label={`${monthName(month, lang)} ${month.slice(0, 4)}`}>
              <h2 className="mb-4 mt-[34px] flex items-center gap-3.5">
                <span aria-hidden className="h-2 w-2 rotate-45 bg-[#C9A25E]" />
                <span className="text-[26px] font-black" style={{ fontFamily: SERIF, color: INK }}>{monthName(month, lang)}</span>
                <span className="text-[13px] tracking-[0.2em]" style={{ color: INK_3 }}>{month.slice(0, 4)}</span>
                <span aria-hidden className="h-px flex-1 bg-[linear-gradient(90deg,rgba(201,162,94,.45),rgba(201,162,94,0))]" />
              </h2>
              {feature && (
                <FeatureEntry entry={feature} locale={lang} isNew={Boolean(newIds?.has(feature.id))} targeted={targeted === feature.id} admin={isAdmin ? adminHandlers : undefined} />
              )}
              {cards.length > 0 && (
                <div className="grid grid-cols-1 gap-4 min-[721px]:grid-cols-2">
                  {cards.map((entry) => (
                    <CardEntry key={entry.id} entry={entry} locale={lang} isNew={Boolean(newIds?.has(entry.id))} targeted={targeted === entry.id} admin={isAdmin ? adminHandlers : undefined} />
                  ))}
                </div>
              )}
            </section>
          );
        })}

        {hiddenCount > 0 && (
          <div className="mt-[26px] flex justify-center">
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="rounded-full border border-[#C9A25E]/35 bg-[linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.02))] px-[22px] py-3 text-[14px] font-bold transition-colors hover:border-[#C9A25E]/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C9A25E]/50"
              style={{ color: INK }}
            >
              {t("updates.showEarlier", { count: hiddenCount })}
            </button>
          </div>
        )}
        {isAdmin && <p className="mt-3 text-center text-[11.5px] opacity-70" style={{ color: INK_3 }}>{t("updates.internalNote")}</p>}
      </div>

      {editing !== undefined && (
        <UpdateEditor
          entryId={editing}
          locale={lang}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            refetch();
          }}
        />
      )}
      {historyFor && <UpdateHistory entryId={historyFor} locale={lang} onClose={() => setHistoryFor(null)} />}
    </main>
  );
}
