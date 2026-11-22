import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, ExternalLink, Loader2, Trash2, Unplug } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useEditorStore } from "@/stores/editor";
import { AiAppLogo, appForClient, type AiApp } from "./ai-app-logos";

const apiBase = import.meta.env.VITE_API_URL || "";

type AppId = AiApp;
const APPS: AppId[] = ["claude", "chatgpt", "cursor", "claudeCode", "codex", "deepseek"];

interface ConnectedAi { clientId: string; name: string; connectedAt: string | null; lastUsedAt: string | null; lastCallAt?: string | null; lastTool?: string | null }
interface TokenInfo { id: string; name: string; prefix: string; createdAt: string | null; lastUsedAt: string | null; expiresAt: string | null }

/** Whether a signed-in AI is this app. DeepSeek never signs in (it carries an account token). */
const isApp = (app: AppId, clientName: string) => app !== "deepseek" && appForClient(clientName) === app;

/** How long the last step waits for a first message before it says what to check. */
const NOT_FOUND_AFTER_MS = 90_000;

/**
 * DeepSeek Harness (dsh) overlay. dsh's MCP client sends fixed headers and
 * cannot sign in (no OAuth), so it carries an account token, which works as
 * a signed-in AI does. A
 * playtest or picture can outlast dsh's default 60 s tool timeout.
 */
const dshPatch = (mcpUrl: string, token: string) => [
  "- insert:",
  "    - id: mcp-yumina",
  "      name: '@deepseek-ai/dsh-mcp-client'",
  "      config:",
  "        serverName: yumina",
  "        transport: streamable-http",
  `        url: ${mcpUrl}`,
  "        headers:",
  `          Authorization: 'Bearer ${token}'`,
  "        toolCallTimeoutMs: 300000",
].join("\n");
const DSH_COMMAND = "npx @deepseek-ai/dsh web --patch yumina.yml";

/**
 * Connect your own AI (Claude, ChatGPT, Cursor, Claude Code, Codex) to
 * Yumina. The AI is given one address; it signs the creator in (OAuth) and
 * can then work on their cards and make things. Each app is three steps (add,
 * sign in, send a message) whose dots light up from what the server sees: a
 * new or matching signed-in AI, then its first call. Claude and Cursor add
 * Yumina with one link. DeepSeek cannot sign in, so it runs on an account
 * token made here.
 */
