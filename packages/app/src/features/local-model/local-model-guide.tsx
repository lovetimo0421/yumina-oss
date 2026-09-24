import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Copy, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Step-by-step setup for running turns on the player's own GPU.
 *
 * Almost nobody arriving at this panel has a local runtime yet, and the three
 * things they need to do (install a runtime, download a model, allow this
 * site) all happen outside Yumina. The panel's diagnosis can say which one is
 * missing; this is where the player learns how to do it.
 */

export type GuideOs = "windows" | "mac" | "linux";

/** A model we've actually played cards on, keyed by how much VRAM it needs. */
const MODEL_TIERS = [
  { key: "large", tag: "qwen3.8:27b", size: "17 GB" },
  { key: "medium", tag: "qwen3.5:9b", size: "6.6 GB" },
  { key: "small", tag: "qwen3.5:4b", size: "3.4 GB" },
] as const;

const OPEN_GUIDE_FLAG = "yumina-local-guide-open";

/** Ask the settings panel to open (and scroll to) the guide on its next mount. */
export function requestGuideOpen(): void {
  try { sessionStorage.setItem(OPEN_GUIDE_FLAG, "1"); } catch { /* storage blocked: the guide just stays closed */ }
}

function guideOpenRequested(): boolean {
  try { return sessionStorage.getItem(OPEN_GUIDE_FLAG) === "1"; } catch { return false; }
}

export function detectOs(): GuideOs {
  const platform = typeof navigator !== "undefined" ? `${navigator.platform} ${navigator.userAgent}`.toLowerCase() : "";
  if (platform.includes("win")) return "windows";
  if (platform.includes("mac")) return "mac";
  return "linux";
}

export function originCommand(os: GuideOs, origin: string): string {
  if (os === "windows") return `setx OLLAMA_ORIGINS "${origin}"`;
  if (os === "mac") return `launchctl setenv OLLAMA_ORIGINS "${origin}"`;
  return `sudo systemctl edit ollama.service`;
}

function CopyLine({ text, onCopy }: { text: string; onCopy: (text: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onCopy(text)}
      className="flex w-full items-center gap-2 rounded-lg border border-white/10 bg-black/30 px-2.5 py-2 text-left font-mono text-[11px] text-sub/80 hover:border-white/20"
    >
      <Copy className="h-3 w-3 shrink-0" />
      <span className="min-w-0 whitespace-pre-wrap break-all">{text}</span>
    </button>
  );
}

function Step({ n, title, highlight, hereLabel, children }: {
  n: number;
  title: string;
  highlight: boolean;
  hereLabel: string;
  children: React.ReactNode;
}) {
  return (
    <li
      className={cn(
        "rounded-xl border p-3",
        highlight ? "border-amber-500/30 bg-amber-500/[0.06]" : "border-white/[0.07] bg-black/15",
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold",
            highlight ? "bg-amber-400 text-black" : "bg-emerald-500/15 text-emerald-300",
          )}
        >
          {n}
        </span>
        <span className="text-[12px] font-semibold text-main">{title}</span>
        {highlight && <span className="ml-auto shrink-0 text-[10px] font-medium text-amber-300">{hereLabel}</span>}
      </div>
      <div className="mt-2 space-y-2 pl-7 text-[11px] leading-relaxed text-sub/70">{children}</div>
    </li>
  );
}

