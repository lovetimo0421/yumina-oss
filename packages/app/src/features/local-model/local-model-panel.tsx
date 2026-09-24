import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Cpu } from "lucide-react";
import { useLocalModelStore } from "./store";
import { LocalModelGuide } from "./local-model-guide";
import { LocalModelStatus, currentOrigin, useCopyToast } from "./local-model-status";
import { LocalModelInstaller } from "./local-model-installer";

/**
 * Setup + status for running turns on the player's own GPU.
 *
 * The panel is mostly a diagnosis funnel. Getting a local model reachable from
 * a website has three failure points that look identical to a player — nothing
 * installed, installed but not allowed to talk to us, and the browser's own
 * local-network prompt — and the whole value of this screen is saying which
 * one they're actually looking at instead of a generic "couldn't connect".
 */

export function LocalModelPanel() {
  const { t } = useTranslation("profile");
  const { enabled, detecting, detection, resume } = useLocalModelStore();

  // Reconnect automatically for a player who already set this up — the whole
  // point is that it keeps working after a refresh without a second setup pass.
  useEffect(() => {
    void resume();
  }, [resume]);

  const copy = useCopyToast();

  // After the one-command installer is copied, keep checking and connect as
  // soon as the runtime answers (see the store's watchForRuntime).
  const watching = useLocalModelStore((s) => s.watching);
  const watchForRuntime = useLocalModelStore((s) => s.watchForRuntime);
  const onInstallerCopied = useCallback((command: string) => {
    void copy(command);
    watchForRuntime();
  }, [copy, watchForRuntime]);

  // Which guide step the diagnosis says the player is stuck on.
  const focusStep = enabled || detecting || !detection
    ? null
    : detection.status === "none"
      ? 1
      : detection.status === "blocked"
        ? 3
        : 4;

  return (
    <div className="profile-overview-glass profile-overview-glass--soft rounded-2xl overflow-hidden">
      <div className="flex items-start gap-3.5 p-5">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 border border-emerald-500/20">
          <Cpu className="h-5 w-5 text-emerald-400" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-main">{t("localModel.title")}</div>
          <div className="mt-0.5 text-[11px] leading-relaxed text-sub/60">
            {t("localModel.subtitle")}
          </div>

          <div className="mt-3">
            <LocalModelStatus />
          </div>

          <div className="mt-3 text-[10px] leading-relaxed text-sub/40">
            {t("localModel.caveats")}
          </div>

          <LocalModelGuide
            focusStep={focusStep}
            origin={currentOrigin()}
            onCopy={(text) => void copy(text)}
          />

          <LocalModelInstaller
            origin={currentOrigin()}
            waiting={watching && !enabled}
            onCommandCopied={onInstallerCopied}
          />
        </div>
      </div>
    </div>
  );
}
