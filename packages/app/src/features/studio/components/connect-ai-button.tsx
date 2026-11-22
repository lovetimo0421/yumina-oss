import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bot } from "lucide-react";
import { cn } from "@/lib/utils";
import { AiAppLogo, appForClient, type AiApp } from "./ai-app-logos";

/** Fired by the board's live stream each time an outside AI writes to the open card. */
export const OUTSIDE_AI_WRITE_EVENT = "yumina:outside-ai-write";
/** How long the button keeps saying an AI is at work after its last write. */
const WORKING_FOR_MS = 10_000;

const STACK: AiApp[] = ["claude", "chatgpt", "cursor"];

function Mark({ name, size }: { name: string; size: number }) {
  const app = appForClient(name);
  return app ? <AiAppLogo app={app} size={size} /> : <Bot style={{ width: size, height: size }} aria-hidden />;
}

/**
 * 连接你的 AI on the Studio bar: no words, so the bar keeps its room for 试玩.
 * With no AI signed in, the marks of the AIs one can connect; with one, its
 * mark and a green dot; while it is writing to this card, a gold ring and its
 * name, until it has been quiet for ten seconds. Opens the connect dialog.
 */
export function ConnectAiButton({ onOpen, refreshKey }: { onOpen: () => void; refreshKey?: unknown }) {
  const { t } = useTranslation("editor");
  const [connected, setConnected] = useState<{ name: string }[]>([]);
  const [working, setWorking] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Signed-in AIs, then account tokens an AI has used (DeepSeek cannot sign in).
  const load = useCallback(async () => {
    try {
      const base = import.meta.env.VITE_API_URL || "";
      const [r, tk] = await Promise.all([
        fetch(`${base}/api/studio/connected-ais`, { credentials: "include" }),
        fetch(`${base}/api/studio/access-tokens`, { credentials: "include" }),
      ]);
      if (!r.ok) return;
      const signedIn = ((await r.json()).data ?? []) as { name: string }[];
      const tokens = tk.ok ? (((await tk.json()).data ?? []) as { name: string; lastUsedAt: string | null }[]).filter((tok) => tok.lastUsedAt) : [];
      setConnected([...signedIn, ...tokens.map((tok) => ({ name: tok.name }))]);
    } catch { /* offline: keep what is shown */ }
  }, []);
  // Again after the dialog closes (refreshKey), where an AI may have been connected or removed.
  useEffect(() => { void load(); }, [load, refreshKey]);

  useEffect(() => {
    const onWrite = (event: Event) => {
      const actor = (event as CustomEvent<{ actor?: string }>).detail?.actor;
      if (!actor) return;
      setWorking(actor);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setWorking(null), WORKING_FOR_MS);
    };
    window.addEventListener(OUTSIDE_AI_WRITE_EVENT, onWrite);
    return () => { window.removeEventListener(OUTSIDE_AI_WRITE_EVENT, onWrite); if (timer.current) clearTimeout(timer.current); };
  }, []);

  const first = connected[0];
  const label = working ? t("studio.connectAi.working", { name: working })
    : first ? t("studio.connectAi.heard", { name: first.name })
    : t("studio.connectAi.menu");

  return (
    <button type="button" onClick={onOpen} title={label} aria-label={label} data-studio-connect-ai={working ? "working" : first ? "connected" : "none"}
      className={cn(
        "flex h-8 shrink-0 items-center gap-2 rounded-full border transition-colors",
        working ? "border-primary bg-primary/10 pl-1 pr-3 text-xs font-bold text-foreground"
          : "border-transparent px-1 hover:bg-foreground/[0.06]",
      )}>
      {working ? (
        <>
          <span className="relative flex h-6 w-6 items-center justify-center rounded-full bg-foreground/10">
            <span aria-hidden className="absolute inset-0 animate-ping rounded-full bg-primary/40 motion-reduce:animate-none" />
            <Mark name={working} size={14} />
          </span>
          {label}
        </>
      ) : first ? (
        <span className="relative flex h-6 w-6 items-center justify-center rounded-full bg-foreground/10">
          <Mark name={first.name} size={14} />
          <span aria-hidden className="absolute -bottom-px -right-px h-2 w-2 rounded-full bg-emerald-400 ring-2 ring-background" />
        </span>
      ) : (
        <span className="flex items-center" aria-hidden>
          {STACK.map((app, i) => (
            <span key={app} className={cn("flex h-6 w-6 items-center justify-center rounded-full bg-foreground/10 ring-2 ring-background", i > 0 && "-ml-1.5")}>
              <AiAppLogo app={app} size={13} />
            </span>
          ))}
        </span>
      )}
    </button>
  );
}