export function ConnectAiDialog({ worldId, open, onClose }: { worldId: string | null; open: boolean; onClose: () => void }) {
  const { t } = useTranslation("editor");
  const [picked, setPicked] = useState<AppId>("claude");
  const [copied, setCopied] = useState<string | null>(null);
  const [connected, setConnected] = useState<ConnectedAi[] | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [showSwitch, setShowSwitch] = useState(false);
  const [slow, setSlow] = useState(false);
  const cardName = useEditorStore((s) => s.worldDraft?.name ?? "");
  const origin = apiBase || window.location.origin;
  const mcpUrl = `${origin}/mcp`;
  // When this wizard opened: a sign-in or call after it is this attempt's.
  const openedAt = useRef(0);
  const app = picked;

  // Account tokens (DeepSeek) are listed with the signed-in AIs, and revoked from there.
  const [accountTokens, setAccountTokens] = useState<TokenInfo[]>([]);
  const loadConnected = useCallback(async () => {
    const [r, tk] = await Promise.all([
      fetch(`${apiBase}/api/studio/connected-ais`, { credentials: "include" }),
      fetch(`${apiBase}/api/studio/access-tokens`, { credentials: "include" }),
    ]);
    setConnected(r.ok ? (((await r.json()).data ?? []) as ConnectedAi[]) : []);
    if (tk.ok) setAccountTokens(((await tk.json()).data ?? []) as TokenInfo[]);
  }, []);
  // While open, watch for the AI to sign in and then to make its first call.
  useEffect(() => {
    if (!open) return;
    openedAt.current = Date.now();
    setSlow(false);
    void loadConnected();
    // Not only while visible: the creator is in the other app sending the
    // message, and Chrome marks a covered window hidden.
    const timer = setInterval(() => { void loadConnected(); }, 3000);
    const slowTimer = setTimeout(() => setSlow(true), NOT_FOUND_AFTER_MS);
    return () => { clearInterval(timer); clearTimeout(slowTimer); };
  }, [open, loadConnected]);
  const since = (at: string | null | undefined) => !!at && Date.parse(at) >= openedAt.current;
  const heard = (connected ?? []).filter((ai) => since(ai.lastCallAt))
    .sort((a, b) => Date.parse(b.lastCallAt!) - Date.parse(a.lastCallAt!))[0];
  const signedIn = (connected ?? []).some((ai) => isApp(app, ai.name) || since(ai.connectedAt));

  // DeepSeek: the account token made on its tab (shown once), and whether dsh
  // has used it yet. A token call is not an OAuth AI, so it never shows up
  // in connected-ais; its token's "last used" is the first-message signal.
  const [dsToken, setDsToken] = useState<{ id: string; token: string } | null>(null);
  const dsUsed = !!dsToken && !!accountTokens.find((tok) => tok.id === dsToken.id)?.lastUsedAt;
  const [dsBusy, setDsBusy] = useState(false);
  const makeDsToken = async () => {
    setDsBusy(true);
    try {
      const r = await fetch(`${apiBase}/api/studio/access-tokens`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "DeepSeek" }),
      });
      if (r.ok) { const d = (await r.json()).data; setDsToken({ id: d.id, token: d.token }); await loadConnected(); }
    } finally { setDsBusy(false); }
  };

  const heardName = app === "deepseek"
    ? (dsUsed ? t("studio.connectAi.apps.deepseek") : null)
    : heard ? (isApp(app, heard.name) ? t(`studio.connectAi.apps.${app}`) : heard.name) : null;
  // How many of the three steps are done.
  const done = app === "deepseek" ? (dsUsed ? 3 : dsToken ? 1 : 0) : heardName ? 3 : signedIn ? 2 : 0;

  // Opened from the generator (no card): something to make, not a card to work on.
  const firstMessage = !worldId ? t("studio.connectAi.message.make")
    : cardName.trim() ? t("studio.connectAi.message.card", { card: cardName.trim() })
    : t("studio.connectAi.message.list");

  const copy = (key: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(() => { setCopied(key); setTimeout(() => setCopied(null), 1500); }).catch(() => {});
  };
  const disconnect = async (clientId: string) => {
    await fetch(`${apiBase}/api/studio/connected-ais/${encodeURIComponent(clientId)}`, { method: "DELETE", credentials: "include" });
    await loadConnected();
  };
  const revokeAccountToken = async (id: string) => {
    await fetch(`${apiBase}/api/studio/access-tokens/${encodeURIComponent(id)}`, { method: "DELETE", credentials: "include" });
    if (dsToken?.id === id) setDsToken(null);
    await loadConnected();
  };

  // ── The pieces a step is made of ─────────────────────────────────────────
  const copyIcon = (key: string, text: string, className?: string) => (
    <button type="button" onClick={() => copy(key, text)} aria-label={t("studio.connectAi.copy")}
      className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground", className)}>
      {copied === key ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
  const code = (key: string, text: string, shell = true) => (
    <div className="flex items-center gap-1.5 rounded-lg border border-border bg-black/25 py-1 pl-3 pr-1">
      <code className="min-w-0 flex-1 whitespace-pre-wrap break-all py-1 font-mono text-[12.5px] leading-relaxed text-foreground">
        {text.split("\n").map((line, i) => (
          <span key={i} className="block">{shell && <span className="select-none text-foreground/40">$ </span>}{line}</span>
        ))}
      </code>
      {copyIcon(key, text)}
    </div>
  );
  // Where to click in the other app, as the buttons it shows: Settings › Plugins › Add.
  const clicks = (pre: string | null, parts: string[]) => (
    <div className="flex flex-wrap items-center gap-1.5 text-[13px] text-foreground/70">
      {pre && <span>{pre}</span>}
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 && <span aria-hidden className="text-foreground/40">›</span>}
          <span className="rounded-md border border-border bg-foreground/[0.06] px-2 py-0.5 text-[12.5px] font-semibold text-foreground">{part}</span>
        </Fragment>
      ))}
    </div>
  );
  const whenAsked = (button: string) => clicks(t("studio.connectAi.say.whenAsked"), [button]);
  const allow = t("studio.connectAi.ui.allow");
  const oneClick = (href: string, logo: AppId, newTab: boolean) => (
    <a href={href} target={newTab ? "_blank" : undefined} rel="noopener noreferrer" data-connect-ai-one-click={logo}
      className="inline-flex h-10 w-fit items-center gap-2 rounded-lg bg-primary px-4 text-sm font-bold text-primary-foreground transition-opacity hover:opacity-90">
      <AiAppLogo app={logo} size={17} mono />
      {t("studio.connectAi.addTo", { app: t(`studio.connectAi.apps.${logo}`) })}
      {newTab && <ExternalLink className="h-3.5 w-3.5" />}
    </a>
  );
  const address = (
    <div className="flex items-center gap-2 text-xs text-foreground/70">
      <span>{t("studio.connectAi.address")}</span>
      <span className="truncate font-mono text-foreground/90">{mcpUrl.replace(/^https?:\/\//, "")}</span>
      {copyIcon("url", mcpUrl, "h-7 w-7")}
    </div>
  );
  const bubble = (
    <div className="flex items-end gap-2">
      <div className="min-w-0 flex-1 rounded-2xl rounded-bl-md bg-foreground/[0.08] px-3.5 py-2.5 text-[13.5px] leading-relaxed text-foreground">{firstMessage}</div>
      <button type="button" onClick={() => copy("first", firstMessage)}
        className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 text-[12.5px] text-foreground/80 hover:bg-foreground/5 hover:text-foreground">
        {copied === "first" ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
        {copied === "first" ? t("studio.connectAi.copied") : t("studio.connectAi.copy")}
      </button>
    </div>
  );

  const claudeLink = `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Yumina&connectorUrl=${encodeURIComponent(mcpUrl)}`;
  const cursorLink = `cursor://anysphere.cursor-deeplink/mcp/install?name=yumina&config=${encodeURIComponent(btoa(JSON.stringify({ url: mcpUrl })))}`;
  const stage = (k: "add" | "auth" | "try" | "token" | "start") => t(`studio.connectAi.stage.${k}`);

  const steps: { title: string; body: ReactNode }[] = (() => {
    switch (app) {
      case "claude": return [
        { title: stage("add"), body: <>{oneClick(claudeLink, "claude", true)}{clicks(t("studio.connectAi.say.thenClick"), ["Continue", "Add"])}{address}</> },
        { title: stage("auth"), body: clicks(null, ["Connect", allow]) },
        { title: stage("try"), body: <>{bubble}{whenAsked("Always allow")}</> },
      ];
      case "chatgpt": return [
        { title: stage("add"), body: <>
          {clicks(null, [t("studio.connectAi.ui.settings"), "Plugins", "Add", "Add MCP server"])}
          <div className="flex flex-col gap-1.5">
            {([[t("studio.connectAi.fieldName"), "yumina"], [t("studio.connectAi.fieldType"), "Streamable HTTP"], ["URL", mcpUrl]] as const).map(([k, v]) => (
              <div key={k} className="flex items-center gap-2.5 text-[13px]">
                <span className="w-12 shrink-0 text-foreground/70">{k}</span>
                <span className="min-w-0 truncate rounded-md border border-border bg-black/25 px-2 py-0.5 font-mono text-[12.5px]">{v}</span>
                {v === mcpUrl && copyIcon("url", mcpUrl, "h-7 w-7")}
              </div>
            ))}
          </div>
          {clicks(t("studio.connectAi.say.filled"), ["Save"])}
        </> },
        { title: stage("auth"), body: clicks(null, [t("studio.connectAi.ui.signIn"), allow]) },
        { title: stage("try"), body: <>{bubble}{whenAsked("Allow")}</> },
      ];
      case "cursor": return [
        { title: stage("add"), body: <>{oneClick(cursorLink, "cursor", false)}{address}</> },
        { title: stage("auth"), body: clicks(null, [t("studio.connectAi.ui.signIn"), allow]) },
        { title: stage("try"), body: <>{clicks(t("studio.connectAi.say.press"), ["Ctrl+L / ⌘L"])}{bubble}{whenAsked("Run")}</> },
      ];
      case "claudeCode": return [
        { title: stage("add"), body: code("cc", `claude mcp add --transport http yumina ${mcpUrl}`) },
        { title: stage("auth"), body: clicks(t("studio.connectAi.say.inClaudeCode"), ["/mcp", "yumina", "Authenticate", allow]) },
        { title: stage("try"), body: <>{code("cc-run", "claude")}{bubble}{whenAsked("Yes")}</> },
      ];
      // Add and sign in are separate commands: Windows PowerShell 5 has no `&&`.
      // `codex mcp add` has no timeout flag and Codex gives a tool 60 s by default: a playtest
      // or picture outlasts that, finishes and is billed, yet Codex reports it failed.
      case "codex": return [
        { title: stage("add"), body: <>
          {code("cx", `codex mcp add yumina --url ${mcpUrl}`)}
          {clicks(t("studio.connectAi.say.addUnder"), ["~/.codex/config.toml", "[mcp_servers.yumina]"])}
          {code("cx-timeout", "tool_timeout_sec = 300", false)}
        </> },
        { title: stage("auth"), body: <>{code("cx-login", "codex mcp login yumina")}{clicks(t("studio.connectAi.say.inBrowser"), [allow])}</> },
        { title: stage("try"), body: <>{code("cx-run", "codex")}{bubble}{whenAsked(allow)}</> },
      ];
      case "deepseek": return [
        { title: stage("token"), body: dsToken ? (
          <div className="flex items-center gap-1.5 text-[13px] text-emerald-400"><Check className="h-3.5 w-3.5" />{t("studio.connectAi.deepseekMade")}</div>
        ) : (
          <button type="button" onClick={() => void makeDsToken()} disabled={dsBusy} data-connect-ai-deepseek-token
            className="inline-flex h-10 w-fit items-center gap-2 rounded-lg bg-primary px-4 text-sm font-bold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
            {dsBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <AiAppLogo app="deepseek" size={17} mono />}{t("studio.connectAi.tokenMake")}
          </button>
        ) },
        { title: stage("start"), body: <>
          {dsToken && <>{clicks(t("studio.connectAi.say.saveAs"), ["yumina.yml"])}{code("ds-file", dshPatch(mcpUrl, dsToken.token), false)}</>}
          {code("ds-cmd", DSH_COMMAND)}
          {clicks(t("studio.connectAi.say.inPage"), [t("studio.connectAi.ui.settings"), t("studio.connectAi.ui.models"), "DeepSeek API key"])}
        </> },
        { title: stage("try"), body: <>{bubble}{whenAsked(allow)}</> },
      ];
    }
  })();

  // Signed-in AIs and account tokens, one row of chips; unplugging a token revokes it.
  const others = [
    ...(connected ?? []).map((ai) => ({ key: ai.clientId, name: ai.name, lastUsedAt: ai.lastUsedAt, unplug: () => disconnect(ai.clientId) })),
    ...accountTokens.map((tok) => ({ key: tok.id, name: tok.name, lastUsedAt: tok.lastUsedAt, unplug: () => revokeAccountToken(tok.id) })),
  ];

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("studio.connectAi.title")}</DialogTitle>
        </DialogHeader>

        <div role="tablist" aria-label={t("studio.connectAi.title")}
          className="-mx-0.5 flex gap-1.5 overflow-x-auto p-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {APPS.map((id) => (
            <button key={id} type="button" role="tab" aria-selected={app === id} onClick={() => setPicked(id)} data-connect-ai-app={id}
              className={cn(
                "flex h-[78px] min-w-[66px] flex-1 shrink-0 flex-col items-center justify-center gap-1.5 whitespace-nowrap rounded-xl border-[1.5px] px-1 text-xs transition-colors",
                app === id ? "border-primary bg-primary/10 font-bold text-foreground" : "border-border bg-foreground/[0.03] font-semibold text-foreground/70 hover:border-foreground/25 hover:text-foreground",
              )}>
              <AiAppLogo app={id} size={28} />
              <span>{t(`studio.connectAi.apps.${id}`)}</span>
            </button>
          ))}
        </div>

        <ol className="flex flex-col">
          {steps.map((s, i) => {
            const isDone = i < done;
            const isNow = i === done;
            const last = i === steps.length - 1;
            const success = last && done >= steps.length;
            return (
              <li key={`${app}-${i}`} className="flex gap-3.5" data-connect-ai-step={i + 1} data-done={isDone || undefined}>
                <div className="flex w-[26px] shrink-0 flex-col items-center">
                  <span className={cn(
                    "flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-xs font-bold",
                    isDone ? "bg-primary text-primary-foreground"
                      : isNow ? "border-2 border-primary text-primary shadow-[0_0_0_4px_rgba(201,162,94,0.14)]"
                      : "border-[1.5px] border-border text-foreground/60",
                  )}>
                    {isDone ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : i + 1}
                  </span>
                  {!last && <span className={cn("my-1.5 min-h-3 w-0.5 flex-1 rounded-full", isDone ? "bg-primary" : "bg-border")} />}
                </div>
                <div className={cn("min-w-0 flex-1", !last && "pb-5")}>
                  <div className="flex min-h-[26px] items-center gap-2">
                    <span className={cn("text-sm font-bold", isDone ? "text-foreground/60" : "text-foreground")}>{s.title}</span>
                    {i === 1 && app !== "deepseek" && done >= 2 && (
                      <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11.5px] font-semibold text-emerald-300">{t("studio.connectAi.authorized")}</span>
                    )}
                  </div>
                  <div className="mt-2 flex flex-col gap-2.5">
                    {success ? (
                      <div className="flex items-center gap-2.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5" data-connect-ai-heard>
                        <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-emerald-400 text-black">
                          <Check className="h-3 w-3" strokeWidth={3.2} />
                        </span>
                        <span className="text-sm font-semibold text-emerald-200">{t("studio.connectAi.heard", { name: heardName })}</span>
                      </div>
                    ) : s.body}
                    {last && !success && slow && (
                      <div className="text-[12px] leading-relaxed text-foreground/70" data-connect-ai-not-found>{t(`studio.connectAi.notFound.${app}`)}</div>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>

        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          {others.length > 0 && <span className="text-xs text-foreground/70">{t("studio.connectAi.connectedTitle")}</span>}
          {others.map((ai) => (
            <span key={ai.key} className="flex items-center gap-1.5 rounded-full border border-border bg-foreground/[0.04] py-0.5 pl-2.5 pr-0.5 text-xs"
              title={ai.lastUsedAt ? t("studio.connectAi.lastUsed", { when: new Date(ai.lastUsedAt).toLocaleString() }) : undefined}>
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
              <span className="max-w-[10rem] truncate font-semibold">{ai.name}</span>
              <button type="button" onClick={() => void ai.unplug()} data-connect-ai-disconnect
                aria-label={`${t("studio.connectAi.disconnect")} ${ai.name}`} title={t("studio.connectAi.disconnect")}
                className="flex h-7 w-7 items-center justify-center rounded-full text-foreground/60 hover:bg-red-500/10 hover:text-red-400">
                <Unplug className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}
          <div className="ml-auto flex items-center gap-3">
            {/* A token belongs to the account that made it: nothing to switch. */}
            {app !== "deepseek" && (
              <button type="button" onClick={() => setShowSwitch((v) => !v)} data-connect-ai-switch
                className="text-xs text-foreground/70 underline-offset-[3px] hover:text-foreground hover:underline">
                {t("studio.connectAi.switchToggle")}
              </button>
            )}
            {worldId && (
              <button type="button" onClick={() => setShowToken((v) => !v)}
                className="text-xs text-foreground/70 underline-offset-[3px] hover:text-foreground hover:underline">
                {t("studio.connectAi.tokenToggle")}
              </button>
            )}
          </div>
        </div>

        {showSwitch && app !== "deepseek" && (
          <ol className="space-y-2">
            {[t("studio.connectAi.switch.step1"), t(`studio.connectAi.switch.apps.${app}`)].map((text, i) => (
              <li key={i} className="flex gap-3">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-[11px] font-semibold text-foreground/70">{i + 1}</span>
                <div className="min-w-0 flex-1 space-y-1.5 text-[12.5px] leading-relaxed">
                  <div>{text}</div>
                  {i === 1 && app === "codex" && code("cx-switch", "codex mcp logout yumina\ncodex mcp login yumina")}
                </div>
              </li>
            ))}
          </ol>
        )}
        {worldId && showToken && <CardTokenPanel worldId={worldId} mcpUrl={mcpUrl} copy={copy} copied={copied} />}
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
    <div className="space-y-2">
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