export function LocalModelGuide({ focusStep, origin, onCopy }: {
  /** The step the panel's diagnosis says the player is stuck on. */
  focusStep: number | null;
  origin: string;
  onCopy: (text: string) => void;
}) {
  const { t } = useTranslation("profile");
  // Closed unless the player came here from the model picker's "setup guide" button.
  const requested = useRef(guideOpenRequested());
  const [open, setOpen] = useState(requested.current);
  const [os, setOs] = useState<GuideOs>(detectOs);
  const here = t("localModel.guide.youAreHere");
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!requested.current) return;
    try { sessionStorage.removeItem(OPEN_GUIDE_FLAG); } catch { /* ignore */ }
    const timer = setTimeout(() => rootRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }), 150);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div ref={rootRef} className="mt-4 scroll-mt-4 border-t border-white/[0.06] pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-left"
      >
        <span className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2">
          <span className="text-[12px] font-semibold text-main">{t("localModel.guide.title")}</span>
          <span className="text-[11px] text-sub/45">{t("localModel.guide.duration")}</span>
        </span>
        <ChevronDown className={cn("ml-auto h-4 w-4 text-sub/50 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          {/* What you need */}
          <div className="rounded-xl border border-white/[0.07] bg-black/15 p-3 text-[11px] leading-relaxed text-sub/70">
            <div className="mb-1.5 text-[12px] font-semibold text-main">{t("localModel.guide.needTitle")}</div>
            <ul className="list-disc space-y-1 pl-4">
              <li>{t("localModel.guide.needGpu")}</li>
              <li>{t("localModel.guide.needBrowser")}</li>
              <li>{t("localModel.guide.needDisk")}</li>
            </ul>
            <div className="mt-2 text-sub/50">{t("localModel.guide.checkVram")}</div>
          </div>

          <ol className="space-y-2">
            <Step n={1} title={t("localModel.guide.step1Title")} highlight={focusStep === 1} hereLabel={here}>
              <p>{t("localModel.guide.step1Body")}</p>
              <a
                href="https://ollama.com/download"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/90 px-3 py-1.5 text-[11px] font-semibold text-black hover:bg-emerald-400"
              >
                {t("localModel.downloadOllama")}
                <ExternalLink className="h-3 w-3" />
              </a>
              <p className="text-sub/50">{t("localModel.guide.step1After")}</p>
            </Step>

            <Step n={2} title={t("localModel.guide.step2Title")} highlight={focusStep === 2} hereLabel={here}>
              <p>{t(os === "mac" ? "localModel.guide.step2TerminalMac" : os === "windows" ? "localModel.guide.step2TerminalWindows" : "localModel.guide.step2TerminalLinux")}</p>
              <div className="space-y-2">
                {MODEL_TIERS.map((tier) => (
                  <div key={tier.key} className="space-y-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-medium text-main/90">{t(`localModel.guide.tier.${tier.key}.vram`)}</span>
                      <span className="text-sub/45">{t(`localModel.guide.tier.${tier.key}.note`)} · {tier.size}</span>
                    </div>
                    <CopyLine text={`ollama pull ${tier.tag}`} onCopy={onCopy} />
                  </div>
                ))}
              </div>
              <p className="text-sub/50">{t("localModel.guide.step2After")}</p>
            </Step>

            <Step n={3} title={t("localModel.guide.step3Title")} highlight={focusStep === 3} hereLabel={here}>
              <p>{t("localModel.guide.step3Why")}</p>
              <div className="flex gap-1" role="tablist">
                {(["windows", "mac", "linux"] as const).map((key) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={os === key}
                    onClick={() => setOs(key)}
                    className={cn(
                      "rounded-md px-2.5 py-1 text-[11px] font-medium",
                      os === key ? "bg-white/10 text-main" : "text-sub/50 hover:text-sub/80",
                    )}
                  >
                    {t(`localModel.guide.os.${key}`)}
                  </button>
                ))}
              </div>
              {os === "linux" ? (
                <>
                  <p>{t("localModel.guide.step3Linux")}</p>
                  <CopyLine text={originCommand("linux", origin)} onCopy={onCopy} />
                  <CopyLine text={`[Service]\nEnvironment="OLLAMA_ORIGINS=${origin}"`} onCopy={onCopy} />
                  <CopyLine text="sudo systemctl restart ollama" onCopy={onCopy} />
                </>
              ) : (
                <>
                  <p>{t(os === "windows" ? "localModel.guide.step3Windows" : "localModel.guide.step3Mac")}</p>
                  <CopyLine text={originCommand(os, origin)} onCopy={onCopy} />
                  <p>{t(os === "windows" ? "localModel.guide.step3RestartWindows" : "localModel.guide.step3RestartMac")}</p>
                </>
              )}
            </Step>

            <Step n={4} title={t("localModel.guide.step4Title")} highlight={focusStep === 4} hereLabel={here}>
              <p>{t("localModel.guide.step4Body")}</p>
              <p>{t("localModel.guide.step4Play")}</p>
            </Step>
          </ol>

          {/* FAQ */}
          <div className="space-y-2 rounded-xl border border-white/[0.07] bg-black/15 p-3 text-[11px] leading-relaxed">
            <div className="text-[12px] font-semibold text-main">{t("localModel.guide.faqTitle")}</div>
            {(["cost", "tab", "phone", "privacy", "quality", "locked", "other"] as const).map((key) => (
              <div key={key}>
                <div className="font-medium text-main/85">{t(`localModel.guide.faq.${key}.q`)}</div>
                <div className="text-sub/60">{t(`localModel.guide.faq.${key}.a`)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
