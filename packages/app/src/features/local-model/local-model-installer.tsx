import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Copy, ExternalLink, Loader2, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { detectOs, type GuideOs } from "./local-model-guide";

/**
 * "Don't want to do it by hand?" — one pasted command that does steps 1–3 of
 * the guide and picks a model for the player's hardware.
 *
 * Pasting a command into PowerShell is also the single most common way people
 * get their machines taken over ("ClickFix"), so this section spends as much
 * space on what the command does, where it comes from and how to undo it as
 * on the command itself — and says plainly that Yumina never asks for this
 * anywhere but here.
 */

type InstallerOs = Exclude<GuideOs, "linux">;

/**
 * The one line a player pastes. `allow` only lets this site connect and
 * restarts Ollama — for an Ollama that's installed but refusing the site.
 */
export function installerCommand(os: InstallerOs, origin: string, lang: string, mode: "setup" | "allow" = "setup"): string {
  const params = [mode === "allow" ? "mode=allow" : "", lang.startsWith("zh") ? "lang=zh" : ""].filter(Boolean).join("&");
  const q = params ? `?${params}` : "";
  return os === "windows"
    ? `irm "${origin}/local/setup.ps1${q}" | iex`
    : `curl -fsSL "${origin}/local/setup.sh${q}" | bash`;
}

export function LocalModelInstaller({ origin, waiting, onCommandCopied }: {
  origin: string;
  /** True once the command was copied and the panel is watching for the runtime. */
  waiting: boolean;
  onCommandCopied: (command: string) => void;
}) {
  const { t, i18n } = useTranslation("profile");
  const [open, setOpen] = useState(false);
  const detected = detectOs();
  const [os, setOs] = useState<GuideOs>(detected);
  const command = os === "linux" ? null : installerCommand(os, origin, i18n.language);
  const scriptUrl = os === "linux" ? null : `${origin}/local/${os === "windows" ? "setup.ps1" : "setup.sh"}${i18n.language.startsWith("zh") ? "?lang=zh" : ""}`;
  const k = (key: string) => t(`localModel.installer.${key}` as never) as string;
  const osKey = os === "mac" ? "Mac" : "Windows";

  return (
    <div className="mt-3 border-t border-white/[0.06] pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-left"
      >
        <span className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2">
          <span className="text-[12px] font-semibold text-main">{k("title")}</span>
          <span className="text-[11px] text-sub/45">{k("subtitle")}</span>
        </span>
        <ChevronDown className={cn("ml-auto h-4 w-4 text-sub/50 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="mt-3 space-y-3 text-[11px] leading-relaxed">
          <p className="text-sub/70">{k("intro")}</p>

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
                {t(`localModel.guide.os.${key}` as never) as string}
              </button>
            ))}
          </div>

          {os === "linux" ? (
            <p className="rounded-xl border border-white/[0.07] bg-black/15 p-3 text-sub/70">{k("linux")}</p>
          ) : (
            <>
              {/* What it does — before the command, not after. */}
              <div className="rounded-xl border border-white/[0.07] bg-black/15 p-3">
                <div className="mb-1.5 text-[12px] font-semibold text-main">{k("doesTitle")}</div>
                <ol className="list-decimal space-y-1 pl-4 text-sub/70">
                  <li>{k(`does1${osKey}`)}</li>
                  <li>{k("does2")}</li>
                  <li>{k("does3")}</li>
                  <li>{k("does4")}</li>
                </ol>
                <div className="mt-2 space-y-0.5 text-sub/50">
                  <div>{k(`promise${osKey}`)}</div>
                  <div>{k(`undo${osKey}`)}</div>
                </div>
              </div>

              {/* How big — before anyone commits to a download of this size. */}
              <div className="rounded-xl border border-sky-400/20 bg-sky-400/[0.05] p-3">
                <div className="mb-1.5 text-[12px] font-semibold text-main">{k("sizeTitle")}</div>
                <ul className="list-disc space-y-1 pl-4 text-sub/70">
                  <li>{k(`sizeOllama${osKey}`)}</li>
                  <li>{k("sizeModels")}</li>
                </ul>
                <div className="mt-2 font-medium text-sky-200/90">{k(`sizeTotal${osKey}`)}</div>
                <div className="mt-0.5 text-sub/50">{k("sizeTime")}</div>
              </div>

              <ol className="space-y-2">
                <li className="rounded-xl border border-white/[0.07] bg-black/15 p-3">
                  <div className="flex items-center gap-2">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-[10px] font-semibold text-emerald-300">1</span>
                    <span className="text-[12px] font-semibold text-main">{k(`open${osKey}Title`)}</span>
                  </div>
                  <p className="mt-2 pl-7 text-sub/70">{k(`open${osKey}`)}</p>
                </li>

                <li className="rounded-xl border border-white/[0.07] bg-black/15 p-3">
                  <div className="flex items-center gap-2">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-[10px] font-semibold text-emerald-300">2</span>
                    <span className="text-[12px] font-semibold text-main">{k("pasteTitle")}</span>
                  </div>
                  <div className="mt-2 space-y-2 pl-7">
                    <div className="break-all rounded-lg border border-white/10 bg-black/40 px-2.5 py-2 font-mono text-[11px] text-main/90">{command}</div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => command && onCommandCopied(command)}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/90 px-3 py-1.5 text-[11px] font-semibold text-black hover:bg-emerald-400"
                      >
                        <Copy className="h-3 w-3" />
                        {k("copy")}
                      </button>
                      {scriptUrl && (
                        <a
                          href={scriptUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-[11px] text-sub/60 hover:text-sub hover:underline"
                        >
                          {k("viewScript")}
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                    <p className="text-sub/70">{k(`paste${osKey}`)}</p>
                  </div>
                </li>

                <li className="rounded-xl border border-white/[0.07] bg-black/15 p-3">
                  <div className="flex items-center gap-2">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-[10px] font-semibold text-emerald-300">3</span>
                    <span className="text-[12px] font-semibold text-main">{k("waitTitle")}</span>
                  </div>
                  <p className="mt-2 pl-7 text-sub/70">{k("wait")}</p>
                </li>

                <li className="rounded-xl border border-white/[0.07] bg-black/15 p-3">
                  <div className="flex items-center gap-2">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-[10px] font-semibold text-emerald-300">4</span>
                    <span className="text-[12px] font-semibold text-main">{k("backTitle")}</span>
                  </div>
                  <p className="mt-2 pl-7 text-sub/70">{k("back")}</p>
                  {waiting && (
                    <div className="mt-2 flex items-center gap-1.5 pl-7 text-emerald-300/80">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      {k("watching")}
                    </div>
                  )}
                </li>
              </ol>

              <div className="flex gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-3">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                <div className="text-amber-100/80">{k("scamWarning")}</div>
              </div>

              <div className="space-y-2 rounded-xl border border-white/[0.07] bg-black/15 p-3">
                {(["antivirus", "slow", "failed"] as const).map((key) => (
                  <div key={key}>
                    <div className="font-medium text-main/85">{k(`faq.${key}.q`)}</div>
                    <div className="text-sub/60">{k(`faq.${key}.a`)}</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
