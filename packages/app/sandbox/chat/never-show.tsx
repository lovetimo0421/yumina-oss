import { useEffect, useMemo, useState } from "react";
import { EyeOff, Image as ImageIcon } from "lucide-react";
import { useYumina } from "../sandbox-context";
import { makeChatT } from "./i18n";
import type { SandboxMessage } from "./types";
import { useTurnImageSettings } from "./turn-images";
import { PASSAGE_MAX } from "./turn-image-prompt";

/**
 * Select words in an AI reply and a small bar offers:
 * - "Never show this": one tap adds them to the player's regex rules (removed on screen and from what the AI is
 *   sent). Only a short phrase on one line.
 * - "Draw this": the reply's picture is drawn from the selected passage instead of the reply's end.
 * Desktop: on selecting with the mouse. Touch: on a long-press selection; the bar then sits below the selection,
 * clear of the system's own copy menu above it.
 */
export function NeverShowSelection() {
  const api = useYumina();
  const t = useMemo(() => makeChatT(api.language), [api.language]);
  const { settings: turnImages } = useTurnImageSettings(api);
  const [pick, setPick] = useState<{ text: string; messageId: string | null; x: number; y: number } | null>(null);

  useEffect(() => {
    if (api.readOnly) return;
    let timer = 0;
    const read = () => {
      const sel = document.getSelection();
      const text = sel?.toString().trim() ?? "";
      if (!sel || sel.rangeCount === 0 || !text || text.length > PASSAGE_MAX) { setPick(null); return; }
      const range = sel.getRangeAt(0);
      const host = (node: Node | null) => (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>('[data-message-role="assistant"]');
      const reply = host(range.startContainer);
      if (!reply || reply !== host(range.endContainer)) { setPick(null); return; }
      const rect = range.getBoundingClientRect();
      const touch = window.matchMedia?.("(hover: none)").matches === true;
      const y = touch ? Math.min(window.innerHeight - 48, rect.bottom + 12) : rect.top - 40;
      setPick({
        text, messageId: reply.dataset.messageId ?? null,
        x: Math.min(window.innerWidth - 230, Math.max(8, rect.left + rect.width / 2 - 110)), y: Math.max(8, y),
      });
    };
    const onChange = () => { window.clearTimeout(timer); timer = window.setTimeout(read, 250); };
    document.addEventListener("selectionchange", onChange);
    window.addEventListener("scroll", () => setPick(null), true);
    return () => { window.clearTimeout(timer); document.removeEventListener("selectionchange", onChange); };
  }, [api.readOnly]);

  if (!pick) return null;
  const canHide = pick.text.length <= 200 && !pick.text.includes("\n");
  const message = pick.messageId ? (api.messages as unknown as SandboxMessage[]).find((m) => m.id === pick.messageId) : undefined;
  const canDraw = !!message && message.role === "assistant" && !!turnImages?.available && api.mode === "session"
    && api.capabilities?.canUseSessionApis !== false && !api.isStreaming && message.turnImage?.status !== "drawing";
  if (!canHide && !canDraw) return null;
  const done = () => { setPick(null); document.getSelection()?.removeAllRanges(); };
  const button = "inline-flex min-h-8 items-center gap-1.5 px-3 py-1.5 hover:text-white";
  return (
    <div
      data-never-show
      onMouseDown={(e) => e.preventDefault()}
      style={{ position: "fixed", left: pick.x, top: pick.y, zIndex: 60 }}
      className="inline-flex items-center rounded-full border border-white/15 bg-[#17181d]/95 text-xs text-white/85 shadow-lg backdrop-blur"
    >
      {canHide && (
        <button
          type="button"
          onClick={async () => {
            const ok = await api.addRegexRule(pick.text);
            done();
            if (ok) api.showToast(t("neverShowDone"), "success");
          }}
          className={button}
        >
          <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
          {t("neverShow")}
        </button>
      )}
      {canHide && canDraw && <span className="h-3.5 w-px bg-white/15" aria-hidden="true" />}
      {canDraw && message && (
        <button
          type="button"
          onClick={() => {
            const focus = pick.text;
            done();
            void api.illustrateMessage(message.id, { focus });
          }}
          className={button}
        >
          <ImageIcon className="h-3.5 w-3.5" aria-hidden="true" />
          {t("turnImageDrawPassage")}
        </button>
      )}
    </div>
  );
}
