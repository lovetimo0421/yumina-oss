import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2, CheckCircle2, XCircle, Loader2, X, Plug, Send, Sliders, Eye, EyeOff } from "lucide-react";
import { feedback } from "@/lib/feedback";
import { FieldError } from "@/components/ui/field-error";
import { useTransientFlag } from "@/hooks/use-transient-flag";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useUserProfileStore } from "@/stores/user-profile";
import { useConfigStore } from "@/stores/config";
import { composeSelectedModelId } from "@/lib/model-id";

const apiBase = import.meta.env.VITE_API_URL || "";

type PromptPostProcessing =
  | "none" | "merge" | "merge_tools" | "semi" | "semi_tools" | "strict" | "strict_tools" | "single";

interface ApiKeyMetadata {
  models?: string[];
  includeBody?: Record<string, unknown>;
  excludeBody?: string[];
  includeHeaders?: Record<string, string>;
  promptPostProcessing?: PromptPostProcessing;
  defaultModel?: string;
}

interface ApiKeyEntry {
  id: string;
  provider: string;
  label: string;
  baseUrl: string | null;
  metadata: ApiKeyMetadata | null;
  createdAt: string;
}

/** Provider metadata. The display `label` (and the help-link `helpLabel`) lives
 *  in the locale files under `apiKeys.providers.*`; this table only carries
 *  what's not user-facing prose: id, placeholder, help URL, color classes. */
const PROVIDERS = [
  { value: "custom",     placeholder: "sk-... (your proxy key)", helpUrl: null,                                              helpLabel: null,             color: "bg-amber-500/15 text-amber-300",  ring: "border-amber-500/30 bg-amber-500/5" },
  { value: "openrouter", placeholder: "sk-or-v1-...",            helpUrl: "https://openrouter.ai/keys",                       helpLabel: "OpenRouter",     color: "bg-violet-500/15 text-violet-300", ring: "border-violet-500/30 bg-violet-500/5" },
  { value: "anthropic",  placeholder: "sk-ant-...",              helpUrl: "https://console.anthropic.com/settings/keys",      helpLabel: "Anthropic",      color: "bg-orange-500/15 text-orange-300", ring: "border-orange-500/30 bg-orange-500/5" },
  { value: "openai",     placeholder: "sk-...",                  helpUrl: "https://platform.openai.com/api-keys",             helpLabel: "OpenAI",         color: "bg-emerald-500/15 text-emerald-300", ring: "border-emerald-500/30 bg-emerald-500/5" },
  { value: "google",     placeholder: "AIza...",                 helpUrl: "https://aistudio.google.com/apikey",               helpLabel: "Google AI",      color: "bg-sky-500/15 text-sky-300",       ring: "border-sky-500/30 bg-sky-500/5" },
  { value: "ollama",     placeholder: "https://your-ollama-tunnel.example.com", helpUrl: "https://ollama.com",                   helpLabel: "Ollama",         color: "bg-blue-500/15 text-blue-300",     ring: "border-blue-500/30 bg-blue-500/5" },
] as const;

/** Common OpenAI-compatible providers that don't have their own dropdown entry.
 *  Clicking a preset fills baseUrl in the New profile form. The user still pastes
 *  their own API key. The stored row is provider="custom" with this baseUrl. */
const CUSTOM_PRESETS: Array<{ label: string; baseUrl: string }> = [
  { label: "DeepSeek",     baseUrl: "https://api.deepseek.com/v1" },
  { label: "xAI (Grok)",   baseUrl: "https://api.x.ai/v1" },
  { label: "Mistral",      baseUrl: "https://api.mistral.ai/v1" },
  { label: "Groq",         baseUrl: "https://api.groq.com/openai/v1" },
  { label: "Together",     baseUrl: "https://api.together.xyz/v1" },
  { label: "Fireworks",    baseUrl: "https://api.fireworks.ai/inference/v1" },
  { label: "Moonshot",     baseUrl: "https://api.moonshot.cn/v1" },
];

/** Post-processing modes. Labels/hints live in `apiKeys.postProcessing.*` —
 *  see `postProcOptions(t)` for the localized array used at render time. */
const POST_PROC_VALUES: PromptPostProcessing[] = [
  "none", "merge", "merge_tools", "semi", "semi_tools", "strict", "strict_tools", "single",
];

/** Map a post-processing value to its locale subkey suffix (e.g. `merge_tools` → `mergeTools`). */
const POST_PROC_KEY: Record<PromptPostProcessing, string> = {
  none: "none",
  merge: "merge",
  merge_tools: "mergeTools",
  semi: "semi",
  semi_tools: "semiTools",
  strict: "strict",
  strict_tools: "strictTools",
  single: "single",
};

/** i18next's TFunction has very strict key typing that fights dynamic lookups,
 *  so these helpers accept a loose translator (matching the `t(... as any)`
 *  pattern used elsewhere in this codebase for runtime-built keys). */
type Translator = (k: any) => string;

function postProcOptions(t: Translator): Array<{ value: PromptPostProcessing; label: string; hint: string }> {
  return POST_PROC_VALUES.map((value) => {
    const key = POST_PROC_KEY[value];
    return {
      value,
      label: t(`apiKeys.postProcessing.${key}Label`),
      hint: t(`apiKeys.postProcessing.${key}Hint`),
    };
  });
}

/** Localized provider label, sourced from `apiKeys.providers.<value>`. */
function providerLabel(t: Translator, value: string): string {
  return t(`apiKeys.providers.${value}`);
}

function isHostedBrowserOrigin(): boolean {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host !== "localhost" && host !== "127.0.0.1" && host !== "::1";
}

/** Put a row back where it was — used by the undo of a deferred delete (R5b). */
function insertAt<T>(list: T[], index: number, item: T): T[] {
  const next = list.slice();
  next.splice(Math.max(0, Math.min(index, next.length)), 0, item);
  return next;
}

function isLoopbackUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw.trim());
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0";
  } catch {
    return false;
  }
}

