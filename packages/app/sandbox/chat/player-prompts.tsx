// In-chat 「提示词」 surfaces (platform chat UI, not creator API):
//   - the quick panel (bottom sheet) opened from the composer's "+" menu,
//   - the refusal / provider-block bar under a refused or blocked turn,
//   - RefusalHost: the same bar as an overlay for custom-UI cards that never
//     render the platform transcript.
//
// All data comes from `api.playerPrompts` (pushed by the host over the UI
// channel): it carries the per-model prompt binding — which of the player's
// installed prompts auto-applies on the current model's family — plus the
// my-prompts list. Toggles go through api.togglePlayerPrompt, navigation
// through api.navigate.

import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Compass, Info, RotateCcw, ScrollText, ShieldAlert, Shuffle, SlidersHorizontal, X } from "lucide-react";
import { twMerge } from "tailwind-merge";
import { PLAY_MODELS, formatModelId } from "@yumina/shared";
import { useYumina } from "../sandbox-context";
import { SandboxPlatformOverlay } from "../platform-overlay-portal";
import { makePromptsT, parseFailureCode } from "./i18n";
import { ModelPickerModal } from "./model-picker-modal";
import type { SandboxMessage } from "./types";

const PROMPTS_HUB = "/app/prompts";
const SETTINGS_PROMPTS = "/app/settings#prompts";

// ─── Tiny shared store (panel open state, dismissals) ────────────────────────

type Listener = () => void;
const listeners = new Set<Listener>();
let panelOpen = false;
/** Refusal bars the player closed ("not a refusal"), by message id. */
const dismissedRefusals = new Set<string>();
let version = 0;

function emit() {
  version++;
  for (const l of listeners) l();
}
function subscribe(l: Listener) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
function useStoreVersion() {
  return useSyncExternalStore(subscribe, () => version, () => version);
}

export function openPromptsPanel() { panelOpen = true; emit(); }
export function closePromptsPanel() { panelOpen = false; emit(); }

// ─── Helpers ─────────────────────────────────────────────────────────

function modelName(id: string | null | undefined): string {
  if (!id) return "";
  return PLAY_MODELS.find((m) => m.id === id)?.name ?? formatModelId(id);
}

function usePromptsT() {
  const api = useYumina();
  return useMemo(() => makePromptsT(api.language), [api.language]);
}

/** Sub-label for the composer 「提示词」 row: 「自动【X】」 / 「开着 N 条」. */
export function usePromptsStatus(): string {
  const api = useYumina();
  const t = usePromptsT();
  const pp = api.playerPrompts;
  if (!pp) return "";
  if (pp.boundPromptName) return t("promptsStatusBound", { prompt: pp.boundPromptName });
  const on = pp.prompts.filter((p) => p.enabled).length;
  return pp.prompts.length === 0 ? t("promptsStatusNone") : t("promptsStatusCount", { n: on });
}

/** The quick panel is only useful to a signed-in player in a real session. */
export function usePromptsAvailable(): boolean {
  const api = useYumina();
  return !!api.playerPrompts && api.mode === "session" && !api.readOnly;
}

