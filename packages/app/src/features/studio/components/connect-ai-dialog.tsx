import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, CircleCheck, Copy, ExternalLink, Loader2, Trash2, Unplug } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useEditorStore } from "@/stores/editor";

const apiBase = import.meta.env.VITE_API_URL || "";

type AppId = "claude" | "chatgpt" | "cursor" | "claudeCode" | "codexCli";
const APPS: AppId[] = ["claude", "chatgpt", "cursor", "claudeCode", "codexCli"];

interface ConnectedAi { clientId: string; name: string; connectedAt: string | null; lastUsedAt: string | null; lastCallAt?: string | null; lastTool?: string | null }
interface TokenInfo { id: string; name: string; prefix: string; createdAt: string | null; lastUsedAt: string | null; expiresAt: string | null }

const STEP_COUNT: Record<AppId, number> = { claude: 4, chatgpt: 4, cursor: 2, claudeCode: 2, codexCli: 1 };

/**
 * Connect your own AI (Claude, ChatGPT/Codex, Cursor, a terminal agent) to
 * Yumina. The AI is given one address; it signs the creator in (OAuth) and
 * can then work on any of their cards. Per app, only that app's steps, each
 * thing to paste with its own copy button. Below: the AIs already connected,
 * each one disconnectable; folded away, how to switch the Yumina account an
 * AI is signed into, and a token for this one card for tools that cannot
 * sign in.
 */