function OllamaUrlHelp({ showLoopbackWarning }: { showLoopbackWarning: boolean }) {
  const { t } = useTranslation("profile");

  return (
    <div className="rounded-md border border-blue-400/25 bg-blue-500/[0.04] p-3 text-[11px] text-blue-100/85">
      <div className="mb-2 font-semibold text-blue-100">{t("apiKeys.ollamaHelpTitle")}</div>
      <ol className="list-decimal space-y-1 pl-4">
        <li>
          {t("apiKeys.ollamaHelpStep1")}{" "}
          <code className="rounded bg-black/30 px-1 py-0.5 text-blue-50">cloudflared tunnel --url http://localhost:11434</code>
        </li>
        <li>{t("apiKeys.ollamaHelpStep2")}</li>
        <li>{t("apiKeys.ollamaHelpStep3")}</li>
        <li>{t("apiKeys.ollamaHelpStep4")}</li>
      </ol>
      {showLoopbackWarning && (
        <div className="mt-2 rounded border border-amber-400/30 bg-amber-400/10 px-2 py-1.5 text-amber-100">
          {t("apiKeys.ollamaLocalhostWarning")}
        </div>
      )}
    </div>
  );
}

export function ApiKeysSettings() {
  const { t } = useTranslation("profile");
  const profile = useUserProfileStore((s) => s.profile);
  const forceFetchProfile = useUserProfileStore((s) => s.forceFetchProfile);

  const [keys, setKeys] = useState<ApiKeyEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeProvider, setActiveProvider] = useState<string>("custom");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creatingFor, setCreatingFor] = useState<string | null>(null);

  const serverActiveKeyId = (profile?.preferences?.activeApiKeyId as string | undefined) ?? null;
  // R1: the Active chip flips before the PATCH lands. `undefined` means "trust the server".
  const [optimisticActiveId, setOptimisticActiveId] = useState<string | null | undefined>(undefined);
  const activeKeyId = optimisticActiveId !== undefined ? optimisticActiveId : serverActiveKeyId;

  const fetchKeys = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/keys`, { credentials: "include" });
      if (res.ok) {
        const { data } = await res.json();
        setKeys(data);
      }
    } catch { /* silent */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchKeys(); }, [fetchKeys]);

  const profilesForProvider = useMemo(
    () => keys.filter((k) => k.provider === activeProvider),
    [keys, activeProvider],
  );

  // Track which providers we've auto-opened the create form for, so cancelling
  // doesn't immediately re-open it.
  const [autoOpened, setAutoOpened] = useState<Set<string>>(new Set());

  /** Single source of truth for picking what to show given a provider:
   *  - existing profile? select the first one
   *  - no profile yet, never auto-opened? open the create form
   *  - no profile, already auto-opened? show the empty state with the New profile button */
  const switchTo = useCallback((nextProvider: string) => {
    const list = keys.filter((k) => k.provider === nextProvider);
    setActiveProvider(nextProvider);
    if (list.length > 0) {
      setCreatingFor(null);
      setSelectedId(list[0]!.id);
    } else if (!autoOpened.has(nextProvider)) {
      setAutoOpened((prev) => new Set(prev).add(nextProvider));
      setCreatingFor(nextProvider);
      setSelectedId(null);
    } else {
      setCreatingFor(null);
      setSelectedId(null);
    }
  }, [keys, autoOpened]);

  // First-load: once `keys` arrives, run the same logic for the initial provider.
  const [initialApplied, setInitialApplied] = useState(false);
  useEffect(() => {
    if (loading || initialApplied) return;
    setInitialApplied(true);
    switchTo(activeProvider);
  }, [loading, initialApplied, activeProvider, switchTo]);

  const setConfig = useConfigStore((s) => s.setConfig);

  // R1: flip the chip first, roll back to server truth and offer Retry if the PATCH fails.
  const handleToggleActive: (id: string, currentlyActive: boolean) => Promise<void> = useCallback(
    async (id: string, currentlyActive: boolean) => {
      const nextActiveId = currentlyActive ? null : id;
      setOptimisticActiveId(nextActiveId);
      try {
        const res = await fetch(`${apiBase}/api/users/me`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ preferences: { activeApiKeyId: nextActiveId } }),
        });
        if (res.ok) {
          await forceFetchProfile();
          setOptimisticActiveId(undefined);
          // When activating, push this profile's default model into the global
          // chat-model state so chat actually uses it.
          if (!currentlyActive) {
            const target = keys.find((k) => k.id === id);
            const dm = target?.metadata?.defaultModel;
            if (target && dm && dm.trim().length > 0) {
              const composed = composeSelectedModelId(target.provider, dm);
              if (composed) setConfig("selectedModel", composed);
            }
          }
          return;
        }
        setOptimisticActiveId(undefined);
        feedback.error(t("apiKeys.activeUpdateFailed"), {
          label: t("action.retry", { ns: "common" }),
          onClick: () => void handleToggleActive(id, currentlyActive),
        });
      } catch {
        setOptimisticActiveId(undefined);
        feedback.error(t("apiKeys.activeUpdateFailed"), {
          label: t("action.retry", { ns: "common" }),
          onClick: () => void handleToggleActive(id, currentlyActive),
        });
      }
    },
    [forceFetchProfile, keys, setConfig, t],
  );

  /** Runs when the undo window closes: the row really goes. Put it back if the server refuses. */
  const commitDelete: (entry: ApiKeyEntry, index: number, wasActive: boolean) => Promise<void> = useCallback(
    async (entry: ApiKeyEntry, index: number, wasActive: boolean) => {
      try {
        const res = await fetch(`${apiBase}/api/keys/${entry.id}`, { method: "DELETE", credentials: "include" });
        if (!res.ok) throw new Error("delete failed");
        if (wasActive) {
          // Clear active reference upstream
          await fetch(`${apiBase}/api/users/me`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ preferences: { activeApiKeyId: null } }),
          });
          await forceFetchProfile();
          setOptimisticActiveId(undefined);
        }
      } catch {
        setKeys((prev) => (prev.some((k) => k.id === entry.id) ? prev : insertAt(prev, index, entry)));
        if (wasActive) setOptimisticActiveId(undefined);
        feedback.error(t("apiKeys.deleteFailed"), {
          label: t("action.retry", { ns: "common" }),
          onClick: () => void commitDelete(entry, index, wasActive),
        });
      }
    },
    [forceFetchProfile, t],
  );

  // R5(b): the row leaves the list now and the DELETE waits out the undo window,
  // so an accidental delete costs nothing — there is no restore endpoint.
  const handleDelete = useCallback((id: string) => {
    const index = keys.findIndex((k) => k.id === id);
    const entry = keys[index];
    if (!entry) return;
    const wasActive = activeKeyId === id;
    setKeys((prev) => prev.filter((k) => k.id !== id));
    if (selectedId === id) setSelectedId(null);
    if (wasActive) setOptimisticActiveId(null);
    feedback.undo(
      t("apiKeys.profileDeleted"),
      () => {
        setKeys((prev) => (prev.some((k) => k.id === entry.id) ? prev : insertAt(prev, index, entry)));
        setSelectedId(entry.id);
        if (wasActive) setOptimisticActiveId(undefined);
      },
      { onCommit: () => void commitDelete(entry, index, wasActive) },
    );
  }, [keys, selectedId, activeKeyId, commitDelete, t]);

  // Defensive fallback: even if `selectedId` is stale (e.g. carried over from a
  // different provider during a state transition), pick the first profile of the
  // active provider so the editor always renders something coherent.
  const isCreating = creatingFor === activeProvider;
  const selected = isCreating
    ? null
    : (profilesForProvider.find((k) => k.id === selectedId) ?? profilesForProvider[0] ?? null);

  // Whenever the displayed profile diverges from selectedId, write selectedId back
  // so chip highlighting and the Active button reflect the same row the editor shows.
  useEffect(() => {
    if (isCreating) return;
    const target = selected?.id ?? null;
    if (target !== selectedId) setSelectedId(target);
  }, [selected, selectedId, isCreating]);

  return (
    <div className="profile-overview-glass profile-overview-glass--soft rounded-2xl p-6 space-y-5">
      <div className="flex items-center gap-2">
        <Plug className="h-4 w-4 text-violet-300" />
        <h3 className="text-sm font-semibold text-main">{t("apiKeys.title")}</h3>
      </div>
      <p className="-mt-3 text-xs text-sub">
        {t("apiKeys.subtitle")}
      </p>

      {/* ── Source picker ── */}
      <div>
        <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-sub/60">
          {t("apiKeys.source")}
        </label>
        <Select
          value={activeProvider}
          onValueChange={switchTo}
          options={PROVIDERS.map((p) => ({
            value: p.value,
            label: providerLabel(t, p.value),
          }))}
          triggerClassName="profile-overview-input-surface border-white/10"
        />
      </div>

      {/* ── Profile list (chips) ── */}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <label className="text-[11px] font-medium uppercase tracking-wider text-sub/60">
            {t("apiKeys.profiles")} {profilesForProvider.length > 0 && <span className="text-sub/40">({profilesForProvider.length})</span>}
          </label>
          <button
            type="button"
            onClick={() => { setCreatingFor(activeProvider); setSelectedId(null); }}
            className="flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] font-medium text-sub transition-colors hover:bg-white/[0.06] hover:text-main"
          >
            <Plus className="h-3 w-3" />
            {t("apiKeys.newProfile")}
          </button>
        </div>

        {loading ? (
          <div className="flex justify-center py-3">
            <Loader2 className="h-4 w-4 animate-spin text-sub/40" />
          </div>
        ) : profilesForProvider.length === 0 && !isCreating ? (
          <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.01] p-4 text-center text-xs text-sub/50">
            {t("apiKeys.emptyState")}
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {profilesForProvider.map((k) => {
              const isSelected = selectedId === k.id && !isCreating;
              const isActive = activeKeyId === k.id;
              return (
                <button
                  key={k.id}
                  type="button"
                  onClick={() => { setSelectedId(k.id); setCreatingFor(null); }}
                  className={`group flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-all ${
                    isSelected
                      ? "border-violet-400/40 bg-violet-500/10 text-violet-200"
                      : "border-white/10 bg-white/[0.02] text-sub hover:border-white/20 hover:text-main"
                  }`}
                >
                  {isActive && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.6)]" />}
                  <span>{k.label}</span>
                </button>
              );
            })}
            {isCreating && (
              <span className="flex items-center gap-1.5 rounded-full border border-emerald-400/40 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-200">
                <Plus className="h-3 w-3" /> {t("apiKeys.newPlaceholder")}
              </span>
            )}
          </div>
        )}
      </div>

      {/* ── Editor ── */}
      {isCreating ? (
        <NewProfileForm
          key={activeProvider}
          provider={activeProvider}
          onCancel={() => setCreatingFor(null)}
          onCreated={async (id) => {
            setCreatingFor(null);
            await fetchKeys();
            setSelectedId(id);
          }}
        />
      ) : selected ? (
        <ProfileEditor
          key={selected.id}
          entry={selected}
          isActive={activeKeyId === selected.id}
          onToggleActive={() => handleToggleActive(selected.id, activeKeyId === selected.id)}
          onDelete={() => handleDelete(selected.id)}
          onSaved={async () => { await fetchKeys(); }}
        />
      ) : null}
    </div>
  );
}

// ─── New Profile Form ────────────────────────────────────────────────

function NewProfileForm({
  provider,
  onCancel,
  onCreated,
}: {
  provider: string;
  onCancel: () => void;
  onCreated: (id: string) => Promise<void>;
}) {
  const { t } = useTranslation("profile");
  const meta = PROVIDERS.find((p) => p.value === provider)!;
  const isCustom = provider === "custom";
  const isOllama = provider === "ollama";

  const [label, setLabel] = useState("Default");
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);
  // R4: creation problems print in the form, next to what caused them.
  const [baseUrlError, setBaseUrlError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const ollamaLoopbackOnHosted = isOllama && isHostedBrowserOrigin() && isLoopbackUrl(key);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBaseUrlError(null);
    setFormError(null);
    const keyValue = key.trim();
    if (!keyValue) return;
    // Create is already disabled here, and the help card shows the amber warning.
    if (isOllama && isHostedBrowserOrigin() && isLoopbackUrl(keyValue)) return;
    if (isCustom && !baseUrl.trim()) {
      setBaseUrlError(t("apiKeys.baseUrlRequired"));
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        provider, label: label.trim() || "Default", key: keyValue,
      };
      if (isCustom) body.baseUrl = baseUrl.trim();
      const res = await fetch(`${apiBase}/api/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (res.ok) {
        // No pill: the new profile arrives as a selected chip with its editor open.
        const { data } = await res.json();
        await onCreated(data.id);
      } else {
        const { error } = await res.json().catch(() => ({ error: null }));
        // Server-side error strings aren't in our locale catalog — surface raw if present, else fall back to translated default.
        setFormError(typeof error === "string" && error.trim() ? error : t("apiKeys.createFailed"));
      }
    } catch {
      setFormError(t("apiKeys.createFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} autoComplete="off" className="rounded-xl border border-white/10 bg-white/[0.02] p-4 space-y-3">
      {/* Honeypot to defeat aggressive password-manager autofill on Chrome/Edge */}
      <input type="text" name="username" autoComplete="username" defaultValue="" className="hidden" tabIndex={-1} aria-hidden="true" />
      <input type="password" name="password" autoComplete="current-password" defaultValue="" className="hidden" tabIndex={-1} aria-hidden="true" />

      <h4 className="text-xs font-semibold text-main">{t("apiKeys.newFormTitle", { provider: providerLabel(t, provider) })}</h4>

      <div>
        <label className="mb-1 block text-[11px] text-sub/60">{t("apiKeys.profileName")}</label>
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={t("apiKeys.profileNamePlaceholder")}
          className="profile-overview-input-surface border-white/10"
          maxLength={64}
          autoComplete="off"
          name="profile-label"
        />
      </div>

      {isCustom && (
        <>
          {/* Quick-fill presets — common OpenAI-compatible providers we don't expose
              as their own dropdown entry. Tap one to fill base URL + suggest a label. */}
          <div>
            <label className="mb-1 block text-[11px] text-sub/60">{t("apiKeys.quickFill")}</label>
            <div className="flex flex-wrap gap-1.5">
              {CUSTOM_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => {
                    setBaseUrl(p.baseUrl);
                    if (label === "Default") setLabel(p.label);
                  }}
                  className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    baseUrl === p.baseUrl
                      ? "border-amber-400/50 bg-amber-400/10 text-amber-200"
                      : "border-white/10 bg-white/[0.02] text-sub hover:border-white/20 hover:text-main"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-[11px] text-sub/60">{t("apiKeys.baseUrl")}</label>
            <Input
              value={baseUrl}
              onChange={(e) => { setBaseUrl(e.target.value); if (baseUrlError) setBaseUrlError(null); }}
              placeholder={t("apiKeys.baseUrlPlaceholder")}
              className="profile-overview-input-surface border-white/10"
              autoComplete="off"
              name="profile-base-url"
              aria-invalid={!!baseUrlError}
              aria-describedby={baseUrlError ? "new-profile-base-url-error" : undefined}
            />
            <FieldError id="new-profile-base-url-error" message={baseUrlError} />
            <p className="mt-1 text-[10px] text-sub/40">
              {t("apiKeys.customBaseUrlHint")}
            </p>
          </div>
        </>
      )}

      <div>
        <label className="mb-1 block text-[11px] text-sub/60">
          {isOllama ? t("apiKeys.ollamaUrlLabel") : t("apiKeys.apiKeyLabel")}{" "}
          {isCustom && <span className="text-sub/40">{t("apiKeys.apiKeyOptional")}</span>}
        </label>
        <Input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={meta.placeholder}
          type={isOllama ? "text" : "password"}
          className="profile-overview-input-surface border-white/10 font-mono text-xs"
          autoComplete="new-password"
          name="profile-api-key"
        />
        {isOllama && <div className="mt-2"><OllamaUrlHelp showLoopbackWarning={ollamaLoopbackOnHosted} /></div>}
        {!isCustom && !isOllama && meta.helpUrl && (
          <p className="mt-1 text-[10px] text-sub/40">
            {t("apiKeys.apiKeyGetFrom")}{" "}
            <a href={meta.helpUrl} target="_blank" rel="noopener noreferrer" className="text-primary underline">
              {meta.helpLabel}
            </a>
          </p>
        )}
      </div>

      <FieldError message={formError} />

      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>{t("apiKeys.cancel")}</Button>
        <Button type="submit" size="sm" disabled={busy || (!isOllama && !key.trim()) || (isOllama && (!key.trim() || ollamaLoopbackOnHosted)) || (isCustom && !baseUrl.trim())}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t("apiKeys.create")}
        </Button>
      </div>
    </form>
  );
}

