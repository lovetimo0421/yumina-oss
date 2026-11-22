import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Check, Loader2, Pause, Play, Plus, Search, X } from "lucide-react";
import {
  TTS_VOICES, TTS_VOICE_POOL_MAX, isValidTtsVoice, readTtsCustomVoices, resolveTtsVoiceAlias, ttsCustomVoiceLabel,
  type WorkbenchPublicElement, type WorkbenchWork,
} from "@yumina/shared";
import { cn } from "@/lib/utils";
import { feedback } from "@/lib/feedback";
import { previewVoice } from "@/lib/tts-playback";
import { useAudioStore } from "@/stores/audio";
import { useUserProfileStore } from "@/stores/user-profile";
import { VoiceDesignPanel } from "./voice-design-panel";

const apiBase = import.meta.env.VITE_API_URL || "";

/**
 * One window for every sound a card uses.
 *
 * A character's voice, the narrator's, the card's music and its sound effects
 * were chosen in four different places that looked nothing alike: a list of
 * plain rows, the voice plaza's cards, big music tiles, small effect tiles,
 * and for the plaza a second window on top of the first. Here they are one
 * list with one kind of row (a face that plays it, a name, what it is, one
 * button), from two places: the author's own and the plaza.
 *
 * `kind: "voice"` picks a voice for one speaker. `kind: "audio"` adds music
 * and sound effects to the card, and keeps the ways to bring in a new file
 * (upload, generate, market) as buttons in its header.
 */
export type SoundPickerProps =
  | {
    kind: "voice";
    title: string;
    value?: string;
    onChange: (voice: string | undefined) => void;
    onClose: () => void;
    /** The narrator's window only: what the player's voice input does on release. */
    inputMode?: "confirm" | "auto";
    onInputModeChange?: (mode: "confirm" | "auto") => void;
  }
  | {
    kind: "audio";
    title: string;
    onAdd: (sound: { assetId: string; title: string; shelf: "music" | "sfx" }) => void;
    onClose: () => void;
    actions: { upload: () => void; generate: () => void; market?: () => void };
  };

interface Row {
  key: string;
  name: string;
  tags: string[];
  description?: string;
  coverUrl?: string | null;
  group?: string;
  lang?: string | null;
  /** How its face plays it. */
  sample: { voice: string; lang: string } | { url: string };
  /** A voice id (voice rows) or what "add" needs (audio rows). */
  voiceId?: string;
  plazaId?: string;
  assetId?: string;
}

const LANG_ORDER = ["zh", "en", "ja", "es"] as const;

/** A sound's face when it has no picture: five bars in its own colour, the same every time for the same sound. */
function Bars({ seed }: { seed: string }) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  const hue = (h >>> 0) % 360;
  const bars = Array.from({ length: 5 }, (_, i) => 28 + (((h >>> (i * 5)) & 31) / 31) * 62);
  return (
    <span className="flex h-full w-full items-center justify-center gap-[3px]" style={{ background: `hsl(${hue} 38% 17%)` }} aria-hidden="true">
      {bars.map((height, i) => <i key={i} className="w-[3px] rounded-full" style={{ height: `${height}%`, background: `hsl(${hue} 72% 70%)` }} />)}
    </span>
  );
}

