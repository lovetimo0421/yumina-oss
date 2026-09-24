import { useCallback, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, CheckCircle2, AlertTriangle, Copy, RefreshCw, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useLocalModelStore } from "./store";
import { detectOs } from "./local-model-guide";
import { installerCommand } from "./local-model-installer";

/** Where the runtime must be told to accept requests from. */
export function currentOrigin(): string {
  try {
    return window.location.origin;
  } catch {
    return "https://yumina.io";
  }
}

export function useCopyToast() {
  const { t } = useTranslation("profile");
  return useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("localModel.copied"));
    } catch {
      toast.error(t("localModel.copyFailed"));
    }
  }, [t]);
}

function toneClasses(tone: "panel" | "picker") {
  return tone === "picker"
    ? { main: "text-white/85", sub: "text-white/55", faint: "text-white/35", box: "border-white/[0.08] bg-white/[0.03]", btn: "border-white/10 bg-white/[0.03] text-white/70 hover:border-white/20 hover:text-white" }
    : { main: "text-main", sub: "text-sub/60", faint: "text-sub/40", box: "border-white/10 bg-black/20", btn: "border-white/10 bg-white/[0.03] text-sub hover:border-white/20" };
}

/**
 * What the player is looking at when it isn't working, and the one thing to
 * do about it. Messages only — each caller brings its own buttons.
 */
export function LocalModelDiagnosis({ tone = "panel" }: { tone?: "panel" | "picker" }) {
  const { t, i18n } = useTranslation("profile");
  const { enabled, detecting, detection, error, watching, watchForRuntime } = useLocalModelStore();
  const c = toneClasses(tone);
  return (
    <div className="space-y-2 empty:hidden">
      {error && <div className="text-[11px] text-red-300/80">{error}</div>}

      {/* Chrome's local-network prompt is up (or about to be) and the probe
          is waiting on it. Without this line the spinner just hangs. */}
      {!enabled && detecting && (
        <div className={cn("text-[11px] leading-relaxed", c.sub)}>{t("localModel.detectingHint")}</div>
      )}

      {/* The browser blocked this site from the player's machine. */}
      {!enabled && !detecting && detection?.status === "denied" && (
        <div className="space-y-2 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-amber-200">
            <AlertTriangle className="h-3.5 w-3.5" />
            {t("localModel.deniedTitle")}
          </div>
          <div className={cn("text-[11px] leading-relaxed", c.sub)}>{t("localModel.deniedBody")}</div>
        </div>
      )}

      {/* Nothing found — they need a runtime before anything else matters. */}
      {!enabled && !detecting && detection?.status === "none" && (
        <div className={cn("space-y-2 rounded-xl border p-3", c.box)}>
          <div className={cn("text-[11px] font-medium", c.main)}>{t("localModel.noneTitle")}</div>
          <div className={cn("text-[11px] leading-relaxed", c.sub)}>{t("localModel.noneBody")}</div>
          <a
            href="https://ollama.com/download"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
          >
            {t("localModel.downloadOllama")}
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      )}

      {/* Found, but it won't answer this site. One pasted line lets it in and
          restarts Ollama; the page then connects by itself. */}
      {!enabled && !detecting && detection?.status === "blocked" && (
        <BlockedFix tone={tone} runtime={detection.runtime.label} watching={watching} onCopied={watchForRuntime} lang={i18n.language} />
      )}

      {/* Ready to go. */}
      {!enabled && !detecting && detection?.status === "ready" && (
        <div className="space-y-1.5 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-200">
            <CheckCircle2 className="h-3.5 w-3.5" />
            {t("localModel.readyTitle", { runtime: detection.runtime.label, count: detection.models.length })}
          </div>
          <div className={cn("text-[11px] leading-relaxed", c.sub)}>{t("localModel.readyBody")}</div>
        </div>
      )}

    </div>
  );
}

/**
 * Connection status, diagnosis and the check / turn on / turn off buttons for
 * the local bridge. Shared by the AI-settings panel and the model picker's
 * "This computer" source so the two can never disagree about what state the
 * player is in or what to do next.
 *
 * The diagnosis is the point: nothing installed, installed but refusing this
 * site, and the browser blocking the site all fail the same way from inside
 * the page, and each needs a different fix.
 *
 * `tone` picks text colours: the settings panel follows the app theme, the
 * model picker is always dark.
 */