// ─── Profile Editor ──────────────────────────────────────────────────

type ConnectionState = "idle" | "connecting" | "connected" | "unavailable" | "failed";

function ProfileEditor({
  entry,
  isActive,
  onToggleActive,
  onDelete,
  onSaved,
}: {
  entry: ApiKeyEntry;
  isActive: boolean;
  onToggleActive: () => void;
  onDelete: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation("profile");
  const isCustom = entry.provider === "custom";
  const isOllama = entry.provider === "ollama";
  const meta = PROVIDERS.find((p) => p.value === entry.provider)!;
  const postProcChoices = useMemo(() => postProcOptions(t), [t]);

  // The global "current chat model" — what the chat actually sends. We bind this
  // to the profile's modelInput when the profile is active, so picking a model
  // here also takes effect in chat (no separate trip to the chat model picker).
  const selectedModel = useConfigStore((s) => s.selectedModel);
  const setConfig = useConfigStore((s) => s.setConfig);

  // Editable fields
  const [label, setLabel] = useState(entry.label);
  const [baseUrl, setBaseUrl] = useState(entry.baseUrl ?? "");
  const [keyDraft, setKeyDraft] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [modelInput, setModelInput] = useState(entry.metadata?.defaultModel ?? "");
  const [postProc, setPostProc] = useState<PromptPostProcessing>(
    (entry.metadata?.promptPostProcessing as PromptPostProcessing) ?? "none",
  );
  const [availableModels, setAvailableModels] = useState<string[]>(entry.metadata?.models ?? []);
  const [connection, setConnection] = useState<ConnectionState>(
    (entry.metadata?.models?.length ?? 0) > 0 ? "connected" : "idle",
  );
  const [connectError, setConnectError] = useState<string | null>(null);
  const ollamaLoopbackOnHosted = isOllama && keyDraft.trim().length > 0 && isHostedBrowserOrigin() && isLoopbackUrl(keyDraft);

  // Test message UI
  const [testing, setTesting] = useState(false);
  const [testReply, setTestReply] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => { setTestReply(null); }, [modelInput, baseUrl, keyDraft, postProc]);

  // Additional params dialog
  const [paramsOpen, setParamsOpen] = useState(false);

  // Transient "✓ Updated just now" flash next to the API-key field
  const [keyJustSaved, setKeyJustSaved] = useState(false);
  useEffect(() => {
    if (!keyJustSaved) return;
    const t = setTimeout(() => setKeyJustSaved(false), 3000);
    return () => clearTimeout(t);
  }, [keyJustSaved]);

  // When this profile is active, mirror the local modelInput into the global
  // selectedModel so the chat actually uses what's picked here. Without this,
  // the upper "your model" and lower "available models" would be disconnected.
  useEffect(() => {
    if (!isActive) return;
    const trimmed = modelInput.trim();
    if (!trimmed) return;
    const composed = composeSelectedModelId(entry.provider, trimmed);
    if (composed && composed !== selectedModel) {
      setConfig("selectedModel", composed);
    }
  }, [isActive, modelInput, entry.provider, selectedModel, setConfig]);

  // The reverse direction is handled at activate-time inside the toggle handler
  // (see the Active button onClick) — when the user activates a profile, we
  // immediately push its model to selectedModel so chat picks it up.

  const dirty =
    label !== entry.label ||
    baseUrl !== (entry.baseUrl ?? "") ||
    keyDraft.length > 0 ||
    modelInput !== (entry.metadata?.defaultModel ?? "") ||
    postProc !== ((entry.metadata?.promptPostProcessing as PromptPostProcessing) ?? "none");

  const [saving, setSaving] = useState(false);
  // R3: the Save button says "Saved" for a moment; R4: failures print under it.
  const [savedAt, setSavedAt] = useState(0);
  const justSaved = useTransientFlag(savedAt, 1500);
  const [saveError, setSaveError] = useState<string | null>(null);

  const save = useCallback(async (silent = false) => {
    setSaving(true);
    setSaveError(null);
    try {
      // Save and Connect are both disabled in this state, and the help card above
      // already carries the amber warning — nothing to announce.
      if (isOllama && keyDraft.trim().length > 0 && isHostedBrowserOrigin() && isLoopbackUrl(keyDraft)) {
        return false;
      }
      const body: Record<string, unknown> = {};
      if (label !== entry.label) body.label = label;
      const keyChanged = keyDraft.length > 0;
      if (keyChanged) body.key = keyDraft;
      if (modelInput !== (entry.metadata?.defaultModel ?? "")) body.defaultModel = modelInput;
      if (isCustom) {
        if (baseUrl !== (entry.baseUrl ?? "")) body.baseUrl = baseUrl;
        if (postProc !== ((entry.metadata?.promptPostProcessing as PromptPostProcessing) ?? "none")) body.promptPostProcessing = postProc;
      }
      if (Object.keys(body).length === 0) {
        setSaving(false);
        return true;
      }
      const res = await fetch(`${apiBase}/api/keys/${entry.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: null }));
        setSaveError(typeof error === "string" && error.trim() ? error : t("apiKeys.saveFailed"));
        return false;
      }
      setKeyDraft("");
      // Even on silent (Connect/Test-triggered) saves, the "✓ Updated just now" chip
      // next to the key field tells the user their pasted key wasn't eaten.
      if (keyChanged) setKeyJustSaved(true);
      if (!silent) setSavedAt(Date.now());
      await onSaved();
      return true;
    } catch {
      setSaveError(t("apiKeys.saveFailed"));
      return false;
    } finally {
      setSaving(false);
    }
  }, [entry, label, keyDraft, baseUrl, modelInput, postProc, isCustom, isOllama, onSaved, t]);

  const connect = useCallback(async () => {
    // Save any pending changes (esp. baseUrl + new key) before fetching models
    if (dirty) {
      const ok = await save(true);
      if (!ok) return;
    }
    setConnection("connecting");
    setConnectError(null);
    try {
      const res = await fetch(`${apiBase}/api/keys/${entry.id}/list-models`, {
        method: "POST",
        credentials: "include",
      });
      const json = await res.json().catch(() => ({} as { data?: { ok?: boolean; reason?: string; models?: string[]; code?: string; status?: number }; error?: string }));
      const data = json.data;
      if (res.ok && data?.ok) {
        const models = data.models ?? [];
        setAvailableModels(models);
        setConnection("connected");
        // ST-style: auto-select first model if user hasn't typed one yet
        if (!modelInput.trim() && models.length > 0) {
          setModelInput(models[0]!);
        }
        // The button and inline status communicate discovery without a toast.
        await onSaved();
      } else {
        const unavailable = isCustom && data?.code === "model_list_unavailable";
        const reason = unavailable
          ? t(data?.status ? "apiKeys.modelListUnavailableStatus" : "apiKeys.modelListUnavailable", { status: data?.status })
          : data?.reason ?? json.error ?? null;
        setConnection(unavailable ? "unavailable" : "failed");
        setConnectError(reason || t("apiKeys.connectionFailed"));
      }
    } catch (err) {
      setConnection("failed");
      setConnectError((err as Error).message || t("apiKeys.connectionFailed"));
    }
  }, [entry.id, dirty, save, onSaved, modelInput, isCustom, t]);

  const sendTest = useCallback(async () => {
    // Both guards are already enforced by the button: Test only renders for custom
    // endpoints and is disabled until a model id is typed.
    if (!isCustom) return;
    if (!modelInput.trim()) return;
    if (dirty) {
      const ok = await save(true);
      if (!ok) return;
    }
    setTesting(true);
    setTestReply(null);
    try {
      const res = await fetch(`${apiBase}/api/keys/${entry.id}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ model: modelInput.trim(), prompt: "Hi" }),
      });
      const json = await res.json().catch(() => ({} as { data?: { ok?: boolean; reply?: string; reason?: string }; error?: string }));
      const data = json.data;
      if (res.ok && data?.ok && typeof data.reply === "string" && data.reply.trim()) {
        setTestReply({ ok: true, text: data.reply });
        setConnectError(null);
        setConnection((state) => state === "failed" || state === "unavailable" ? "idle" : state);
      } else {
        setTestReply({ ok: false, text: data?.reason ?? json.error ?? t("promptConfig.testFailed") });
      }
    } catch (err) {
      setTestReply({ ok: false, text: (err as Error).message });
    } finally {
      setTesting(false);
    }
  }, [isCustom, modelInput, entry.id, dirty, save, t]);

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 space-y-4">
      {/* ── Header: label + active + delete ── */}
      <div className="flex items-center gap-3">
        <span className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${meta.color}`}>
          {entry.provider}
        </span>
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="profile-overview-input-surface flex-1 border-white/10 text-sm font-medium"
          maxLength={64}
        />
        <button
          onClick={onDelete}
          className="hover-surface flex h-7 w-7 items-center justify-center rounded-md text-sub/40 hover:text-destructive"
          title={t("apiKeys.deleteProfile")}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* ── Custom endpoint fields ── */}
      {isCustom && (
        <div>
          <label className="mb-1 block text-[11px] text-sub/60">{t("apiKeys.baseUrl")}</label>
          <Input
            value={baseUrl}
            onChange={(e) => {
              setBaseUrl(e.target.value);
              setConnection("idle");
              setConnectError(null);
              setAvailableModels([]);
            }}
            disabled={testing || saving || connection === "connecting"}
            placeholder={t("apiKeys.baseUrlPlaceholder")}
            className="profile-overview-input-surface border-white/10"
          />
          <p className="mt-1 text-[10px] text-sub/40">
            {t("apiKeys.customBaseUrlHint")}
          </p>
        </div>
      )}

      {/* ── API key (replace) ── */}
      <div>
        <label className="mb-1 flex items-center justify-between text-[11px] text-sub/60">
          <span>{isOllama ? t("apiKeys.ollamaUrlLabel") : t("apiKeys.apiKeyLabel")}</span>
          {keyJustSaved ? (
            <span className="flex items-center gap-1 rounded-full bg-emerald-500/20 px-2 py-0.5 text-emerald-200 animate-in fade-in zoom-in-95 duration-200">
              <CheckCircle2 className="h-3 w-3" />
              {t("apiKeys.apiKeyJustUpdated")}
            </span>
          ) : (
            <span className="text-emerald-400/70">
              {isOllama ? t("apiKeys.ollamaUrlSaved", { label: entry.label }) : t("apiKeys.apiKeySaved", { label: entry.label })}
            </span>
          )}
        </label>
        <div className="relative">
          <Input
            value={keyDraft}
            onChange={(e) => {
              setKeyDraft(e.target.value);
              setConnection("idle");
              setConnectError(null);
              setAvailableModels([]);
            }}
            disabled={testing || saving || connection === "connecting"}
            placeholder={meta.placeholder + " " + (isOllama ? t("apiKeys.ollamaUrlKeepExisting") : t("apiKeys.apiKeyKeepExisting"))}
            type={isOllama || showKey ? "text" : "password"}
            className={`profile-overview-input-surface border-white/10 font-mono text-xs ${isOllama ? "" : "pr-9"}`}
            autoComplete="new-password"
            name={`profile-${entry.id}-api-key`}
          />
          {!isOllama && (
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-sub/40 hover:text-main"
            >
              {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
          )}
        </div>
      </div>

      {isOllama && <OllamaUrlHelp showLoopbackWarning={ollamaLoopbackOnHosted} />}

      {/* ── Active/inactive status banner (all providers) ── */}
      {isActive ? (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-[11px] text-emerald-200/90">
          <span className="font-semibold">{t("apiKeys.linkedToChat")}</span> {t("apiKeys.linkedToChatDesc")}
          <span className="ml-1 font-mono text-emerald-100">{selectedModel || t("apiKeys.noneSelected")}</span>.
        </div>
      ) : (
        <div className="rounded-md border border-amber-500/25 bg-amber-500/[0.04] px-3 py-2 text-[11px] text-amber-200/80">
          <span className="font-semibold">{t("apiKeys.notActive")}</span> {t("apiKeys.notActiveDescBefore")}<span className="text-amber-100">{t("apiKeys.setActive")}</span>{t("apiKeys.notActiveDescAfter")}
        </div>
      )}

      {/* ── Model selection (all providers) ── */}
      <div>
        <label className="mb-1 block text-[11px] text-sub/60">
          {t("apiKeys.availableModels")} {availableModels.length > 0 && <span className="text-sub/40">({availableModels.length})</span>}
        </label>
        <Select
          value={availableModels.includes(modelInput) ? modelInput : ""}
          onValueChange={setModelInput}
          disabled={availableModels.length === 0 || testing || saving || connection === "connecting"}
          options={[
            { value: "", label: availableModels.length === 0 ? t(isCustom ? "apiKeys.noModelList" : "apiKeys.clickConnectToFetch") : t("apiKeys.selectFromList") },
            ...availableModels.map((m) => ({ value: m, label: m })),
          ]}
          triggerClassName="profile-overview-input-surface border-white/10"
        />
        <p className="mt-1 text-[10px] text-sub/40">
          {availableModels.length === 0
            ? t(isCustom ? "apiKeys.manualModelHint" : "apiKeys.modelsListEmptyHint")
            : t("apiKeys.modelsListFilledHint")}
        </p>
      </div>

      <div>
        <label className="mb-1 block text-[11px] text-sub/60">
          {t("apiKeys.modelId")} <span className="text-sub/40">{t("apiKeys.modelIdOverride")}</span>
        </label>
        <Input
          value={modelInput}
          onChange={(e) => setModelInput(e.target.value)}
          disabled={testing || saving || connection === "connecting"}
          placeholder={t(isCustom ? "apiKeys.manualModelPlaceholder" : "apiKeys.modelIdPlaceholder")}
          className="profile-overview-input-surface border-white/10 font-mono text-xs"
        />
      </div>

      {isCustom && (
        <div>
          <label className="mb-1 block text-[11px] text-sub/60">{t("apiKeys.promptPostProcessing")}</label>
          <Select
            value={postProc}
            onValueChange={(v) => setPostProc(v as PromptPostProcessing)}
            disabled={testing || saving || connection === "connecting"}
            options={postProcChoices.map((o) => ({
              value: o.value,
              label: o.label,
              description: o.hint,
            }))}
            triggerClassName="profile-overview-input-surface border-white/10"
          />
          <p className="mt-1 text-[10px] text-sub/40">{postProcChoices.find((o) => o.value === postProc)?.hint}</p>
        </div>
      )}

      {/* ── Action row ── */}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {/* Connect — fetches models for any provider. For custom it requires a baseUrl. */}
        <Button
          type="button"
          size="sm"
          onClick={connect}
          disabled={testing || saving || connection === "connecting" || (isCustom && !baseUrl.trim()) || ollamaLoopbackOnHosted}
          className={
            connection === "connected" ? "bg-emerald-500/20 text-emerald-200 border border-emerald-500/40 hover:bg-emerald-500/30" :
            connection === "failed"    ? "bg-rose-500/20 text-rose-200 border border-rose-500/40 hover:bg-rose-500/30" :
            ""
          }
        >
          {connection === "connecting" ? (
            <><Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />{t(isCustom ? "apiKeys.fetchingModels" : "apiKeys.connecting")}</>
          ) : connection === "connected" ? (
            <><CheckCircle2 className="mr-1 h-3.5 w-3.5" />{t(isCustom ? "apiKeys.modelsLoaded" : "apiKeys.connected")}</>
          ) : connection === "failed" ? (
            <><XCircle className="mr-1 h-3.5 w-3.5" />{t(isCustom ? "apiKeys.fetchModels" : "apiKeys.reconnect")}</>
          ) : (
            <><Plug className="mr-1 h-3.5 w-3.5" />{t(isCustom ? "apiKeys.fetchModels" : "apiKeys.connect")}</>
          )}
        </Button>

        {isCustom && (
          <Button type="button" size="sm" variant="outline" onClick={() => setParamsOpen(true)} disabled={testing || saving || connection === "connecting"}>
            <Sliders className="mr-1 h-3.5 w-3.5" />
            {t("apiKeys.additionalParams")}
          </Button>
        )}

        {isCustom && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={sendTest}
            disabled={testing || saving || connection === "connecting" || !modelInput.trim()}
            title={!modelInput.trim() ? t("apiKeys.enterModelFirst") : undefined}
          >
            {testing ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1 h-3.5 w-3.5" />}
            {t(testing ? "apiKeys.testingModel" : "apiKeys.sendTestMessage")}
          </Button>
        )}
        {!modelInput.trim() && availableModels.length === 0 && (
          <span className="text-[11px] text-amber-300/70">{t(isCustom ? "apiKeys.enterModelFirst" : "apiKeys.clickConnectFirstHint")}</span>
        )}

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={onToggleActive}
            title={isActive ? t("apiKeys.deactivateHint") : t("apiKeys.activateHint")}
            className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
              isActive
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20"
                : "border-white/15 bg-white/[0.03] text-sub hover:border-white/25 hover:text-main"
            }`}
          >
            {isActive ? (<><CheckCircle2 className="h-3 w-3" />{t("apiKeys.active")} <span className="text-emerald-300/60">{t("apiKeys.clickToDeactivate")}</span></>) : t("apiKeys.setActive")}
          </button>
          <Button
            type="button"
            size="sm"
            onClick={async () => {
              const ok = await save(false);
              if (!ok) return;
              // Custom profiles can save a manual model without discovery.
              if (isCustom) return;
              // Built-in providers still refresh their models after saving.
              if (connection === "connecting") return;
              await connect();
            }}
            disabled={testing || saving || connection === "connecting" || !dirty || ollamaLoopbackOnHosted}
          >
            {saving
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : justSaved
                ? <><CheckCircle2 className="mr-1 h-3.5 w-3.5" />{t("apiKeys.saved")}</>
                : t("apiKeys.save")}
          </Button>
        </div>
      </div>

      <FieldError message={saveError} />

      {connectError && (connection === "failed" || connection === "unavailable") && (
        <div className={`rounded-md border p-2 text-[11px] ${connection === "unavailable" ? "border-amber-500/30 bg-amber-500/5 text-amber-200" : "border-rose-500/30 bg-rose-500/5 text-rose-200"}`}>
          {connectError}
        </div>
      )}

      {testReply && (
        <div className={`rounded-md border p-3 text-xs ${testReply.ok ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-100" : "border-rose-500/30 bg-rose-500/5 text-rose-100"}`}>
          <div className="mb-1 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider opacity-70">
            {testReply.ok ? <><CheckCircle2 className="h-3 w-3" />{t("apiKeys.testSucceeded")}</> : <><XCircle className="h-3 w-3" />{t("apiKeys.error")}</>}
          </div>
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed opacity-90">
            {testReply.text}
          </pre>
        </div>
      )}

      {paramsOpen && isCustom && (
        <AdditionalParamsDialog
          entry={entry}
          onClose={() => setParamsOpen(false)}
          onSaved={async () => {
            setTestReply(null);
            setConnectError(null);
            setConnection("idle");
            await onSaved();
          }}
        />
      )}
    </div>
  );
}