export function SoundPicker(props: SoundPickerProps) {
  const { t, i18n } = useTranslation("editor");
  const { t: ts } = useTranslation("settings");
  const language = i18n.language || "en";
  const uiLang = language.slice(0, 2);
  const voiceMode = props.kind === "voice";
  const preferences = useUserProfileStore((s) => s.profile?.preferences);
  const forceFetchProfile = useUserProfileStore((s) => s.forceFetchProfile);

  const [shelf, setShelf] = useState<"music" | "sfx">("music");
  const [source, setSource] = useState<"mine" | "plaza">("mine");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [lang, setLang] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [added, setAdded] = useState<Record<string, boolean>>({});
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");

  useEffect(() => { const id = window.setTimeout(() => setQuery(q.trim()), 300); return () => window.clearTimeout(id); }, [q]);

  const savedCustom = useMemo(() => readTtsCustomVoices(preferences), [preferences]);
  const currentId = voiceMode && props.value ? resolveTtsVoiceAlias(props.value) : undefined;

  // ── what is listed ────────────────────────────────────────────
  useEffect(() => {
    const abort = new AbortController();
    const get = async <T,>(path: string): Promise<T> => {
      const res = await fetch(`${apiBase}${path}`, { credentials: "include", signal: abort.signal });
      if (!res.ok) throw new Error(String(res.status));
      return res.json() as Promise<T>;
    };
    const load = async (): Promise<Row[]> => {
      if (voiceMode && source === "mine") {
        // Mine first (what I designed, cloned or kept), then the curated ones every account has.
        const mine = await get<{ voices?: Array<{ name: string; voiceId: string; lang: string | null; coverUrl: string | null; description: string }> }>("/api/voice-design/mine")
          .then((d) => d.voices ?? []).catch(() => []);
        const seen = new Set<string>();
        const own: Row[] = [];
        for (const v of mine) {
          if (seen.has(v.voiceId)) continue;
          seen.add(v.voiceId);
          own.push({ key: v.voiceId, name: v.name, tags: v.lang ? [t(`voiceField.lang.${v.lang}` as never) as string] : [], description: v.description.replace(/^[🎙📎]\s*/u, ""), coverUrl: v.coverUrl, lang: v.lang, sample: { voice: v.voiceId, lang: v.lang ?? uiLang }, voiceId: v.voiceId, group: "mine" });
        }
        for (const v of savedCustom) {
          if (seen.has(v.id) || TTS_VOICES.some((p) => p.id === v.id)) continue;
          seen.add(v.id);
          own.push({ key: v.id, name: ttsCustomVoiceLabel(v), tags: [], sample: { voice: v.id, lang: uiLang }, voiceId: v.id, group: "mine" });
        }
        // The card may name a voice this author never kept (an imported card, a co-author's pick): it still has a row.
        if (currentId && !seen.has(currentId) && !TTS_VOICES.some((p) => p.id === currentId)) {
          own.unshift({ key: currentId, name: `${currentId.slice(0, 8)}…`, tags: [], sample: { voice: currentId, lang: uiLang }, voiceId: currentId, group: "mine" });
        }
        const order = [uiLang, ...LANG_ORDER.filter((l) => l !== uiLang)];
        const presets: Row[] = order.flatMap((l) => TTS_VOICES.filter((v) => v.lang === l).map((v) => ({
          key: v.id, name: ts(`display.tts.voices.${v.labelKey}` as never) as string,
          tags: [t(`voiceField.lang.${v.lang}` as never) as string, t(`voiceField.gender.${v.gender}` as never) as string],
          lang: v.lang, sample: { voice: v.id, lang: v.lang }, voiceId: v.id, group: "preset",
        })));
        const needle = query.toLowerCase();
        return [...own, ...presets].filter((r) => !needle || r.name.toLowerCase().includes(needle) || (r.description ?? "").toLowerCase().includes(needle));
      }
      if (voiceMode) {
        const params = new URLSearchParams({ scope: "public", kind: "voice", limit: "60", ui: language, ...(query ? { q: query } : {}) });
        const data = await get<{ elements?: WorkbenchPublicElement[] }>(`/api/workbench/elements?${params}`);
        return (data.elements ?? []).filter((e) => !!e.voiceId).map((e) => ({
          key: e.id, plazaId: e.isMine || e.used ? undefined : e.id, voiceId: e.voiceId!, name: e.translatedName ?? e.name,
          tags: [...(e.voiceLang ? [t(`voiceField.lang.${e.voiceLang}` as never) as string] : []), e.author.name || e.author.username || ""].filter(Boolean),
          description: (e.translatedDescription ?? e.description).replace(/^[🎙📎]\s*/u, ""), coverUrl: e.coverUrl, lang: e.voiceLang ?? null,
          sample: { voice: e.voiceId!, lang: e.voiceLang ?? uiLang },
        }));
      }
      if (source === "mine") {
        const params = new URLSearchParams({ type: "audio", sort: "newest", limit: "100", ...(query ? { search: query } : {}) });
        const data = await get<{ data?: Array<{ id: string; filename: string; url: string }> }>(`/api/user-assets?${params}`);
        return (data.data ?? []).map((a) => ({ key: a.id, assetId: a.id, name: a.filename.replace(/\.[^.]+$/, ""), tags: [], sample: { url: a.url } }));
      }
      const params = new URLSearchParams({ sort: "hot", ui: language, audio: shelf, ...(query ? { q: query } : {}) });
      const data = await get<{ works?: WorkbenchWork[] }>(`/api/workbench/works?${params}`);
      return (data.works ?? []).map((w) => ({
        key: w.id, plazaId: w.id, name: w.translatedTitle ?? w.title, tags: [w.author.name || w.author.username || ""].filter(Boolean),
        description: w.description, coverUrl: w.imageUrl || null, sample: { url: `${apiBase}${w.mediaUrl}` },
      }));
    };
    setRows(null);
    load().then((list) => { setFailed(false); setRows(list); })
      .catch((error) => { if ((error as { name?: string })?.name !== "AbortError") { setFailed(true); setRows([]); } });
    return () => abort.abort();
    // savedCustom changes when a voice is kept: the list then shows it.
  }, [voiceMode, source, shelf, query, language, uiLang, savedCustom, currentId, t, ts]);

  // ── listening ─────────────────────────────────────────────────
  const [playing, setPlaying] = useState<{ key: string; state: "loading" | "playing" } | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const stop = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    useAudioStore.getState().stopVoice();
    setPlaying(null);
  }, []);
  useEffect(() => stop, [stop]);
  const listen = (row: Row) => {
    if (playing?.key === row.key) { stop(); return; }
    stop();
    if ("voice" in row.sample) {
      setPlaying({ key: row.key, state: "loading" });
      void previewVoice(row.sample.voice, row.sample.lang, { purpose: "editor" }).finally(() => setPlaying((p) => (p?.key === row.key ? null : p)));
      return;
    }
    const el = new Audio(row.sample.url);
    audioRef.current = el;
    setPlaying({ key: row.key, state: "loading" });
    el.onplaying = () => setPlaying((p) => (p?.key === row.key ? { key: row.key, state: "playing" } : p));
    el.onended = el.onerror = () => { if (audioRef.current === el) { audioRef.current = null; setPlaying(null); } };
    void el.play().catch(() => { if (audioRef.current === el) { audioRef.current = null; setPlaying(null); } });
  };

  // ── choosing ──────────────────────────────────────────────────
  const choose = async (row: Row) => {
    if (busy) return;
    if (props.kind === "voice") {
      if (!row.voiceId) return;
      if (row.plazaId) {
        // The plaza's own Use: counts it for its maker and keeps it among my voices.
        setBusy(row.key);
        try {
          const res = await fetch(`${apiBase}/api/workbench/elements/${encodeURIComponent(row.plazaId)}/use`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: "{}" });
          if (res.ok) void forceFetchProfile().catch(() => {});
        } catch { /* It still reads on the card without being kept. */ } finally { setBusy(null); }
      }
      stop();
      props.onChange(row.voiceId);
      props.onClose();
      return;
    }
    let assetId = row.assetId;
    if (!assetId && row.plazaId) {
      // A plaza sound is copied into my own sounds first; the card then points at my copy.
      setBusy(row.key);
      try {
        const res = await fetch(`${apiBase}/api/workbench/works/${encodeURIComponent(row.plazaId)}/take`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: "{}" });
        const data = (await res.json().catch(() => ({}))) as { assetId?: string; code?: string };
        if (!res.ok || !data.assetId) { feedback.error(t(data.code === "STORAGE_QUOTA" ? "soundPicker.storageFull" : "soundPicker.addFailed")); return; }
        assetId = data.assetId;
      } catch { feedback.error(t("soundPicker.addFailed")); return; } finally { setBusy(null); }
    }
    if (!assetId) return;
    props.onAdd({ assetId, title: row.name, shelf });
    setAdded((m) => ({ ...m, [row.key]: true }));
  };

  const applyPasted = () => {
    if (props.kind !== "voice") return;
    const id = resolveTtsVoiceAlias(pasted.trim().toLowerCase());
    if (!id) return;
    if (!isValidTtsVoice(id)) { feedback.error(ts("display.tts.voice.invalidId")); return; }
    if (!TTS_VOICES.some((v) => v.id === id) && !savedCustom.some((v) => v.id === id)) {
      void fetch(`${apiBase}/api/users/me`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ preferences: { ttsCustomVoices: [...savedCustom, { id, name: "" }].slice(0, TTS_VOICE_POOL_MAX) } }),
      }).then((res) => (res.ok ? forceFetchProfile() : undefined)).catch(() => {});
    }
    props.onChange(id);
    props.onClose();
  };

  const langs = voiceMode ? LANG_ORDER.filter((l) => (rows ?? []).some((r) => r.lang === l)) : [];
  const shown = (rows ?? []).filter((r) => !lang || r.lang === lang);
  const currentName = currentId ? (rows ?? []).find((r) => r.voiceId === currentId)?.name
    ?? (TTS_VOICES.find((v) => v.id === currentId) ? ts(`display.tts.voices.${TTS_VOICES.find((v) => v.id === currentId)!.labelKey}` as never) as string : undefined)
    ?? savedCustom.find((v) => v.id === currentId)?.name ?? `${currentId.slice(0, 8)}…` : null;
  const chip = (on: boolean) => cn("h-7 shrink-0 rounded-full border px-3 text-xs transition-colors", on ? "border-amber-400/50 bg-amber-400/10 text-amber-300" : "border-white/[0.1] text-muted-foreground hover:text-foreground");
  const headBtn = "h-7 shrink-0 rounded-md border border-white/[0.1] px-2.5 text-xs text-muted-foreground transition-colors hover:border-amber-400/40 hover:text-foreground";

  return createPortal(
    <div className="fixed inset-0 z-[1200] flex items-end justify-center bg-black/55 sm:items-center sm:p-4" onClick={props.onClose} role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        data-sound-picker={props.kind}
        {...(voiceMode ? { "data-voice-picker": "" } : {})}
        onClick={(e) => e.stopPropagation()}
        className="flex h-[88dvh] w-full max-w-2xl flex-col rounded-t-2xl border border-white/[0.08] bg-[#181a24] text-foreground shadow-[0_24px_80px_rgba(0,0,0,0.6)] sm:h-[min(80vh,44rem)] sm:rounded-2xl"
      >
        <div className="flex items-center gap-2 px-4 pb-2 pt-3.5">
          <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold">{props.title}</h2>
          {props.kind === "audio" && (
            <>
              <button type="button" className={headBtn} onClick={() => { props.onClose(); props.actions.upload(); }} data-sound-picker-upload>{t("soundPicker.upload")}</button>
              <button type="button" className={headBtn} onClick={() => { props.onClose(); props.actions.generate(); }} data-sound-picker-generate>{t("soundPicker.generate")}</button>
              {props.actions.market && <button type="button" className={headBtn} onClick={() => { props.onClose(); props.actions.market!(); }} data-sound-picker-market>{t("soundPicker.market")}</button>}
            </>
          )}
          <button type="button" onClick={props.onClose} aria-label={t("voiceField.close")} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"><X className="h-4 w-4" /></button>
        </div>

        {voiceMode && (
          <div className="mx-4 mb-2 flex items-center gap-2 rounded-lg bg-white/[0.04] px-3 py-2 text-sm" data-sound-picker-current>
            <span className="shrink-0 text-xs text-muted-foreground">{t("soundPicker.current")}</span>
            <span className="min-w-0 flex-1 truncate">{currentName ?? t("voiceField.follow")}</span>
            {currentId && (
              <button type="button" data-voice-option="" onClick={() => { props.onChange(undefined); props.onClose(); }} className="shrink-0 text-xs text-amber-300 hover:underline">{t("soundPicker.giveBack")}</button>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 px-4 pb-2">
          {!voiceMode && (["music", "sfx"] as const).map((k) => (
            <button key={k} type="button" aria-pressed={shelf === k} className={chip(shelf === k)} onClick={() => setShelf(k)} data-sound-picker-shelf={k}>{t(`soundPicker.${k}`)}</button>
          ))}
          {!voiceMode && <span className="mx-0.5 h-4 w-px bg-white/[0.1]" aria-hidden="true" />}
          {(["mine", "plaza"] as const).map((k) => (
            <button key={k} type="button" aria-pressed={source === k} className={chip(source === k)} onClick={() => { setSource(k); setLang(null); }} data-sound-picker-source={k}>{t(`soundPicker.${k}`)}</button>
          ))}
          <label className="flex h-7 min-w-[8rem] flex-1 items-center gap-1.5 rounded-full border border-white/[0.1] px-2.5 focus-within:border-amber-400/40">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("soundPicker.search")} aria-label={t("soundPicker.search")} maxLength={40}
              className="h-full min-w-0 flex-1 bg-transparent text-xs placeholder:text-muted-foreground/50 focus:outline-none" data-sound-picker-search />
          </label>
        </div>
        {langs.length > 1 && (
          <div className="flex gap-1.5 overflow-x-auto px-4 pb-2" data-sound-picker-langs>
            <button type="button" aria-pressed={lang === null} className={chip(lang === null)} onClick={() => setLang(null)}>{t("soundPicker.anyLang")}</button>
            {langs.map((l) => <button key={l} type="button" aria-pressed={lang === l} className={chip(lang === l)} onClick={() => setLang(l)}>{t(`voiceField.lang.${l}` as never)}</button>)}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-white/[0.07] px-2 py-2">
          {voiceMode && source === "mine" && !query && (
            <>
              <VoiceDesignPanel onPick={(id) => { props.onChange(id); props.onClose(); }} />
              {pasting ? (
                <div className="flex items-center gap-1.5 px-2 py-1.5">
                  <input type="text" autoFocus value={pasted} onChange={(e) => setPasted(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") applyPasted(); }}
                    placeholder={ts("display.tts.voice.customPlaceholder")} spellCheck={false}
                    className="h-8 min-w-0 flex-1 rounded-md border border-white/[0.1] bg-white/[0.03] px-2.5 font-mono text-xs placeholder:text-muted-foreground/50 focus:border-amber-400/40 focus:outline-none" />
                  <button type="button" onClick={applyPasted} disabled={!pasted.trim()} className="h-8 shrink-0 rounded-md border border-white/[0.1] px-2.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40">{t("voiceField.useCustom")}</button>
                </div>
              ) : null}
            </>
          )}
          {rows === null && <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>}
          {rows !== null && shown.length === 0 && <p className="px-3 py-10 text-center text-sm text-muted-foreground">{t(failed ? "soundPicker.failed" : "soundPicker.empty")}</p>}
          {shown.map((row, index) => {
            const selected = voiceMode && !!currentId && row.voiceId === currentId;
            const state = playing?.key === row.key ? playing.state : null;
            const done = !voiceMode && added[row.key];
            const heading = voiceMode && source === "mine" && row.group === "preset" && shown[index - 1]?.group !== "preset";
            return (
              <div key={row.key}>
                {heading && <h3 className="px-2 pb-1 pt-3 text-[11px] font-medium text-muted-foreground">{t("soundPicker.presets")}</h3>}
                <div className={cn("flex items-center gap-3 rounded-xl px-2 py-1.5 transition-colors hover:bg-white/[0.04]", selected && "bg-amber-400/10 hover:bg-amber-400/10")} data-sound-row={row.key}>
                  <button type="button" onClick={() => listen(row)} aria-label={t("voiceField.preview")} title={t("voiceField.preview")}
                    className="relative h-11 w-11 shrink-0 overflow-hidden rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400" data-sound-row-play>
                    {row.coverUrl ? <img src={row.coverUrl} alt="" loading="lazy" className="h-full w-full object-cover" /> : <Bars seed={row.voiceId ?? row.key} />}
                    <span className={cn("absolute inset-0 flex items-center justify-center bg-black/35 text-white transition-opacity", state ? "opacity-100" : "opacity-0 hover:opacity-100 focus-visible:opacity-100")}>
                      {state === "loading" ? <Loader2 className="h-4 w-4 animate-spin" /> : state === "playing" ? <Pause className="h-4 w-4" fill="currentColor" /> : <Play className="h-4 w-4" fill="currentColor" />}
                    </span>
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-baseline gap-2">
                      <span className="truncate text-sm">{row.name}</span>
                      {row.tags.length > 0 && <span className="shrink-0 truncate text-[11px] text-muted-foreground">{row.tags.join(" · ")}</span>}
                    </div>
                    {row.description && <p className="truncate text-xs text-muted-foreground">{row.description}</p>}
                  </div>
                  <button type="button" onClick={() => void choose(row)} disabled={busy !== null || selected || done}
                    {...(voiceMode ? { "data-voice-option": row.voiceId } : {})} data-sound-row-choose
                    className={cn("flex h-8 shrink-0 items-center gap-1 rounded-full border px-3 text-xs transition-colors",
                      selected || done ? "border-transparent text-amber-300" : "border-white/[0.14] text-foreground hover:border-amber-400/50 hover:bg-amber-400/10 disabled:opacity-50")}>
                    {busy === row.key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : selected || done ? <Check className="h-3.5 w-3.5" /> : !voiceMode ? <Plus className="h-3.5 w-3.5" /> : null}
                    {t(selected ? "soundPicker.inUse" : done ? "soundPicker.added" : voiceMode ? "soundPicker.use" : "soundPicker.add")}
                  </button>
                </div>
              </div>
            );
          })}
          {voiceMode && source === "mine" && !query && !pasting && rows !== null && (
            <button type="button" onClick={() => setPasting(true)} className="mx-2 mt-2 text-[11px] text-muted-foreground hover:text-foreground" data-sound-picker-paste>{t("soundPicker.pasteId")}</button>
          )}
        </div>

        {props.kind === "voice" && props.onInputModeChange && (
          <div className="flex items-center justify-between gap-3 border-t border-white/[0.07] px-4 py-2.5">
            <div className="min-w-0 text-sm">{t("voiceField.inputTitle")}</div>
            <div className="flex shrink-0 gap-1" role="group" aria-label={t("voiceField.inputTitle")}>
              {(["confirm", "auto"] as const).map((m) => (
                <button key={m} type="button" aria-pressed={(props.inputMode ?? "confirm") === m} onClick={() => props.onInputModeChange!(m)} className={chip((props.inputMode ?? "confirm") === m)}>
                  {t(m === "auto" ? "voiceField.inputAuto" : "voiceField.inputConfirm")}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