export function ConnectAiDialog({ worldId, open, onClose }: { worldId: string | null; open: boolean; onClose: () => void }) {
  const { t } = useTranslation("editor");
  const [app, setApp] = useState<AppId>("claude");
  const [copied, setCopied] = useState<string | null>(null);
  const [connected, setConnected] = useState<ConnectedAi[] | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [showSwitch, setShowSwitch] = useState(false);
  const cardName = useEditorStore((s) => s.worldDraft?.name ?? "");
  const origin = apiBase || window.location.origin;
  const mcpUrl = `${origin}/mcp`;
  // When this wizard opened: a call after it is the first message arriving.
  const openedAt = useRef(0);

  const loadConnected = useCallback(async () => {
    const r = await fetch(`${apiBase}/api/studio/connected-ais`, { credentials: "include" });
    setConnected(r.ok ? (((await r.json()).data ?? []) as ConnectedAi[]) : []);
  }, []);
  // While open, watch for the AI to connect and then to make its first call.
  useEffect(() => {
    if (!open) return;
    openedAt.current = Date.now();
    void loadConnected();
    // Not only while visible: the creator is in the other app sending the
    // message, and Chrome marks a covered window hidden.
    const timer = setInterval(() => { void loadConnected(); }, 3000);
    return () => clearInterval(timer);
  }, [open, loadConnected]);
  const heard = (connected ?? []).filter((ai) => ai.lastCallAt && Date.parse(ai.lastCallAt) >= openedAt.current)
    .sort((a, b) => Date.parse(b.lastCallAt!) - Date.parse(a.lastCallAt!))[0];
  const firstMessage = cardName.trim()
    ? t("studio.connectAi.try.messageCard", { card: cardName.trim() })
    : t("studio.connectAi.try.messageList");

  const copy = (key: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(() => { setCopied(key); setTimeout(() => setCopied(null), 1500); }).catch(() => {});
  };
  const disconnect = async (clientId: string) => {
    await fetch(`${apiBase}/api/studio/connected-ais/${encodeURIComponent(clientId)}`, { method: "DELETE", credentials: "include" });
    await loadConnected();
  };

  const pasteBox = (key: string, text: string) => (
    <div className="mt-1.5 flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-2">
      <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[11.5px] leading-relaxed text-foreground/90">{text}</code>
      <button type="button" onClick={() => copy(key, text)} aria-label={t("studio.connectAi.copy")}
        className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
        {copied === key ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );

  // What each step pastes, if anything.
  const pasteFor = (step: number): { key: string; text: string } | null => {
    if (app === "claude" && step === 3) return { key: "url", text: mcpUrl };
    if (app === "chatgpt" && step === 3) return { key: "url", text: mcpUrl };
    if (app === "cursor" && step === 1) return { key: "url", text: mcpUrl };
    if (app === "claudeCode" && step === 1) return { key: "cc", text: `claude mcp add --transport http yumina ${mcpUrl}` };
    // Two lines rather than `&&`: Windows PowerShell 5 has no `&&`.
    if (app === "codexCli" && step === 1) return { key: "cx", text: `codex mcp add yumina --url ${mcpUrl}\ncodex mcp login yumina` };
    return null;
  };
  const cursorLink = `cursor://anysphere.cursor-deeplink/mcp/install?name=yumina&config=${encodeURIComponent(btoa(JSON.stringify({ url: mcpUrl })))}`;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("studio.connectAi.title")}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-wrap gap-1.5" role="tablist">
          {APPS.map((id) => (
            <button key={id} type="button" role="tab" aria-selected={app === id} onClick={() => setApp(id)} data-connect-ai-app={id}
              className={cn(
                "rounded-full border px-3 py-1 text-xs transition-colors",
                app === id ? "border-primary bg-primary/10 font-semibold text-primary" : "border-border text-muted-foreground hover:text-foreground",
              )}>
              {t(`studio.connectAi.apps.${id}`)}
            </button>
          ))}
        </div>

        <ol className="space-y-3">
          {Array.from({ length: STEP_COUNT[app] }, (_, i) => i + 1).map((step) => {
            const paste = pasteFor(step);
            return (
              <li key={`${app}-${step}`} className="flex gap-3">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground">{step}</span>
                <div className="min-w-0 flex-1 text-[13px] leading-relaxed">
                  {t(`studio.connectAi.steps.${app}.${step}` as "studio.connectAi.steps.claude.1")}
                  {app === "cursor" && step === 1 && (
                    <a href={cursorLink} className="mt-1.5 flex w-fit items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground">
                      <ExternalLink className="h-3 w-3" />{t("studio.connectAi.cursorButton")}
                    </a>
                  )}
                  {paste && pasteBox(paste.key, paste.text)}
                </div>
              </li>
            );
          })}
        </ol>

        <div className="space-y-2.5 rounded-xl border border-border bg-muted/20 p-3" data-connect-ai-try>
          <div className="text-[13px] font-semibold text-foreground">{t("studio.connectAi.try.title")}</div>
          <ol className="space-y-2.5">
            <li className="flex gap-3">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground">1</span>
              <div className="min-w-0 flex-1 text-[13px] leading-relaxed">
                {t(`studio.connectAi.try.where.${app}`)}
                {pasteBox("first", firstMessage)}
              </div>
            </li>
            <li className="flex gap-3">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground">2</span>
              <div className="min-w-0 flex-1 text-[13px] leading-relaxed">{t(`studio.connectAi.try.allow.${app}`)}</div>
            </li>
          </ol>
          {heard ? (
            <div className="flex items-start gap-2 rounded-lg bg-emerald-500/10 px-3 py-2 text-[13px] leading-relaxed text-emerald-300" data-connect-ai-heard>
              <CircleCheck className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{t("studio.connectAi.try.heard", { name: heard.name })}</span>
            </div>
          ) : (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-[12px] text-muted-foreground" data-connect-ai-waiting>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("studio.connectAi.try.waiting")}
              </div>
              <div className="text-[11.5px] leading-relaxed text-muted-foreground">{t(`studio.connectAi.try.notFound.${app}`)}</div>
            </div>
          )}
        </div>

        <p className="text-[11.5px] leading-relaxed text-muted-foreground">{t("studio.connectAi.costNote")}</p>

        <div className="space-y-2 border-t border-border pt-3">
          <div className="text-xs font-semibold text-foreground">{t("studio.connectAi.connectedTitle")}</div>
          {connected === null ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          ) : connected.length === 0 ? (
            <div className="text-xs text-muted-foreground">{t("studio.connectAi.connectedNone")}</div>
          ) : (
            connected.map((ai) => (
              <div key={ai.clientId} className="flex items-center gap-2 text-xs">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
                <span className="truncate font-medium">{ai.name}</span>
                <span className="ml-auto truncate text-muted-foreground">
                  {ai.lastUsedAt ? t("studio.connectAi.lastUsed", { when: new Date(ai.lastUsedAt).toLocaleString() }) : ""}
                </span>
                <button type="button" onClick={() => void disconnect(ai.clientId)} data-connect-ai-disconnect
                  className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 py-1 text-muted-foreground hover:bg-red-500/10 hover:text-red-400">
                  <Unplug className="h-3 w-3" />{t("studio.connectAi.disconnect")}
                </button>
              </div>
            ))
          )}
        </div>

        <div className="border-t border-border pt-3" data-connect-ai-switch>
          <button type="button" onClick={() => setShowSwitch((v) => !v)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", showSwitch && "rotate-180")} />
            {t("studio.connectAi.switch.toggle")}
          </button>
          {showSwitch && (
            <ol className="mt-2 space-y-2">
              {[t("studio.connectAi.switch.step1"), t(`studio.connectAi.switch.apps.${app}`)].map((text, i) => (
                <li key={i} className="flex gap-3">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground">{i + 1}</span>
                  <div className="min-w-0 flex-1 text-[12.5px] leading-relaxed">
                    {text}
                    {i === 1 && app === "codexCli" && pasteBox("cx-switch", "codex mcp logout yumina\ncodex mcp login yumina")}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>

        {worldId && (
          <div className="border-t border-border pt-3">
            <button type="button" onClick={() => setShowToken((v) => !v)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", showToken && "rotate-180")} />
              {t("studio.connectAi.tokenToggle")}
            </button>
            {showToken && <CardTokenPanel worldId={worldId} mcpUrl={mcpUrl} copy={copy} copied={copied} />}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** A token for one card, for a tool that cannot sign in (shown once). */
function CardTokenPanel({ worldId, mcpUrl, copy, copied }: { worldId: string; mcpUrl: string; copy: (key: string, text: string) => void; copied: string | null }) {
  const { t } = useTranslation("editor");
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [made, setMade] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch(`${apiBase}/api/studio/${worldId}/access-tokens`, { credentials: "include" });
    if (r.ok) setTokens(((await r.json()).data ?? []) as TokenInfo[]);
  }, [worldId]);
  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    setBusy(true);
    try {
      const r = await fetch(`${apiBase}/api/studio/${worldId}/access-tokens`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "AI" }),
      });
      if (r.ok) { setMade((await r.json()).data.token); await load(); }
    } finally { setBusy(false); }
  };
  const revoke = async (id: string) => {
    await fetch(`${apiBase}/api/studio/${worldId}/access-tokens/${id}`, { method: "DELETE", credentials: "include" });
    await load();
  };
  const header = made ? `Authorization: Bearer ${made}` : "";

  return (
    <div className="mt-2 space-y-2">
      {made ? (
        <>
          <div className="text-[11px] text-muted-foreground">{t("studio.connectAi.tokenAddress")}</div>
          <Box text={mcpUrl} k="tok-url" copy={copy} copied={copied} />
          <div className="text-[11px] text-muted-foreground">{t("studio.connectAi.tokenHeader")}</div>
          <Box text={header} k="tok-h" copy={copy} copied={copied} />
        </>
      ) : (
        <button type="button" onClick={() => void create()} disabled={busy}
          className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50">
          {busy && <Loader2 className="h-3 w-3 animate-spin" />}{t("studio.connectAi.tokenMake")}
        </button>
      )}
      {tokens.map((tok) => (
        <div key={tok.id} className="flex items-center gap-2 text-xs">
          <span className="font-mono text-muted-foreground">{tok.prefix}…</span>
          {tok.expiresAt && <span className="text-muted-foreground">{t("studio.connectAi.tokenExpires", { date: new Date(tok.expiresAt).toLocaleDateString() })}</span>}
          <span className="ml-auto text-muted-foreground">
            {tok.lastUsedAt ? t("studio.connectAi.lastUsed", { when: new Date(tok.lastUsedAt).toLocaleString() }) : t("studio.connectAi.unused")}
          </span>
          <button type="button" onClick={() => void revoke(tok.id)} aria-label={t("studio.connectAi.revoke")}
            className="rounded p-1 text-muted-foreground hover:bg-red-500/10 hover:text-red-400"><Trash2 className="h-3.5 w-3.5" /></button>
        </div>
      ))}
    </div>
  );
}

function Box({ text, k, copy, copied }: { text: string; k: string; copy: (key: string, text: string) => void; copied: string | null }) {
  const { t } = useTranslation("editor");
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-2">
      <code className="min-w-0 flex-1 break-all font-mono text-[11.5px] leading-relaxed text-foreground/90">{text}</code>
      <button type="button" onClick={() => copy(k, text)} aria-label={t("studio.connectAi.copy")}
        className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
        {copied === k ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}