// ─── Additional Params Dialog ────────────────────────────────────────

function AdditionalParamsDialog({
  entry,
  onClose,
  onSaved,
}: {
  entry: ApiKeyEntry;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation("profile");
  const [include, setInclude] = useState(() => JSON.stringify(entry.metadata?.includeBody ?? {}, null, 2));
  const [exclude, setExclude] = useState(() => JSON.stringify(entry.metadata?.excludeBody ?? [], null, 2));
  const [headers, setHeaders] = useState(() => JSON.stringify(entry.metadata?.includeHeaders ?? {}, null, 2));
  const [saving, setSaving] = useState(false);
  // R4: every one of these is a syntax problem in a specific textarea, so it prints
  // under that textarea. The raw JSON.parse message is interpolated in full.
  const [errors, setErrors] = useState<{ include?: string; exclude?: string; headers?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);

  const save = async () => {
    let includeBody: Record<string, unknown> | undefined;
    let excludeBody: string[] | undefined;
    let includeHeaders: Record<string, string> | undefined;
    setErrors({});
    setFormError(null);
    try {
      const trimI = include.trim();
      if (trimI.length > 0) {
        const parsed = JSON.parse(trimI);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          setErrors({ include: t("apiKeys.includeBodyMustBeObject") });
          return;
        }
        includeBody = parsed;
      } else {
        includeBody = {};
      }
    } catch (err) {
      setErrors({ include: t("apiKeys.includeBodyError", { message: (err as Error).message }) });
      return;
    }
    try {
      const trimE = exclude.trim();
      if (trimE.length > 0) {
        const parsed = JSON.parse(trimE);
        if (!Array.isArray(parsed) || !parsed.every((s) => typeof s === "string")) {
          setErrors({ exclude: t("apiKeys.excludeBodyMustBeArray") });
          return;
        }
        excludeBody = parsed;
      } else {
        excludeBody = [];
      }
    } catch (err) {
      setErrors({ exclude: t("apiKeys.excludeBodyError", { message: (err as Error).message }) });
      return;
    }
    try {
      const trimH = headers.trim();
      if (trimH.length > 0) {
        const parsed = JSON.parse(trimH);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          setErrors({ headers: t("apiKeys.headersMustBeObject") });
          return;
        }
        for (const v of Object.values(parsed)) {
          if (typeof v !== "string") {
            setErrors({ headers: t("apiKeys.headerValuesMustBeStrings") });
            return;
          }
        }
        includeHeaders = parsed as Record<string, string>;
      } else {
        includeHeaders = {};
      }
    } catch (err) {
      setErrors({ headers: t("apiKeys.headersError", { message: (err as Error).message }) });
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(`${apiBase}/api/keys/${entry.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ includeBody, excludeBody, includeHeaders }),
      });
      if (res.ok) {
        // No pill: the dialog closing is the confirmation.
        await onSaved();
        onClose();
      } else {
        const { error } = await res.json().catch(() => ({ error: null }));
        setFormError(typeof error === "string" && error.trim() ? error : t("apiKeys.saveFailed"));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[560px] mx-4 max-h-[80vh] flex flex-col rounded-2xl border border-white/[0.08] bg-[#1A1B20] shadow-2xl animate-in fade-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
          <div className="flex items-center gap-2">
            <Sliders className="h-4 w-4 text-violet-300" />
            <h3 className="text-sm font-semibold text-foreground">{t("apiKeys.additionalParamsTitle")}</h3>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-sub/40 hover:bg-white/5 hover:text-main">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <p className="text-[11px] text-sub/60">
            {t("apiKeys.additionalParamsIntro")}
          </p>

          <ParamField
            label={t("apiKeys.includeBody")}
            description={t("apiKeys.includeBodyDesc")}
            exampleLabel={t("apiKeys.exampleLabel")}
            example='{"top_k": 40, "min_p": 0.05}'
            value={include}
            onChange={setInclude}
            error={errors.include}
            errorId="api-params-include-error"
          />

          <ParamField
            label={t("apiKeys.excludeBody")}
            description={t("apiKeys.excludeBodyDesc")}
            exampleLabel={t("apiKeys.exampleLabel")}
            example='["frequency_penalty", "presence_penalty"]'
            value={exclude}
            onChange={setExclude}
            error={errors.exclude}
            errorId="api-params-exclude-error"
          />

          <ParamField
            label={t("apiKeys.includeHeaders")}
            description={t("apiKeys.includeHeadersDesc")}
            exampleLabel={t("apiKeys.exampleLabel")}
            example='{"X-Title": "Yumina", "X-Group": "private"}'
            value={headers}
            onChange={setHeaders}
            error={errors.headers}
            errorId="api-params-headers-error"
          />
        </div>

        <div className="border-t border-white/[0.06] px-5 py-3">
          <FieldError message={formError} />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onClose} disabled={saving}>{t("apiKeys.cancel")}</Button>
            <Button size="sm" onClick={save} disabled={saving}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t("apiKeys.save")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ParamField({
  label, description, exampleLabel, example, value, onChange, error, errorId,
}: {
  label: string; description: string; exampleLabel: string; example: string;
  value: string; onChange: (v: string) => void; error?: string; errorId?: string;
}) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-semibold text-main">{label}</label>
      <p className="mb-1.5 text-[10px] text-sub/50">
        {description} <span className="text-sub/40">{exampleLabel} <span className="font-mono text-sub/60">{example}</span></span>
      </p>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={4}
        className="profile-overview-input-surface w-full rounded-lg border border-white/10 px-3 py-2 font-mono text-[11px] text-foreground placeholder:text-sub/30 [color-scheme:dark]"
        spellCheck={false}
        aria-invalid={!!error}
        aria-describedby={error ? errorId : undefined}
      />
      <FieldError id={errorId} message={error} />
    </div>
  );
}
