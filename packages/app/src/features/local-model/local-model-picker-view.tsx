import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import { BookOpen, Check, Cpu, Download, Globe, HardDrive, Laptop, Link2, Loader2, MonitorSmartphone, Package, RefreshCw, Sparkles, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useModelsStore } from "@/stores/models";
import { useLocalModelStore } from "./store";
import { isLocalModelId } from "./enabled-flag";
import { LocalModelDiagnosis } from "./local-model-status";
import { requestGuideOpen } from "./local-model-guide";

/**
 * A phone can't run a model itself: no suitable GPU, and a phone browser
 * can't reach an app on the phone anyway. It can still play on a model that
 * runs on the player's computer, which is why the picker explains that case
 * instead of offering setup.
 */
export function isLikelyPhone(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** Models we've played cards on, and what to tell a player about each. */
const KNOWN_MODELS: Record<string, { tag: "best" | "recommended" | "light"; chip: string; dot: string }> = {
  "qwen3.8:27b": { tag: "best", chip: "bg-amber-400/10 text-amber-300", dot: "bg-amber-400" },
  "qwen3.5:9b": { tag: "recommended", chip: "bg-emerald-400/10 text-emerald-300", dot: "bg-emerald-400" },
  "qwen3.5:4b": { tag: "light", chip: "bg-sky-400/10 text-sky-300", dot: "bg-sky-400" },
};

const KNOWN_ORDER = ["recommended", "best", "light"] as const;

/** Tested models first, recommended at the top; the rest keep the runtime's order. */
function sortLocalModels<T extends { id: string }>(models: T[]): T[] {
  const rank = (m: T) => {
    const known = KNOWN_MODELS[m.id.slice("local/".length)];
    return known ? KNOWN_ORDER.indexOf(known.tag) : KNOWN_ORDER.length;
  };
  return [...models].sort((a, b) => rank(a) - rank(b));
}

type Step = 1 | 2 | 3;

/**
 * The model picker's "This computer" source: a status banner with the same
 * diagnosis the AI-settings panel shows, the path to getting connected, and
 * the models the player's own machine offers — styled to sit beside the
 * official tiers rather than as a grey form.
 */
export function LocalModelPickerView({ selectedModel, onSelect, onClose, providerSwitch }: {
  selectedModel: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  providerSwitch: ReactNode;
}) {
  const { t } = useTranslation(["profile", "chat"]);
  const navigate = useNavigate();
  const { enabled, status, detecting, detection, detect, enable } = useLocalModelStore();
  const localModels = useModelsStore((s) => s.localModels);
  const [busy, setBusy] = useState(false);
  const k = (key: string, opts?: Record<string, unknown>) => t(`localModel.picker.${key}` as never, opts as never) as unknown as string;

  const openGuide = () => {
    requestGuideOpen();
    onClose();
    void navigate({ to: "/app/settings", hash: "ai-config" });
  };
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  const phone = isLikelyPhone();
  const live = enabled && (status === "connected" || status === "running");
  const runtimeLabel = detection?.status === "ready" || detection?.status === "blocked" ? detection.runtime.label : "Ollama";

  // The status pill in the banner.
  const pill = phone
    // A phone never connects anything itself; the model runs on its computer.
    ? { dot: "bg-emerald-400", text: "text-emerald-200", ring: "border-emerald-400/30 bg-emerald-400/10", label: k("pillOnComputer") }
    : live
    ? { dot: "bg-emerald-400", text: "text-emerald-200", ring: "border-emerald-400/30 bg-emerald-400/10", label: k("pillConnected", { runtime: runtimeLabel }) }
    : enabled && status === "error"
      ? { dot: "bg-red-400", text: "text-red-200", ring: "border-red-400/30 bg-red-400/10", label: k("pillOffline") }
      : enabled || detecting
        ? { dot: "bg-amber-400 animate-pulse", text: "text-amber-200", ring: "border-amber-400/30 bg-amber-400/10", label: k("pillConnecting") }
        : { dot: "bg-white/40", text: "text-white/70", ring: "border-white/15 bg-white/[0.06]", label: k("pillNotConnected") };

  // Where the player is on the way to connected.
  const step: Step = !detection || detection.status === "none"
    ? 1
    : detection.status === "ready" && detection.models.length === 0
      ? 2
      : 3;
  const steps: Array<{ n: Step; icon: ReactNode; title: string; hint: string; tint: string }> = [
    { n: 1, icon: <Download className="h-4 w-4" />, title: k("step1"), hint: k("step1Hint"), tint: "text-emerald-300 bg-emerald-400/10 border-emerald-400/25" },
    { n: 2, icon: <Package className="h-4 w-4" />, title: k("step2"), hint: k("step2Hint"), tint: "text-sky-300 bg-sky-400/10 border-sky-400/25" },
    { n: 3, icon: <Link2 className="h-4 w-4" />, title: k("step3"), hint: k("step3Hint"), tint: "text-violet-300 bg-violet-400/10 border-violet-400/25" },
  ];

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 px-[17px] pb-3 pt-4 max-[390px]:gap-1.5 max-[390px]:px-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[11px] bg-gold/10 text-gold max-[390px]:h-7 max-[390px]:w-6"><Sparkles aria-hidden="true" className="h-4 w-4" /></span>
        <h2 className="mr-auto min-w-0 truncate text-base font-semibold text-white max-[390px]:text-sm">{t("modelBrowser.compactTitle", { ns: "chat" })}</h2>
        {providerSwitch}
        <button type="button" onClick={onClose} aria-label={t("modelBrowser.closePicker", { ns: "chat" })} className="flex h-8 w-7 shrink-0 items-center justify-center rounded-lg text-white/55 hover:bg-white/5 hover:text-white [@media(pointer:coarse)]:h-11"><X className="h-4 w-4" /></button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-3 pb-3 max-[390px]:px-2">
        {/* Banner: what this source is, and whether it's working. */}
        <div className="relative overflow-hidden rounded-[18px] border border-emerald-400/20 bg-[#18211f] p-4">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_90%_at_0%_0%,rgba(16,185,129,0.28),transparent_60%),radial-gradient(90%_80%_at_100%_100%,rgba(56,189,248,0.16),transparent_60%)]" />
          <div className="relative flex items-start gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-400 to-teal-500 text-white shadow-lg shadow-emerald-500/30">
              <Cpu className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-[15px] font-semibold text-white">{k("sourceLabel")}</span>
                <span className="rounded-full bg-emerald-400/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">{k("freeChip")}</span>
                <span className={cn("ml-auto inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium", pill.ring, pill.text)}>
                  <span className={cn("h-1.5 w-1.5 rounded-full", pill.dot)} />
                  {pill.label}
                </span>
              </div>
              <p className="mt-1.5 text-[12px] leading-relaxed text-white/65">{phone ? k("phoneBody", { model: isLocalModelId(selectedModel) ? selectedModel.slice("local/".length) : "" }) : k("intro")}</p>
            </div>
          </div>
        </div>

        {!phone && (
          <>
            {/* Diagnosis (same messages as AI settings) and the actions for it. */}
            {/* Once turned on, the offline card below says it; don't say it twice. */}
            {!enabled && <LocalModelDiagnosis tone="picker" />}

            {!enabled && (
              <div className="flex flex-wrap items-center gap-2 px-1">
                {detection?.status === "ready" ? (
                  <button type="button" onClick={() => void run(enable)} disabled={busy} className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-emerald-500 px-4 text-[12px] font-semibold text-black shadow-md shadow-emerald-500/25 hover:bg-emerald-400 disabled:opacity-60 [@media(pointer:coarse)]:h-11">
                    {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                    {t("localModel.enable")}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void run(detect)}
                    disabled={detecting}
                    className={cn(
                      "inline-flex h-9 items-center gap-1.5 rounded-xl px-4 text-[12px] font-semibold disabled:opacity-60 [@media(pointer:coarse)]:h-11",
                      // When blocked, the command above is the thing to do; checking again is secondary.
                      detection?.status === "blocked"
                        ? "border border-white/12 bg-white/[0.04] font-medium text-white/80 hover:border-white/25 hover:text-white"
                        : "bg-emerald-500 text-black shadow-md shadow-emerald-500/25 hover:bg-emerald-400",
                    )}
                  >
                    {detecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                    {detection ? t("localModel.recheck") : t("localModel.check")}
                  </button>
                )}
                <button type="button" onClick={openGuide} className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-white/12 bg-white/[0.04] px-3.5 text-[12px] font-medium text-white/80 hover:border-white/25 hover:text-white [@media(pointer:coarse)]:h-11">
                  <BookOpen className="h-3.5 w-3.5" />
                  {k("guideButton")}
                </button>
              </div>
            )}

            {live && localModels.length > 0 ? (
              <div>
                <div className="mb-1.5 flex items-center px-2 text-[11px] text-white/50">
                  <span>{k("modelsCount", { count: localModels.length })}</span>
                  <button type="button" onClick={openGuide} className="ml-auto inline-flex items-center gap-1 rounded px-1 py-0.5 hover:text-white/80"><BookOpen className="h-3 w-3" />{k("guideButton")}</button>
                </div>
                <div ref={(el) => el?.querySelector<HTMLElement>("[data-selected]")?.scrollIntoView({ block: "nearest" })}>
                  {sortLocalModels(localModels).map((m) => {
                    const isSelected = selectedModel === m.id;
                    const name = m.id.slice("local/".length);
                    const known = KNOWN_MODELS[name];
                    return (
                      <button
                        key={m.id}
                        type="button"
                        data-selected={isSelected || undefined}
                        aria-pressed={isSelected}
                        onClick={() => { onSelect(m.id); onClose(); }}
                        className={cn(
                          "mb-1.5 flex min-h-[64px] w-full items-center gap-3 rounded-[13px] border py-2.5 pl-3.5 pr-4 text-left transition-colors",
                          isSelected
                            ? "border-emerald-400/30 bg-emerald-400/10 shadow-md shadow-emerald-500/20"
                            : "border-white/[0.07] bg-white/[0.02] hover:border-white/15 hover:bg-white/[0.04]",
                        )}
                      >
                        <span aria-hidden="true" className={cn("h-2 w-2 shrink-0 rounded-full", known?.dot ?? "bg-white/35", isSelected ? "opacity-100 ring-4 ring-white/5" : "opacity-75")} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="min-w-0 truncate font-mono text-[13px] font-medium text-white/90">{name}</span>
                            {known && <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium", known.chip)}>{k(`tag.${known.tag}`)}</span>}
                            {isSelected && <Check aria-hidden="true" className="h-3 w-3 shrink-0 text-emerald-300" />}
                            <span className="ml-auto shrink-0 text-[11px] text-emerald-400/80">{t("localModel.freeTag")}</span>
                          </div>
                          <p className="mt-1 text-xs leading-snug text-white/50">{known ? k(`desc.${known.tag}`) : k("desc.other")}</p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : live ? (
              <div className="rounded-[13px] border border-white/[0.07] bg-white/[0.02] p-4 text-[12px] leading-relaxed text-white/60">{k("noModels")}</div>
            ) : enabled ? (
              // Turned on, but the runtime isn't answering right now.
              <div className="rounded-[13px] border border-red-400/20 bg-red-400/[0.06] p-4">
                <div className="text-[13px] font-medium text-red-100">{t("localModel.pickerOffline")}</div>
                <div className="mt-1 text-[12px] leading-relaxed text-white/60">{t("localModel.pickerOfflineHint")}</div>
                <button type="button" onClick={() => void run(enable)} disabled={busy} className="mt-3 inline-flex h-9 items-center gap-1.5 rounded-xl bg-white/10 px-3.5 text-[12px] font-medium text-white hover:bg-white/15 disabled:opacity-60">
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  {t("localModel.reconnect")}
                </button>
              </div>
            ) : (
              <>
                {/* The way to connected, with the step they're on lit. */}
                <div className="grid grid-cols-3 gap-2 max-[420px]:grid-cols-1">
                  {steps.map((s) => {
                    const current = s.n === step;
                    return (
                      <div key={s.n} className={cn("rounded-[13px] border p-3 transition-colors", current ? s.tint : "border-white/[0.07] bg-white/[0.02]")}>
                        <div className="flex items-center gap-2">
                          <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-lg", current ? "bg-white/10" : "bg-white/[0.05] text-white/45")}>{s.icon}</span>
                          <span className={cn("text-[10px] font-semibold", current ? "" : "text-white/35")}>{k("stepLabel", { n: s.n })}</span>
                        </div>
                        <div className={cn("mt-2 text-[12px] font-semibold", current ? "text-white" : "text-white/70")}>{s.title}</div>
                        <div className="mt-0.5 text-[11px] leading-snug text-white/45">{s.hint}</div>
                      </div>
                    );
                  })}
                </div>

                <div className="rounded-[13px] border border-white/[0.07] bg-white/[0.02] p-3">
                  <div className="mb-2 text-[11px] font-semibold text-white/60">{t("localModel.guide.needTitle")}</div>
                  <div className="flex flex-wrap gap-1.5">
                    <Req icon={<Cpu className="h-3 w-3" />} tint="bg-emerald-400/10 text-emerald-200" text={k("reqGpu")} />
                    <Req icon={<Laptop className="h-3 w-3" />} tint="bg-violet-400/10 text-violet-200" text={k("reqMac")} />
                    <Req icon={<Globe className="h-3 w-3" />} tint="bg-amber-400/10 text-amber-200" text={k("reqBrowser")} />
                    <Req icon={<HardDrive className="h-3 w-3" />} tint="bg-sky-400/10 text-sky-200" text={k("reqDisk")} />
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </div>

      <div className="flex min-h-10 shrink-0 items-center justify-between gap-2 border-t border-white/[0.08] px-[18px] py-2.5 text-[11px] text-white/50">
        <span className="inline-flex items-center gap-1.5"><MonitorSmartphone className="h-3.5 w-3.5 text-emerald-400/70" />{k("footer")}</span>
        <span className="text-emerald-400/80">{k("footerFree")}</span>
      </div>
    </>
  );
}

function Req({ icon, tint, text }: { icon: ReactNode; tint: string; text: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px]", tint)}>
      {icon}
      {text}
    </span>
  );
}