function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50 ${
        checked ? "border-primary/60 bg-primary" : "border-border bg-muted"
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full shadow transition-transform ${
          checked ? "translate-x-[18px] bg-primary-foreground" : "translate-x-[3px] bg-muted-foreground/70"
        }`}
      />
    </button>
  );
}

// ─── Quick panel ─────────────────────────────────────────────────────

type PanelPrompt = NonNullable<ReturnType<typeof useYumina>["playerPrompts"]>["prompts"][number];

/** Loose prompts first, then one group per folder (an installed pack is a folder). */
function groupPrompts(prompts: PanelPrompt[]): { name: string | null; items: PanelPrompt[] }[] {
  const loose: PanelPrompt[] = [];
  const groups = new Map<string, PanelPrompt[]>();
  for (const p of prompts) {
    if (!p.group) { loose.push(p); continue; }
    const list = groups.get(p.group);
    if (list) list.push(p);
    else groups.set(p.group, [p]);
  }
  const out: { name: string | null; items: PanelPrompt[] }[] = [];
  if (loose.length > 0) out.push({ name: null, items: loose });
  for (const [name, items] of groups) out.push({ name, items });
  return out;
}

/** Mount once per chat surface (message-input does). */
export function PromptsQuickSheet() {
  useStoreVersion();
  const api = useYumina();
  const t = usePromptsT();
  const pp = api.playerPrompts;
  const groups = useMemo(() => groupPrompts(pp?.prompts ?? []), [pp?.prompts]);

  useEffect(() => {
    if (!panelOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closePromptsPanel(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  if (!panelOpen || !pp) return null;
  const onCount = pp.prompts.filter((p) => p.enabled).length;
  const model = modelName(api.selectedModel) || t("currentModelFallback");
  const go = (path: string) => { closePromptsPanel(); api.navigate(path); };

  return (
    <SandboxPlatformOverlay>
      <div className="fixed inset-0 z-[9998]" role="dialog" aria-modal="true" aria-label={t("promptsLabel")}>
        <button
          type="button"
          aria-label={t("close")}
          onClick={closePromptsPanel}
          className="absolute inset-0 h-full w-full cursor-default bg-black/50 backdrop-blur-sm"
          style={{ animation: "ppFade 0.15s ease-out" }}
        />
        <div
          className="absolute inset-x-0 bottom-0 mx-auto flex max-h-[85dvh] max-w-md flex-col rounded-t-3xl border-t border-border bg-popover/95 text-popover-foreground shadow-2xl backdrop-blur-xl"
          style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom, 0px))", animation: "ppUp 0.22s cubic-bezier(0.16, 1, 0.3, 1)" }}
        >
          <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-muted-foreground/25" aria-hidden="true" />
          <div className="flex items-center gap-2 pb-1 pl-5 pr-3 pt-2">
            <h2 className="min-w-0 flex-1 text-base font-semibold text-foreground">{t("promptsLabel")}</h2>
            <button
              type="button"
              onClick={closePromptsPanel}
              aria-label={t("close")}
              className="flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 pb-1 pt-2">
            {/* Per-model binding status for the current model. */}
            <section className={`rounded-2xl border p-3.5 ${pp.boundPromptName ? "border-primary/35 bg-primary/[0.06]" : "border-border bg-muted/30"}`}>
              <div className="text-xs text-muted-foreground">{t("currentModelIs", { model })}</div>
              <div className="mt-1 flex items-center gap-2">
                <span className={`min-w-0 flex-1 truncate text-sm font-medium ${pp.boundPromptName ? "text-foreground" : "text-muted-foreground"}`}>
                  {pp.boundPromptName ? t("autoUseBound", { prompt: pp.boundPromptName }) : t("noBinding")}
                </span>
                <button
                  type="button"
                  onClick={() => go(SETTINGS_PROMPTS)}
                  className="shrink-0 text-xs font-medium text-primary transition-opacity hover:opacity-80"
                >
                  {t("manageBinding")}
                </button>
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-muted/20">
              <div className="flex items-baseline justify-between px-3.5 pb-1 pt-3">
                <span className="text-sm font-semibold text-foreground">{t("myPrompts")}</span>
                {pp.prompts.length > 0 && <span className="text-xs text-muted-foreground">{t("myPromptsOn", { n: onCount })}</span>}
              </div>
              {pp.prompts.length === 0 ? (
                <p className="px-3.5 pb-3.5 pt-1 text-xs leading-relaxed text-muted-foreground">{t("myPromptsEmpty")}</p>
              ) : (
                <div className="pb-1.5">
                  {groups.map((g) => (
                    <div key={g.name ?? ""}>
                      {g.name && (
                        <div className="truncate px-3.5 pb-0.5 pt-2.5 text-[11px] font-medium text-muted-foreground/80">{g.name}</div>
                      )}
                      {g.items.map((p) => (
                        <div key={p.id} className="flex min-h-11 items-center gap-2.5 px-3.5 py-1.5">
                          <span className={`min-w-0 flex-1 truncate text-sm ${p.enabled ? "text-foreground" : "text-muted-foreground"}`}>{p.name}</span>
                          <Switch
                            checked={p.enabled}
                            label={p.name}
                            onChange={(v) => void api.togglePlayerPrompt(p.id, v)}
                          />
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>

          <div className="flex gap-2 px-4 pt-3">
            <button
              type="button"
              onClick={() => go(SETTINGS_PROMPTS)}
              className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl border border-border px-3 text-sm text-foreground/85 transition-colors hover:border-primary/40 hover:text-foreground"
            >
              <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
              {t("fullSettings")}
            </button>
            <button
              type="button"
              onClick={() => go(PROMPTS_HUB)}
              className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl border border-primary/30 bg-primary/10 px-3 text-sm font-medium text-primary transition-colors hover:bg-primary/20"
            >
              <Compass className="h-4 w-4" />
              {t("toHub")}
            </button>
          </div>
          <style>{`
            @keyframes ppFade { from { opacity: 0; } to { opacity: 1; } }
            @keyframes ppUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
          `}</style>
        </div>
      </div>
    </SandboxPlatformOverlay>
  );
}

// ─── Refusal / provider-block bar ────────────────────────────────────

export type RefusalKind = "refused" | "blocked";

export function RefusalBar({
  kind,
  dismissKey,
  onRetry,
  className,
}: {
  kind: RefusalKind;
  /** Message id: closing a "refused" bar hides it for this message. */
  dismissKey?: string;
  /** Regenerate the refused reply, or retry the blocked turn. */
  onRetry: () => void;
  className?: string;
}) {
  useStoreVersion();
  const api = useYumina();
  const t = usePromptsT();
  const pp = api.playerPrompts;
  const [pickerOpen, setPickerOpen] = useState(false);
  if (dismissKey && dismissedRefusals.has(dismissKey)) return null;

  const eligible = !!pp?.eligible;
  const bound = !!pp?.boundPromptName;
  // With no prompt bound to this model, an eligible player is nudged to pick one;
  // otherwise the useful action is a plain retry.
  const showPick = eligible && !bound;
  const disabled = api.isStreaming || api.readOnly;
  const model = modelName(api.selectedModel) || t("currentModelFallback");
  const goPick = () => api.navigate(PROMPTS_HUB);

  const picker = (
    <ModelPickerModal
      open={pickerOpen}
      onClose={() => setPickerOpen(false)}
      selectedModel={api.selectedModel}
      title={t("pickModelTitle")}
      subtitle={t("pickModelSub")}
      onSelectModel={(id) => {
        setPickerOpen(false);
        api.setModel(id);
        // setModel is a fire-and-forget message; let the host apply it first.
        window.setTimeout(onRetry, 250);
      }}
    />
  );

  const btn = "inline-flex min-h-8 items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";

  if (kind === "blocked") {
    return (
      <div className={twMerge("play-turn-error play-refusal-bar mt-2 w-full min-w-0 rounded-xl border border-destructive/30 bg-destructive/10 px-3.5 py-3 text-xs text-destructive", className)}>
        <div className="flex items-start gap-2">
          <ShieldAlert className="mt-px h-4 w-4 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="font-semibold leading-snug">{t("blockedTitle")}</div>
            <div className="mt-1 leading-relaxed text-destructive/80">{t("blockedSub", { model })}</div>
          </div>
        </div>
        <div className="mt-2.5 flex flex-wrap gap-2 pl-6">
          <button type="button" disabled={disabled} onClick={() => setPickerOpen(true)} className={`${btn} border border-destructive/40 bg-destructive/15 hover:bg-destructive/25`}>
            <Shuffle className="h-3.5 w-3.5" aria-hidden="true" />
            {t("switchModelRetry")}
          </button>
          {showPick ? (
            <button type="button" disabled={disabled} onClick={goPick} className={`${btn} border border-destructive/30 hover:bg-destructive/10`}>
              {t("pickOne")}
            </button>
          ) : (
            <button type="button" disabled={disabled} onClick={onRetry} className={`${btn} border border-destructive/30 hover:bg-destructive/10`}>
              {t("retry")}
            </button>
          )}
        </div>
        {picker}
      </div>
    );
  }

  return (
    <div className={twMerge("play-refusal-bar relative mt-2 w-full min-w-0 rounded-xl border border-border bg-muted/50 px-3.5 py-2.5 text-xs", dismissKey && "pr-10", className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="inline-flex min-h-8 items-center gap-1.5 font-medium text-muted-foreground">
          <Info className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {t("refusedLabel")}
        </span>
        <div className="flex flex-wrap gap-2">
          {showPick ? (
            <button type="button" disabled={disabled} onClick={goPick} className={`${btn} bg-primary text-primary-foreground hover:opacity-90`}>
              <ScrollText className="h-3.5 w-3.5" aria-hidden="true" />
              {t("pickOne")}
            </button>
          ) : (
            <button type="button" disabled={disabled} onClick={onRetry} className={`${btn} border border-primary/30 bg-primary/10 text-primary hover:bg-primary/20`}>
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              {t("retry")}
            </button>
          )}
          <button type="button" disabled={disabled} onClick={() => setPickerOpen(true)} className={`${btn} border border-border text-foreground/80 hover:border-primary/40 hover:text-foreground`}>
            <Shuffle className="h-3.5 w-3.5" aria-hidden="true" />
            {t("switchModel")}
          </button>
        </div>
      </div>
      {dismissKey && (
        <button
          type="button"
          title={t("notRefusal")}
          aria-label={t("notRefusal")}
          onClick={() => { dismissedRefusals.add(dismissKey); emit(); }}
          className="absolute right-1.5 top-1.5 flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
      {picker}
    </div>
  );
}

// ─── Turn classification (shared by the bubble, the list banner and the host) ──

export function isRefusedReply(message: SandboxMessage): boolean {
  if (message.role !== "assistant") return false;
  const swipe = message.swipes?.[message.activeSwipeIndex ?? 0] as { refusal?: boolean } | undefined;
  return swipe?.refusal === true || (message as { refusal?: boolean }).refusal === true;
}

export function isBlockedTurn(message: SandboxMessage): boolean {
  return message.role !== "system" && message.status === "failed" && parseFailureCode(message.errorMessage).code === "CONTENT_FILTER";
}

/** Retry the trailing turn the way the server expects: regenerate an
 *  assistant reply, or continue from a user row. */
export function useRetryTrailingTurn() {
  const api = useYumina();
  return () => {
    const last = api.messages[api.messages.length - 1] as unknown as SandboxMessage | undefined;
    if (last?.role === "assistant") api.regenerateMessage(last.id);
    else api.continueLastMessage();
  };
}

// ─── Host overlay for custom-UI cards ────────────────────────────────

let transcriptMounts = 0;
/** MessageList calls this so RefusalHost knows the transcript shows the bar itself. */
export function useRegisterTranscript() {
  useLayoutEffect(() => {
    transcriptMounts++;
    emit();
    return () => { transcriptMounts--; emit(); };
  }, []);
}

/**
 * Cards whose root never renders the platform transcript still get the bar:
 * as a bottom overlay, like ModelFallbackHost. Only for the trailing turn.
 */
export function RefusalHost() {
  useStoreVersion();
  const api = useYumina();
  const retry = useRetryTrailingTurn();
  if (transcriptMounts > 0 || api.mode !== "session" || api.readOnly || api.isStreaming) return null;
  const last = api.messages[api.messages.length - 1] as unknown as SandboxMessage | undefined;
  let kind: RefusalKind | null = null;
  let key: string | undefined;
  if (last && isBlockedTurn(last)) kind = "blocked";
  else if (last && isRefusedReply(last)) { kind = "refused"; key = last.id; }
  else if (api.error && api.errorCode === "CONTENT_FILTER") kind = "blocked";
  if (!kind || (key && dismissedRefusals.has(key))) return null;
  const dismissKey = key ?? (last ? `host:${last.id}` : "host:error");
  if (dismissedRefusals.has(dismissKey)) return null;
  return (
    <SandboxPlatformOverlay>
      <div className="fixed inset-x-0 bottom-0 z-[9000] mx-auto max-w-xl rounded-t-lg border border-border/60 bg-background/95 px-4 py-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <RefusalBar kind={kind} dismissKey={dismissKey} onRetry={retry} className="mt-0" />
      </div>
    </SandboxPlatformOverlay>
  );
}