export function LocalModelStatus({ tone = "panel", extraActions }: {
  tone?: "panel" | "picker";
  /** Rendered after the built-in buttons, e.g. a link to the setup guide. */
  extraActions?: ReactNode;
}) {
  const { t } = useTranslation("profile");
  const { enabled, detecting, detection, status, error, detect, enable, disable } = useLocalModelStore();
  const [busy, setBusy] = useState(false);
  const c = toneClasses(tone);

  const onEnable = useCallback(async () => {
    setBusy(true);
    try {
      await enable();
    } finally {
      setBusy(false);
    }
  }, [enable]);

  const statusLabel = status === "running"
    ? t("localModel.statusRunning")
    : status === "connected"
      ? t("localModel.statusConnected")
      : status === "connecting"
        ? t("localModel.statusConnecting")
        : t("localModel.statusError");

  return (
    <div>
      {enabled && (
        <div className="flex items-center gap-2 text-[11px]">
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              status === "error" ? "bg-red-400" : status === "connecting" ? "bg-amber-400 animate-pulse" : "bg-emerald-400",
            )}
          />
          <span className={c.main}>{statusLabel}</span>
          {detection?.status === "ready" && <span className={c.faint}>· {detection.runtime.label}</span>}
        </div>
      )}

      <div className={cn(enabled && "mt-2")}>
        <LocalModelDiagnosis tone={tone} />
      </div>

      <div className={cn("flex flex-wrap items-center gap-2", (enabled || detecting || detection || error) && "mt-3")}>
        {!enabled && (
          <button
            type="button"
            onClick={() => void detect()}
            disabled={detecting}
            className={cn("inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[11px] font-medium disabled:opacity-50", c.btn)}
          >
            {detecting ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            {detection ? t("localModel.recheck") : t("localModel.check")}
          </button>
        )}

        {!enabled && detection?.status === "ready" && (
          <button
            type="button"
            onClick={() => void onEnable()}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/90 px-3 py-1.5 text-[11px] font-semibold text-black hover:bg-emerald-400 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            {t("localModel.enable")}
          </button>
        )}

        {enabled && (
          <button
            type="button"
            onClick={disable}
            className={cn("inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[11px] font-medium", c.btn)}
          >
            {t("localModel.disable")}
          </button>
        )}

        {extraActions}
      </div>
    </div>
  );
}

function BlockedFix({ tone, runtime, watching, onCopied, lang }: {
  tone: "panel" | "picker";
  runtime: string;
  watching: boolean;
  onCopied: () => void;
  lang: string;
}) {
  const { t } = useTranslation("profile");
  const copy = useCopyToast();
  const c = toneClasses(tone);
  const os = detectOs();
  const command = os === "linux" ? null : installerCommand(os, currentOrigin(), lang, "allow");
  return (
    <div className="space-y-2.5 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-3">
      <div className="flex items-center gap-1.5 text-[12px] font-medium text-amber-200">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        {t("localModel.blockedTitle", { runtime })}
      </div>
      {command ? (
        <>
          <div className={cn("text-[11px] leading-relaxed", c.sub)}>
            {t(os === "mac" ? "localModel.blockedFixMac" : "localModel.blockedFixWindows")}
          </div>
          <div className="break-all rounded-lg border border-white/10 bg-black/35 px-2.5 py-2 font-mono text-[11px] text-white/85">{command}</div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => { void copy(command); onCopied(); }}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-emerald-500 px-3 text-[11px] font-semibold text-black shadow-md shadow-emerald-500/20 hover:bg-emerald-400"
            >
              <Copy className="h-3 w-3" />
              {t("localModel.installer.copy")}
            </button>
            {watching && (
              <span className="inline-flex items-center gap-1.5 text-[11px] text-emerald-300/85">
                <Loader2 className="h-3 w-3 animate-spin" />
                {t("localModel.blockedWatching")}
              </span>
            )}
          </div>
          <div className={cn("text-[10px] leading-relaxed", c.faint)}>{t("localModel.blockedNoReboot")}</div>
        </>
      ) : (
        <div className={cn("text-[11px] leading-relaxed", c.sub)}>{t("localModel.blockedLinux")}</div>
      )}
    </div>
  );
}
