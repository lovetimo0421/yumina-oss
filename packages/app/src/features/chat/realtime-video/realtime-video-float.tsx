/**
 * Floating realtime-video player: available on every card, never reflows the card. The player
 * opens it from the host menu or a small launcher, drags and resizes it (docked to the top on phones), and picks
 * every setting: engine, look, director model, first frame, pacing. Toolbar: start/stop, new take,
 * rewrite the shot, sound, scene list (intercut A → B → A), process log.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Clapperboard, Film, Minus, Pencil, RotateCcw, ScrollText, Settings2, Square, Volume2, VolumeX, X, Play, Layers } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useUserProfileStore } from "@/stores/user-profile";
import { DEFAULT_ENGINE, DIRECTOR_MODELS, FILM_SETTINGS_KEY, getVideoController, type VideoEngine, type VideoStartOptions, type VideoStep } from "./controller";

type Rect = { x: number; y: number; w: number; h: number };
type Panel = "none" | "settings" | "log" | "scenes" | "edit";
type Settings = Required<Pick<VideoStartOptions, "engine" | "style" | "directorModel" | "firstFrame" | "openingBeats" | "idleSeconds" | "limitSeconds">>;

const RECT_KEY = "yumina:rtv-float-rect";
const SETTINGS_KEY = FILM_SETTINGS_KEY;
const DEFAULT_SETTINGS: Settings = {
  engine: DEFAULT_ENGINE, style: "source", directorModel: DIRECTOR_MODELS[0].id, firstFrame: "none", openingBeats: 5, idleSeconds: 120, limitSeconds: 600,
};

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function defaultRect(): Rect {
  const w = Math.min(520, window.innerWidth - 32);
  const h = Math.round(w * 9 / 16) + 44;
  return { x: window.innerWidth - w - 24, y: window.innerHeight - h - 110, w, h };
}

export interface RealtimeVideoOpenRequest {
  sessionId: string;
  nonce: number;
}

export function RealtimeVideoFloat({ sessionId, defaultOpen = false, suppressIdleLauncher = false, openRequest }: {
  sessionId: string;
  defaultOpen?: boolean;
  /** Authored roots expose idle access through the host More menu. */
  suppressIdleLauncher?: boolean;
  openRequest?: RealtimeVideoOpenRequest | null;
}) {
  const { t } = useTranslation("chat");
  // Scene video is experimental: nothing shows unless this server offers it.
  const offered = useUserProfileStore((s) => s.profile?.filmOffered === true);
  const isAdmin = useUserProfileStore((s) => s.profile?.role === "admin");
  const controller = getVideoController(sessionId);
  const state = useSyncExternalStore((cb) => controller.subscribe(cb), () => controller.getState());
  const mobile = useMediaQuery("(max-width: 767px)");
  const [open, setOpen] = useState(defaultOpen);
  const [handledOpenRequest, setHandledOpenRequest] = useState<RealtimeVideoOpenRequest | null>(null);
  const [mini, setMini] = useState(false);
  const [panel, setPanel] = useState<Panel>("none");
  const [rect, setRect] = useState<Rect>(() => load(RECT_KEY, defaultRect()));
  const [mobileH, setMobileH] = useState(() => Math.round(Math.min(window.innerWidth, 767) * 9 / 16) + 44);
  const [settings, setSettings] = useState<Settings>(() => load(SETTINGS_KEY, DEFAULT_SETTINGS));
  const [uploaded, setUploaded] = useState<string>("");
  const [muted, setMuted] = useState(true);
  const [draft, setDraft] = useState("");
  const [flash, setFlash] = useState<{ text: string; at: number } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const running = state.status === "live" || state.status === "starting";
  // Consume each menu command once; unrelated renders must not reopen a closed panel.
  if (openRequest?.sessionId === sessionId && (
    openRequest.nonce !== handledOpenRequest?.nonce || openRequest.sessionId !== handledOpenRequest?.sessionId
  )) {
    setHandledOpenRequest(openRequest);
    setOpen(true);
    setMini(false);
  }
  // A card started the film before the player turned it on: the question needs the window,
  // which closes again once answered if it was opened only to ask.
  const [openedToAsk, setOpenedToAsk] = useState(false);
  if (state.consent && (!open || mini)) {
    setOpenedToAsk(!open);
    setOpen(true);
    setMini(false);
  }
  if (!state.consent && openedToAsk) {
    setOpenedToAsk(false);
    setOpen(false);
  }

  useEffect(() => { save(SETTINGS_KEY, settings); }, [settings]);
  useEffect(() => { save(RECT_KEY, rect); }, [rect]);

  // The video lives in this window while it is open.
  useEffect(() => {
    const el = stageRef.current;
    if (!open || !el) return;
    controller.attach(el);
    return () => controller.detach(el);
  }, [open, mini, controller]);

  // Transition card on every cut.
  useEffect(() => {
    if (!state.cut) return;
    setFlash({ text: state.cut.kind === "return" ? t("film.cutBack", { scene: state.cut.scene }) : `→ ${state.cut.scene}`, at: state.cut.at });
    const timer = setTimeout(() => setFlash(null), 2200);
    return () => clearTimeout(timer);
  }, [state.cut, t]);

  useEffect(() => { if (panel === "log") logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [state.steps, panel]);

  // Drag / resize (desktop).
  const drag = useCallback((e: React.PointerEvent, mode: "move" | "resize") => {
    if (mobile) return;
    e.preventDefault();
    const start = { px: e.clientX, py: e.clientY, ...rect };
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - start.px, dy = ev.clientY - start.py;
      setRect(mode === "move"
        ? { ...start, x: clamp(start.x + dx, 0, window.innerWidth - 120), y: clamp(start.y + dy, 0, window.innerHeight - 44) }
        : { ...start, w: clamp(start.w + dx, 280, window.innerWidth - start.x), h: clamp(start.h + dy, 200, window.innerHeight - start.y) });
    };
    const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [rect, mobile]);

  // Phone: drag the bottom edge to change the docked height.
  const dragMobile = useCallback((e: React.PointerEvent) => {
    const startY = e.clientY, startH = mobileH;
    const onMove = (ev: PointerEvent) => setMobileH(clamp(startH + ev.clientY - startY, 160, window.innerHeight * 0.8));
    const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [mobileH]);

  const start = () => {
    setPanel("none");
    void controller.start({ ...settings, uploadedFrame: settings.firstFrame === "upload" ? uploaded : "" });
  };
  const togglePanel = (p: Panel) => setPanel((cur) => (cur === p ? "none" : p));
  const errorText = (e?: string) => e === "INSUFFICIENT_CREDITS" ? t("film.noCredits")
    : e === "FILM_OPT_IN_REQUIRED" ? t("film.notEnabled")
    : e === "FILM_UNAVAILABLE" ? t("film.unavailable")
    : t("film.failed", { error: e ?? "" });

  if (!offered) return null;
  if (!open) {
    if (suppressIdleLauncher && !running) return null;
    return (
      <button
        type="button"
        onClick={() => { setOpen(true); setMini(false); }}
        className="fixed z-[60] flex items-center gap-1.5 rounded-full border border-white/15 bg-black/75 px-3 py-2 text-xs text-white shadow-lg backdrop-blur hover:bg-black/90"
        style={mobile ? { right: 10, top: 64 } : { right: 20, bottom: 96 }}
        title={t("film.launcherTitle")}
      >
        <Clapperboard className="h-4 w-4" />
        {running ? <span className="tabular-nums text-rose-300">● {Math.floor(state.elapsed)}s</span> : t("film.name")}
      </button>
    );
  }

  const frame = mobile
    ? { left: 0, top: 0, width: "100vw", height: mini ? 44 : mobileH }
    : { left: rect.x, top: rect.y, width: rect.w, height: mini ? 44 : rect.h };

  return (
    <div className="fixed z-[60] flex flex-col overflow-hidden rounded-lg border border-white/15 bg-neutral-950 text-[13px] text-white shadow-2xl" style={{ ...frame, borderRadius: mobile ? 0 : 10 }}>
      {/* Title bar: drag handle */}
      <div className="flex h-11 shrink-0 cursor-move select-none items-center gap-2 border-b border-white/10 bg-neutral-900 px-2" onPointerDown={(e) => drag(e, "move")}>
        <Film className="h-4 w-4 text-white/60" />
        <span className={`text-xs tabular-nums ${running ? "text-rose-300" : "text-white/50"}`}>{state.status === "starting" ? t("film.statusStarting") : running ? t("film.statusLive") : t("film.statusIdle")}</span>
        {running && <span className="text-xs tabular-nums text-white/70">{Math.floor(state.elapsed / 60)}:{String(Math.floor(state.elapsed % 60)).padStart(2, "0")}</span>}
        {(running || state.credits > 0) && <span className="text-xs tabular-nums text-amber-300">{t("film.credits", { n: Math.round(state.credits) })}</span>}
        {state.currentScene && <span className="truncate rounded bg-white/10 px-1.5 text-[11px] text-white/70">{state.currentScene}</span>}
        <div className="flex-1" />
        <IconBtn title={t("film.minimize")} onClick={() => setMini((m) => !m)}><Minus className="h-4 w-4" /></IconBtn>
        <IconBtn title={t("film.closeWindow")} onClick={() => { if (state.consent) void controller.answerConsent(false); setOpen(false); }}><X className="h-4 w-4" /></IconBtn>
      </div>

      {!mini && (
        <>
          <div ref={stageRef} className="relative min-h-0 flex-1 bg-black [&>video]:!object-contain">
            {state.consent ? (
              <div className="absolute inset-0 z-[4] flex flex-col items-center justify-center gap-3 overflow-y-auto bg-neutral-950 px-5 py-4 text-center">
                <div className="text-sm font-semibold text-white">{t("film.consentTitle")}</div>
                <p className="max-w-md text-xs leading-relaxed text-white/70">{t("film.consentBody")}</p>
                <div className="flex gap-2">
                  <button type="button" onClick={() => void controller.answerConsent(true)} className="flex items-center gap-1.5 rounded bg-rose-600 px-4 py-1.5 text-white hover:bg-rose-500"><Play className="h-4 w-4" />{t("film.consentAccept")}</button>
                  <button type="button" onClick={() => void controller.answerConsent(false)} className="rounded border border-white/20 px-3 py-1.5 text-white/80 hover:bg-white/10">{t("film.consentDecline")}</button>
                </div>
              </div>
            ) : !running && (
              <div className="absolute inset-0 z-[1] flex flex-col items-center justify-center gap-3 px-4 text-center text-white/80">
                <div className="text-sm">{state.status === "error" ? errorText(state.error) : state.status === "ended" ? t("film.ended") : t("film.intro")}</div>
                <div className="flex gap-2">
                  <button type="button" onClick={start} className="flex items-center gap-1.5 rounded bg-rose-600 px-4 py-1.5 text-white hover:bg-rose-500"><Play className="h-4 w-4" />{t("film.start")}</button>
                  <button type="button" onClick={() => togglePanel("settings")} className="flex items-center gap-1.5 rounded border border-white/20 px-3 py-1.5 hover:bg-white/10"><Settings2 className="h-4 w-4" />{t("film.settings")}</button>
                </div>
                <div className="text-[11px] text-white/45">{engineLabel(t, settings.engine)} · {styleLabel(t, settings.style)}</div>
              </div>
            )}
            {running && state.engine !== "fal" && state.waiting && <div className="absolute bottom-2 left-2 z-[1] rounded bg-black/60 px-2 py-0.5 text-xs">{t("film.nextClip")}</div>}
            {flash && <div key={flash.at} className="pointer-events-none absolute inset-0 z-[2] flex items-end justify-start bg-black/0 p-3 animate-[rtvcut_2.2s_ease-out_forwards]"><span className="rounded bg-black/70 px-2 py-1 text-sm">{flash.text}</span></div>}
            <style>{"@keyframes rtvcut{0%{background:rgba(0,0,0,.9)}25%{background:rgba(0,0,0,0)}85%{opacity:1}100%{opacity:0}}"}</style>
          </div>

          {/* Toolbar */}
          <div className="flex h-10 shrink-0 items-center gap-0.5 border-t border-white/10 bg-neutral-900 px-1.5">
            {running
              ? <IconBtn title={t("film.stop")} onClick={() => controller.stop()}><Square className="h-4 w-4" /></IconBtn>
              : <IconBtn title={t("film.start")} onClick={start}><Play className="h-4 w-4" /></IconBtn>}
            <IconBtn title={t("film.retake")} disabled={!running || !controller.lastShot} onClick={() => controller.regenerate()}><RotateCcw className="h-4 w-4" /></IconBtn>
            <IconBtn title={t("film.rewrite")} disabled={!running} active={panel === "edit"} onClick={() => { setDraft(controller.lastShot); togglePanel("edit"); }}><Pencil className="h-4 w-4" /></IconBtn>
            <IconBtn title={muted ? t("film.soundOn") : t("film.soundOff")} onClick={() => { setMuted(!muted); controller.setMuted(!muted); }}>{muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}</IconBtn>
            <IconBtn title={t("film.scenes")} active={panel === "scenes"} onClick={() => togglePanel("scenes")}><Layers className="h-4 w-4" /></IconBtn>
            <div className="min-w-0 flex-1 truncate px-1 text-[11px] text-white/50">{isAdmin && state.currentStatus && running ? state.currentStatus : ""}</div>
            {isAdmin && <IconBtn title={t("film.log")} active={panel === "log"} onClick={() => togglePanel("log")}><ScrollText className="h-4 w-4" /></IconBtn>}
            <IconBtn title={t("film.settings")} active={panel === "settings"} onClick={() => togglePanel("settings")}><Settings2 className="h-4 w-4" /></IconBtn>
          </div>

          {panel !== "none" && (
            <div ref={panel === "log" ? logRef : undefined} className="max-h-[45%] shrink-0 overflow-y-auto border-t border-white/10 bg-neutral-950 p-2.5">
              {panel === "settings" && <SettingsForm value={settings} onChange={setSettings} running={running} uploaded={uploaded} onUpload={setUploaded} />}
              {panel === "edit" && (
                <div className="grid gap-2">
                  <div className="text-[11px] text-white/50">{t("film.rewriteHint")}</div>
                  <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={4} className="w-full resize-y rounded border border-white/15 bg-white/5 p-2 text-xs" />
                  <div className="flex gap-2">
                    <button type="button" onClick={() => { controller.direct(draft); setPanel("none"); }} className="rounded bg-rose-600 px-3 py-1 text-xs">{t("film.send")}</button>
                    <button type="button" onClick={() => setPanel("none")} className="rounded border border-white/15 px-3 py-1 text-xs">{t("film.cancel")}</button>
                  </div>
                </div>
              )}
              {panel === "scenes" && (
                <div className="grid gap-2">
                  <div className="text-[11px] text-white/50">{t("film.scenesHint")}</div>
                  {state.scenes.length === 0 && <div className="text-xs text-white/40">{t("film.scenesEmpty")}</div>}
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {state.scenes.map((sc) => (
                      <button key={sc.id} type="button" disabled={!running} onClick={() => controller.cutTo(sc.id)} title={sc.sheet}
                        className={`overflow-hidden rounded border text-left ${sc.id === state.currentScene ? "border-rose-400" : "border-white/15 hover:border-white/40"}`}>
                        <div className="aspect-video bg-white/5">{sc.thumb && <img src={sc.thumb} alt="" className="h-full w-full object-cover" />}</div>
                        <div className="p-1.5"><div className="text-xs font-medium">{sc.id}{sc.id === state.currentScene ? ` · ${t("film.current")}` : ""}</div><div className="line-clamp-2 text-[10px] text-white/50">{sc.sheet}</div></div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {panel === "log" && isAdmin && state.steps.map((s) => <StepRow key={s.id} s={s} />)}
            </div>
          )}

          {mobile
            ? <div className="h-3 shrink-0 cursor-ns-resize touch-none bg-neutral-900" onPointerDown={dragMobile}><div className="mx-auto mt-1 h-1 w-10 rounded bg-white/30" /></div>
            : <div className="absolute bottom-0 right-0 z-[3] h-4 w-4 cursor-nwse-resize" onPointerDown={(e) => drag(e, "resize")} style={{ background: "linear-gradient(135deg,transparent 50%,rgba(255,255,255,.35) 50%)" }} />}
        </>
      )}
    </div>
  );
}

function IconBtn({ title, onClick, disabled, active, children }: { title: string; onClick: () => void; disabled?: boolean; active?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" title={title} aria-label={title} disabled={disabled} onPointerDown={(e) => e.stopPropagation()} onClick={onClick}
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded hover:bg-white/10 disabled:opacity-30 ${active ? "bg-white/15" : ""}`}>
      {children}
    </button>
  );
}

function engineLabel(t: TFunction<"chat">, engine: VideoEngine): string {
  return engine === "fal" ? t("film.engineFal") : engine === "comfy-h3" ? t("film.engineComfy") : t("film.engineCausal");
}
const STYLE_KEYS: Record<string, string> = { source: "film.styleSource", live: "film.styleLive", anime: "film.styleAnime", painted: "film.stylePainted" };
function styleLabel(t: TFunction<"chat">, style: string): string {
  return STYLE_KEYS[style] ? String(t(STYLE_KEYS[style] as "film.styleSource")) : style;
}

function SettingsForm({ value, onChange, running, uploaded, onUpload }: { value: Settings; onChange: (s: Settings) => void; running: boolean; uploaded: string; onUpload: (d: string) => void }) {
  const { t } = useTranslation("chat");
  const falOffered = useUserProfileStore((s) => s.profile?.filmFalOffered === true);
  const isAdmin = useUserProfileStore((s) => s.profile?.role === "admin");
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => onChange({ ...value, [k]: v });
  const field = "grid gap-1";
  const input = "w-full rounded border border-white/15 bg-white/5 px-2 py-1 text-xs";
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {running && <div className="text-[11px] text-amber-300 sm:col-span-2">{t("film.changesNextTime")}</div>}
      <label className={field}><span className="text-[11px] text-white/50">{t("film.engine")}</span>
        <select className={input} value={value.engine} onChange={(e) => set("engine", e.target.value as VideoEngine)}>
          {falOffered && <option value="fal">{engineLabel(t, "fal")}</option>}
          {isAdmin && <option value="comfy-h3">{engineLabel(t, "comfy-h3")}</option>}
          {isAdmin && <option value="comfy-causal">{engineLabel(t, "comfy-causal")}</option>}
        </select></label>
      <label className={field}><span className="text-[11px] text-white/50">{t("film.style")}</span>
        <select className={input} value={value.style} onChange={(e) => set("style", e.target.value)}>
          {Object.keys(STYLE_KEYS).map((k) => <option key={k} value={k}>{styleLabel(t, k)}</option>)}
        </select></label>
      <label className={field}><span className="text-[11px] text-white/50">{t("film.director")}</span>
        <select className={input} value={value.directorModel} onChange={(e) => set("directorModel", e.target.value)}>
          {DIRECTOR_MODELS.map((m, i) => <option key={m.id} value={m.id}>{i === 0 ? `${m.label} (${t("film.defaultTag")})` : m.label}</option>)}
        </select></label>
      <label className={field}><span className="text-[11px] text-white/50">{t("film.firstFrame")}</span>
        <select className={input} value={value.firstFrame} onChange={(e) => set("firstFrame", e.target.value as Settings["firstFrame"])}>
          <option value="none">{t("film.firstFrameNone")}</option>
          <option value="cover">{t("film.firstFrameCover")}</option>
          <option value="upload">{t("film.firstFrameUpload")}</option>
        </select></label>
      {value.firstFrame === "upload" && (
        <label className={`${field} sm:col-span-2`}><span className="text-[11px] text-white/50">{t("film.upload")}</span>
          <input type="file" accept="image/*" className="text-xs" onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            const bmp = await createImageBitmap(f);
            const scale = Math.min(1, 1280 / bmp.width);
            const c = document.createElement("canvas");
            c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
            c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
            onUpload(c.toDataURL("image/jpeg", 0.9));
          }} />
          {uploaded && <img src={uploaded} alt="" className="mt-1 h-16 w-auto rounded" />}
        </label>
      )}
      <label className={field}><span className="text-[11px] text-white/50">{t("film.openingBeats")}</span>
        <input type="number" min={3} max={10} className={input} value={value.openingBeats} onChange={(e) => set("openingBeats", clamp(Number(e.target.value) || 5, 3, 10))} /></label>
      <label className={field}><span className="text-[11px] text-white/50">{t("film.idleSeconds")}</span>
        <input type="number" min={30} max={1800} className={input} value={value.idleSeconds} onChange={(e) => set("idleSeconds", clamp(Number(e.target.value) || 120, 30, 1800))} /></label>
      <label className={field}><span className="text-[11px] text-white/50">{t("film.limitSeconds")}</span>
        <input type="number" min={60} max={3600} className={input} value={value.limitSeconds} onChange={(e) => set("limitSeconds", clamp(Number(e.target.value) || 600, 60, 3600))} /></label>
      <button type="button" className="justify-self-start rounded border border-white/15 px-2 py-1 text-[11px] text-white/60 sm:col-span-2" onClick={() => onChange(DEFAULT_SETTINGS)}>{t("film.reset")}</button>
    </div>
  );
}

function StepRow({ s }: { s: VideoStep }) {
  return (
    <div className="mb-2 leading-snug">
      <span className="mr-1.5 text-[11px] tabular-nums text-white/40">{s.t.toFixed(1)}s</span>
      <span className={KIND_CLASS[s.kind]}>{KIND_LABEL[s.kind]}</span>{" "}
      <span>{s.text}</span>
      {s.version != null && (
        <span className={`ml-1.5 rounded px-1 text-[11px] ${s.status?.startsWith("画面") ? "bg-emerald-900/70 text-emerald-300" : s.status?.startsWith("被拒") || s.status?.startsWith("失败") ? "bg-red-900/70 text-red-300" : "bg-white/10 text-white/60"}`}>v{s.version} {s.status}</span>
      )}
      {s.shot && <details className="mt-0.5 text-[11px] text-white/45"><summary className="cursor-pointer">镜头指令</summary>{s.shot}</details>}
    </div>
  );
}
const KIND_LABEL: Record<VideoStep["kind"], string> = { opening: "开场镜头", user: "玩家", reply: "AI 回复", shot: "新镜头", info: "·", error: "错误" };
const KIND_CLASS: Record<VideoStep["kind"], string> = { opening: "text-sky-300", user: "text-pink-300", reply: "text-amber-200", shot: "text-sky-300", info: "text-white/50", error: "text-red-400" };
