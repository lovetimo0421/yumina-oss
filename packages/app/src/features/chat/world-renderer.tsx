import { savePreferredProvider } from "@/lib/provider-switch";
import { notePlayInteraction } from "./play-interaction";
import { useStoryNavigation } from "@/hooks/use-story-navigation";
/**
 * WorldRenderer — parent-side host for the sandbox iframe.
 *
 * Manages a single sandbox per session:
 * - ONE root component (installed once, recompiled on code change)
 * - Channel-based state updates (partitioned, only push what changed)
 * - Game event handling (emitEvent routed through parent API)
 */

import { queueSessionStateOperation } from "@/lib/session-state-queue";
import { reconcileSessionStateConfirmation } from "@/lib/session-state-confirmation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import posthog from "posthog-js";
import { useSandbox } from "../sandbox/use-sandbox";
import { GameRoomConnection } from "./game-room-connection";
import { slimMessages } from "./slim-messages";
import { createSideCallStreamReader } from "./side-call-stream";
import { isCompiledValid, type CompiledRoot } from "@/features/studio/lib/compiled-format";
import { absoluteImageUrl } from "@/lib/asset-url";
import type { YuminaAPI } from "@/features/studio/lib/custom-component-renderer";
import type { Condition, LoreUiBinding, Worldbook, StateChannel } from "@yumina/engine";
import type {
  VariablesChannelData,
  MessagesChannelData,
  StreamingChannelData,
  SessionChannelData,
  SandboxEntry,
  UIChannelData,
  ChannelDataMap,
  SandboxCapabilities,
  SandboxMode,
} from "@/../sandbox/protocol";
import { useAudioStore, onAudioTrackEnded } from "@/stores/audio";
import { useUiStore, FONT_SIZE_SCALE } from "@/stores/ui";
import { useCreditStore } from "@/edition/slots.state";
import { useChatStore } from "@/stores/chat";
import { fetchApiKeyModelProfiles, resolveOfficialSelectedModel, resolvePrivateSelectedModel } from "@/lib/provider-model-selection";
import {
  setComposerDraft,
  loadComposerDraft,
  resetComposerDraftMirror,
} from "@/lib/composer-draft";
import { chatSessionTarget, createdSessionId } from "@/lib/session-navigation";
import { SANDBOX_DOC_URL, SANDBOX_DOC_RETRY_URL } from "@/lib/sandbox-doc-url";
import { feedback } from "@/lib/feedback";
import { toPillText } from "@/lib/feedback-policy";

/**
 * Copy that comes from a card author, not from us: flatten it to the pill's
 * single line and clamp it, so `api.showToast` can never produce a paragraph
 * (or trip the DEV copy guard).
 */

const SANDBOX_URL = SANDBOX_DOC_URL;
const apiBase = import.meta.env.VITE_API_URL || "";
const PENDING_MESSAGE_ID_PREFIX = "__pending_";

/** Whether a boot that ran long was a slow network or a broken one is the whole
 *  question, and only the client can answer it. Same shape stale-chunk-reload.ts
 *  reports, so the two diagnostics line up. */
function bootConnectionType(): string {
  const conn = (navigator as Navigator & { connection?: { effectiveType?: string } }).connection;
  return conn?.effectiveType ?? "unknown";
}
/** Ceiling for `api.fetchAsset`. Comfortably fits a game-ready GLB with textures
 *  while keeping one bad call from ballooning the tab — the bytes are buffered
 *  in the parent and then structured-cloned into the iframe, so they land twice. */
const MAX_FETCH_ASSET_BYTES = 32 * 1024 * 1024;

/** The pin list for a catalog scope. Cards only ever see the one that matches
 *  the models they were handed. */
function pinnedFor(
  config: { pinnedModels: string[]; pinnedPrivateModels: string[] },
  scope: "official" | "private",
): string[] {
  return scope === "private" ? config.pinnedPrivateModels : config.pinnedModels;
}

function isPendingMessageId(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(PENDING_MESSAGE_ID_PREFIX);
}

/**
 * Confine a sandbox-supplied storage key to THIS world's namespaces. Already
 * fully-scoped keys (the compat shims' `yumina:{local|session}:{worldId}:…`)
 * pass through only when their worldId matches; anything else — including a
 * crafted prefix targeting another world — gets the default namespace applied.
 */
function scopeStorageKey(worldId: string, rawKey: string): string {
  const key = String(rawKey);
  if (key.startsWith(`yumina:local:${worldId}:`) || key.startsWith(`yumina:session:${worldId}:`)) {
    return key;
  }
  return `yumina:local:${worldId}:${key}`;
}

function evictOldestYuminaKeys(protectKey: string): void {
  const entries: { key: string; size: number }[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith("yumina:local:") && k !== protectKey) {
      entries.push({ key: k, size: (localStorage.getItem(k) ?? "").length });
    }
  }
  entries.sort((a, b) => b.size - a.size);
  const toEvict = Math.max(1, Math.ceil(entries.length * 0.25));
  for (let i = 0; i < toEvict && i < entries.length; i++) {
    localStorage.removeItem(entries[i]!.key);
  }
}

const SESSION_CAPABILITIES: SandboxCapabilities = {
  canSendMessage: true,
  canPersistSession: true,
  canUseSessionApis: true,
  requiresAuth: false,
};

interface WorldRendererProps {
  /** Entry file name */
  entryFile: string | undefined;
  /** Virtual file system: filename → TSX code */
  files: Record<string, string> | undefined;
  /** Pre-compiled root JS stamped at save-time. When present + valid, the
   *  play-time browser compile is skipped. Falls back to compiling `files`. */
  precompiled?: CompiledRoot;
  /** Current game variables. Keyed by `Variable.id` — which for anything the
   *  editor created is a UUID, not the name the creator sees. */
  variables: Record<string, unknown>;
  /** Declared variables, so the sandbox can resolve a read by display name back
   *  to its id (see sandbox/variable-alias.ts). Without this a HUD written as
   *  `api.variables.hunger` silently reads undefined and freezes on its own
   *  fallback constant. Only `id` and `name` are used. */
  variableDefs?: ReadonlyArray<{ id: string; name?: string }>;
  /** The YuminaAPI object (same as v1) */
  api: YuminaAPI;
  /** Session ID */
  sessionId: string;
  /** World ID */
  worldId: string;
  /** Persona-aware user. Same branching as {{user}}: persona if active, else account.
   *  Used by the sandbox `useYumina().user` API. If absent, falls back to account-only
   *  derived from `api.currentUser`. */
  user?: { name: string; avatar: string | null };
  /** Additional CSS class */
  className?: string;
  /** Whether this renderer is the visible/active session. When false, we pause all
   *  raw `<video>`/`<audio>` tags inside the sandbox so BGM doesn't leak from a
   *  hidden iframe kept alive by PersistentChat's 60s fast-switch cache. Defaults
   *  to true for contexts that don't care (world preview, studio canvas). */
  isActive?: boolean;
  mode?: SandboxMode;
  capabilities?: SandboxCapabilities;
  /** Lorebook entries from the world schema. Pushed to the sandbox so cards can
   *  read character profiles / world facts when assembling side LLM calls.
   *  Accepts the full WorldEntry shape; world-renderer slims it before push. */
  entries?: ReadonlyArray<{
    id: string;
    name: string;
    content: string;
    keywords?: string[];
    position: number;
    section: SandboxEntry["section"];
    enabled: boolean;
    role?: string;
    tags?: string[];
    conditions?: Condition[];
    conditionLogic?: "all" | "any";
    portrait?: string;
  }>;
  loreUiBindings?: LoreUiBinding[];
  worldbooks?: Worldbook[];
}

export function WorldRenderer({
  entryFile,
  files,
  precompiled,
  variables,
  variableDefs,
  api,
  sessionId,
  worldId,
  user,
  className,
  isActive = true,
  mode = "session",
  capabilities = SESSION_CAPABILITIES,
  entries,
  loreUiBindings,
  worldbooks,
}: WorldRendererProps) {
  const modelFallback = useChatStore((s) => s.modelFallback?.sessionId === sessionId ? s.modelFallback : null);
  const bgmVolume = useAudioStore((s) => s.bgmVolume);
  const sfxVolume = useAudioStore((s) => s.sfxVolume);
  const router = useRouter();
  const navigateToStory = useStoryNavigation();
  // Name the namespace so it is actually fetched: `chat` is not in i18n's
  // preloaded `ns` list, and resourcesToBackend only pulls a namespace once
  // something asks for it. A bare useTranslation() would leave the boot-failure
  // strings below falling back to their English defaults.
  const { i18n } = useTranslation("chat");
  const language = i18n.language;
  // Live wallet balance → pushed to the sandbox so the model-pill shows the
  // user's CURRENT mushies (consistent across cards/devices), not a value dug
  // out of message history. Subscribed so a balance change re-pushes the channel.
  const mushieBalance = useCreditStore((s) => s.balance);
  // Site-wide composer/display prefs, mirrored across the bridge — the sandbox
  // document can't read the host ui store, so without these the "Press Enter
  // to send" and font-size settings silently didn't apply in-play.
  const composerSendKey = useUiStore((s) => s.composerSendKey ?? "enter");
  const uiFontSize = useUiStore((s) => s.fontSize ?? "default");
  const uiFontScale = FONT_SIZE_SCALE[uiFontSize] ?? 1;

  // Stable refs
  const apiRef = useRef(api);
  apiRef.current = api;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const worldIdRef = useRef(worldId);
  worldIdRef.current = worldId;
  const activeLoreSlotsRef = useRef(new Set<string>());
  const loreSlotsFlushScheduledRef = useRef(false);
  // Multiplayer: one game-rt connection per renderer, created lazily on
  // room.join. sendRoomFrameRef breaks the ordering knot — handleApiCall is
  // defined before useSandbox returns the frame pump.
  const gameRoomRef = useRef<GameRoomConnection | null>(null);
  const sendRoomFrameRef = useRef<((frame: Record<string, unknown>) => void) | null>(null);

  // ── API call handler (reuse same pattern as SandboxedRenderer) ──
  const handleApiCall = useCallback(
    (method: string, args: unknown[]): unknown => {
      const currentApi = apiRef.current;
      // R7: the sandbox asked for a session and never got one — nothing on
      // screen can carry that, so it earns a pill.
      const showSessionCreateError = () => {
        feedback.error(
          String(
            i18n.t("chat:feedback.sessionCreateFailed", { defaultValue: "Couldn't create the session" }),
          ),
        );
      };

      switch (method) {
        case "social.get": case "social.action": case "social.generate": {
          const sid = sessionIdRef.current;
          if (!sid) return Promise.resolve({ error: "No active session" });
          if (method !== "social.get" && (currentApi as YuminaAPI & { readOnly?: boolean }).readOnly) {
            return Promise.resolve({ error: "This view is read-only" });
          }
          const suffix = method === "social.get" ? "" : method === "social.action" ? "/action" : "/generate";
          return (async () => {
          const response = await fetch(`${apiBase}/api/sessions/${encodeURIComponent(sid)}/social${suffix}`, {
            method: suffix ? "POST" : "GET", credentials: "include", headers: { "Content-Type": "application/json" },
            ...(suffix ? { body: JSON.stringify(args[0]) } : {}), signal: AbortSignal.timeout(suffix === "/generate" ? 205_000 : 20_000),
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error ?? "Social request failed");
          return result;
          })().catch(error => ({ error: error instanceof Error ? error.message : "Social request failed" }));
        }
        case "sendMessage":
          currentApi.sendMessage(args[0] as string);
          return;
        case "patchVariables": {
          const sid = sessionIdRef.current;
          const values = args[0];
          if (!sid || mode !== "session" || useChatStore.getState().readOnly) throw new Error("This view is read-only");
          if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("Expected variable patch");
          return queueSessionStateOperation(async (signal) => {
            if (sessionIdRef.current !== sid || useChatStore.getState().session?.id !== sid) throw new Error("Session changed");
            const before = useChatStore.getState();
            const response = await fetch(`${apiBase}/api/sessions/${encodeURIComponent(sid)}/state`, {
              method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ state: { variables: values } }), signal,
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || "State update failed");
            if (signal.aborted) throw new Error("State update timed out");
            const confirmed = result.data?.state;
            if (!confirmed?.variables) throw new Error("State confirmation missing");
            if (sessionIdRef.current !== sid || useChatStore.getState().session?.id !== sid) throw new Error("Session changed");
            let applied = false;
            useChatStore.setState((s) => {
              const next = reconcileSessionStateConfirmation<typeof s.gameState[string]>(
                sid, before, s, values as Record<string, unknown>, confirmed,
              );
              applied = next !== null;
              return next ? {
                gameState: next.variables,
                session: s.session ? { ...s.session, state: next } : s.session,
              } : s;
            });
            return { applied };
          });
        }
        case "setVariable":
          currentApi.setVariable(
            args[0] as string,
            args[1] as any,
            args[2] as any,
          );
          return;
        case "setLoreSlotActive": {
          const slotId = args[0] as string;
          const active = args[1] as boolean;
          if (!slotId) return;
          if (active) activeLoreSlotsRef.current.add(slotId);
          else activeLoreSlotsRef.current.delete(slotId);
          const sid = sessionIdRef.current;
          if (!sid || mode !== "session") return;
          // Coalesce the synchronous burst of mounts/unmounts in one render into a
          // single PATCH on the microtask, then fire immediately — same latency
          // profile as setVariable (no debounce), so a click→send right after a
          // toggle lands the slot before the next turn reads state.
          if (loreSlotsFlushScheduledRef.current) return;
          loreSlotsFlushScheduledRef.current = true;
          queueMicrotask(() => {
            loreSlotsFlushScheduledRef.current = false;
            const apiBase = import.meta.env.VITE_API_URL || "";
            // 409 session_busy = the row is held by an in-flight turn; one retry
            // after it settles is enough, and the slot set is re-read then.
            const patchSlots = (retry: boolean) => {
              const slots = [...activeLoreSlotsRef.current];
              fetch(`${apiBase}/api/sessions/${sid}/state`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({
                  state: { metadata: { activeLoreSlots: slots } },
                }),
              })
                .then((res) => {
                  if (res.status === 409 && retry) setTimeout(() => patchSlots(false), 2000);
                })
                .catch(() => {});
            };
            patchSlots(true);
          });
          return;
        }
        case "executeAction":
          currentApi.executeAction?.(args[0] as string);
          return;
        case "emitEvent":
          // TODO: Route through ReactionEvaluator in Phase 2
          console.log("[WorldRenderer] emitEvent:", args[0]);
          return;
        case "injectContext": {
          // Store pending context for next AI turn via session state update
          const msg = args[0] as string;
          const opts = args[1] as { role?: string } | undefined;
          const entry = { message: msg, role: opts?.role ?? "system" };
          const sid = sessionIdRef.current;
          if (!sid || !msg) return;
          // PATCH session state to add to pendingContext metadata
          fetch(`/api/sessions/${sid}/context`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify(entry),
          }).catch(() => {});
          return;
        }
        case "playAudio":
          currentApi.playAudio?.(args[0] as string, args[1] as any);
          return;
        case "stopAudio":
          currentApi.stopAudio?.(args[0] as string, args[1] as number);
          return;
        case "pauseAudio":
          currentApi.pauseAudio?.(args[0] as string);
          return;
        case "resumeAudio":
          currentApi.resumeAudio?.(args[0] as string);
          return;
        case "setAudioVolume":
          currentApi.setAudioVolume?.(args[0] as any, args[1] as number);
          return;
        case "getAudioVolume":
          return currentApi.getAudioVolume?.(args[0] as any);
        case "switchGreeting":
          currentApi.switchGreeting?.(args[0] as number);
          return;
        case "swipeMessage": {
          const sid = sessionIdRef.current;
          if (!sid) return Promise.resolve({});
          const [swipeMsgId, direction] = args as [string, "left" | "right"];
          if (isPendingMessageId(swipeMsgId)) return Promise.resolve({});
          const apiBase = import.meta.env.VITE_API_URL || "";
          return fetch(`${apiBase}/api/messages/${swipeMsgId}/swipe`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ direction }),
          }).then(async (r) => {
            if (!r.ok) return {};
            const json = await r.json();
            const data = json.data ?? json;
            const store = (await import("@/stores/chat")).useChatStore.getState();
            if (data.content !== undefined) {
              store.updateMessage(swipeMsgId, {
                content: data.content,
                activeSwipeIndex: data.activeSwipeIndex,
              });
            }
            if (data.state && data.stateRestored !== false) {
              const vars = (data.state as Record<string, unknown>)?.variables;
              if (vars) store.setGameState(vars as Record<string, number | string | boolean | Record<string, unknown> | unknown[]>);
            }
            return data;
          }).catch(() => ({}));
        }
        case "navigateTo":
          currentApi.navigateTo?.(args[0] as string);
          return;
        case "toggleImmersive":
          (window as any).__yuminaToggleImmersive?.();
          return;
        case "getPersonaProfile": {
          const currentSessionId = sessionIdRef.current;
          return import("@/lib/persona-profile").then(({ readPersonaProfile }) =>
            readPersonaProfile(currentSessionId, useChatStore.getState().session),
          );
        }
        case "openPersonaManager":
          useUiStore.getState().openPersonaManager();
          return;
        case "sharePlaythrough":
          useUiStore.getState().openSharePlaythrough();
          return;
        case "openSessionManager":
          useUiStore.getState().openSessionManager();
          return;
        case "openSupport": {
          // The play header's tip button is unreachable under a fullscreen
          // custom-UI card, so a card may open the same dialog itself. Report
          // WHY it didn't open rather than no-opping: the creator testing their
          // own card can't tip themselves and is the first to press it.
          return import("@/stores/chat").then(({ useChatStore }) => {
            const s = useChatStore.getState().session as
              | { world?: { creatorId?: string }; currentUser?: { id?: string } }
              | null;
            const creatorId = s?.world?.creatorId;
            const viewerId = s?.currentUser?.id;
            if (!creatorId || !viewerId) return { opened: false, reason: "signed-out" as const };
            if (creatorId === viewerId) return { opened: false, reason: "self" as const };
            useUiStore.getState().openTipModal();
            return { opened: true };
          });
        }
        case "fetchAsset": {
          // Read an asset's raw bytes into the sandbox.
          //
          // The sandbox cannot fetch anything itself (`connect-src 'none'`), and
          // an <img> is no help for a .glb / a big JSON / a sprite atlas —
          // the browser gives images a privileged loading path and gives binary
          // formats none. The obvious fix is to relax connect-src; this is the
          // narrower one. The parent does the fetch (no CSP problem here) and
          // hands the bytes over.
          //
          // Narrow on purpose: the argument is an ASSET ID, never a URL. A card
          // therefore cannot reach an arbitrary host, cannot probe paths, cannot
          // be steered by a redirect, and gains no exfiltration channel — while
          // still being able to read its own assets, which is the actual need.
          // `credentials: "omit"` so this can never read an authenticated body.
          const raw = String(args[0] ?? "");
          const m = /^(?:@asset:)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(raw);
          if (!m) return Promise.resolve({ ok: false, error: "bad-ref" });
          const base = import.meta.env.VITE_API_URL || "";
          return fetch(`${base}/cdn/${m[1]}`, { credentials: "omit" })
            .then(async (r) => {
              if (!r.ok) return { ok: false, error: `http-${r.status}` };
              // Check the advertised size before buffering, so a hostile or
              // simply enormous asset cannot balloon the tab before we notice.
              const declared = Number(r.headers.get("content-length") || 0);
              if (declared > MAX_FETCH_ASSET_BYTES) return { ok: false, error: "too-large" };
              const bytes = await r.arrayBuffer();
              if (bytes.byteLength > MAX_FETCH_ASSET_BYTES) return { ok: false, error: "too-large" };
              return { ok: true, bytes, contentType: r.headers.get("content-type") || "" };
            })
            .catch((e) => ({ ok: false, error: String(e?.message ?? e).slice(0, 120) }));
        }
        case "copyToClipboard":
          navigator.clipboard?.writeText(args[0] as string).catch(() => {});
          return;
        case "navigate": {
          const url = args[0] as string;
          const chatTarget = chatSessionTarget(url);
          if (chatTarget.matchesChatRoute) {
            if (!chatTarget.sessionId) {
              showSessionCreateError();
              return;
            }
            navigateToStory(chatTarget.sessionId);
          } else {
            router.navigate({ to: url } as any);
          }
          return;
        }
        // ── Message revert / branch ──
        case "revertToMessage": {
          const sid = sessionIdRef.current;
          if (!sid) return Promise.resolve(undefined);
          if (isPendingMessageId(args[0])) return Promise.resolve(undefined);
          return import("@/stores/chat").then((m) =>
            m.useChatStore.getState().revertToMessage(args[0] as string)
          );
        }
        case "branchFromMessage": {
          const sid = sessionIdRef.current;
          if (!sid) return Promise.resolve(null);
          if (isPendingMessageId(args[0])) return Promise.resolve(null);
          return import("@/stores/chat").then((m) =>
            m.useChatStore.getState().branchFromMessage(args[0] as string)
          );
        }
        case "getBranchContext": {
          const sid = sessionIdRef.current;
          if (!sid) {
            return Promise.resolve({
              current: {
                id: "",
                name: null,
                parentSessionId: null,
                branchedFromMessageId: null,
                messageCount: 0,
                updatedAt: new Date(0).toISOString(),
                createdAt: new Date(0).toISOString(),
              },
              parent: null,
              siblings: [],
              children: [],
            });
          }
          return fetch(`${apiBase}/api/sessions/${sid}/branch-context`, {
            credentials: "include",
          })
            .then((r) => r.json())
            .then((d) => d.data);
        }
        case "createSession": {
          const sid = sessionIdRef.current;
          if (!sid) return Promise.resolve("");
          return fetch(`${apiBase}/api/sessions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ worldId: args[0] }),
          })
            .then(async (response) => {
              const payload = await response.json().catch(() => null);
              const newSessionId = createdSessionId(response.ok, payload);
              if (!newSessionId) {
                showSessionCreateError();
                return "";
              }
              return newSessionId;
            })
            .catch(() => {
              showSessionCreateError();
              return "";
            });
        }
        case "deleteSession": {
          const sid = sessionIdRef.current;
          if (!sid) return Promise.resolve({});
          return fetch(`${apiBase}/api/sessions/${args[0]}`, {
            method: "DELETE",
            credentials: "include",
          }).then((r) => r.json());
        }
        case "listSessions": {
          const sid = sessionIdRef.current;
          if (!sid) return Promise.resolve([]);
          return fetch(
            `${apiBase}/api/sessions?worldId=${encodeURIComponent(args[0] as string)}`,
            { credentials: "include" }
          )
            .then((r) => r.json())
            .then((d) => d.data ?? []);
        }
        // ── Chat actions ──
        case "editMessage": {
          const sid = sessionIdRef.current;
          if (!sid) return Promise.resolve(false);
          const [messageId, content] = args as [string, string];
          if (isPendingMessageId(messageId)) return Promise.resolve(false);
          return fetch(`${apiBase}/api/messages/${messageId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ content }),
          }).then(async (r) => {
            if (!r.ok) return false;
            const { data } = await r.json();
            const store = (await import("@/stores/chat")).useChatStore.getState();
            store.updateMessage(messageId, data);
            const msgs = store.messages;
            const lastMsg = msgs[msgs.length - 1];
            const secondToLast = msgs[msgs.length - 2];
            if (lastMsg?.role === "assistant" && secondToLast?.id === messageId) {
              store.regenerateMessage(lastMsg.id);
            } else if (lastMsg?.id === messageId && lastMsg.role === "user") {
              store.continueLastMessage();
            }
            return true;
          }).catch(() => false);
        }
        case "deleteMessage": {
          const sid = sessionIdRef.current;
          if (!sid) return Promise.resolve(false);
          const [msgId] = args as [string];
          if (isPendingMessageId(msgId)) return Promise.resolve(false);
          return fetch(`${apiBase}/api/messages/${msgId}`, {
            method: "DELETE",
            credentials: "include",
          }).then(async (r) => {
            if (!r.ok) return false;
            const store = (await import("@/stores/chat")).useChatStore.getState();
            store.removeMessage(msgId);
            return true;
          }).catch(() => false);
        }
        case "regenerateMessage": {
          const sid = sessionIdRef.current;
          if (!sid) return;
          if (isPendingMessageId(args[0])) return;
          import("@/stores/chat").then(m => m.useChatStore.getState().regenerateMessage(args[0] as string));
          return;
        }
        case "continueLastMessage": {
          const sid = sessionIdRef.current;
          if (!sid) return;
          import("@/stores/chat").then(m => m.useChatStore.getState().continueLastMessage());
          return;
        }
        case "loadEarlierMessages": {
          const sid = sessionIdRef.current;
          if (!sid) return Promise.resolve(false);
          return import("@/stores/chat")
            .then((m) => m.useChatStore.getState().loadEarlierMessages())
            .catch(() => false);
        }
        case "stopGeneration": {
          const sid = sessionIdRef.current;
          if (!sid) return;
          import("@/stores/chat").then(m => m.useChatStore.getState().stopGeneration());
          return;
        }
        case "restartChat": {
          const sid = sessionIdRef.current;
          if (!sid) return;
          import("@/stores/chat").then(m => m.useChatStore.getState().restartChat());
          return;
        }
        case "reloadSession": {
          const sid = sessionIdRef.current;
          if (sid) {
            import("@/stores/chat").then(m => m.useChatStore.getState().loadSession(sid));
          }
          return;
        }
        case "clearPendingChoices": {
          const sid = sessionIdRef.current;
          if (!sid) return;
          import("@/stores/chat").then(m => m.useChatStore.getState().clearPendingChoices());
          return;
        }
        // ── Checkpoints ──
        case "saveCheckpoint": {
          const sid = sessionIdRef.current;
          if (!sid) return Promise.resolve(undefined);
          return import("@/stores/chat").then(m => m.useChatStore.getState().saveCheckpoint());
        }
        case "loadCheckpoints": {
          const sid = sessionIdRef.current;
          if (!sid) return Promise.resolve(undefined);
          return import("@/stores/chat").then(m => m.useChatStore.getState().loadCheckpoints());
        }
        case "restoreCheckpoint": {
          const sid = sessionIdRef.current;
          if (!sid) return Promise.resolve(undefined);
          return import("@/stores/chat").then(m => m.useChatStore.getState().restoreCheckpoint(args[0] as string));
        }
        case "deleteCheckpoint": {
          const sid = sessionIdRef.current;
          if (!sid) return Promise.resolve(undefined);
          return import("@/stores/chat").then(m => m.useChatStore.getState().deleteCheckpoint(args[0] as string));
        }
        // ── Model picker ──
        case "resolveModelFallback": {
          const store = useChatStore.getState();
          if (store.modelFallback?.sessionId !== sessionIdRef.current) return null;
          if (typeof args[0] !== "string" || typeof args[1] !== "string") return null;
          store.resolveModelFallback(args[0], args[1], args[2] === true);
          return null;
        }
        case "cancelModelFallback": {
          const store = useChatStore.getState();
          if (store.modelFallback?.sessionId !== sessionIdRef.current || typeof args[0] !== "string") return null;
          store.cancelModelFallback(args[0]);
          return null;
        }
        case "setModel": {
          const sid = sessionIdRef.current;
          if (!sid) return;
          import("@/stores/config").then(m => {
            m.useConfigStore.getState().setConfig("selectedModel", args[0] as string);
          }).catch(() => {});
          import("@/stores/models").then(m => {
            m.useModelsStore.getState().addToRecent(args[0] as string);
          }).catch(() => {});
          return;
        }
        case "getModels": {
          return Promise.all([
            import("@/stores/models"),
            import("@/stores/config"),
          ]).then(async ([modelsModule, configModule]) => {
            await modelsModule.useModelsStore.getState().fetchModels();
            const modelsState = modelsModule.useModelsStore.getState();
            const configState = configModule.useConfigStore.getState();
            return {
              models: modelsState.models,
              // Pins come from the same catalog the models did, so the picker
              // never shows a pin it cannot render.
              pinnedModels: pinnedFor(
                configState,
                modelsModule.pinScopeFromSourceKey(modelsState.lastSourceKey),
              ),
              recentlyUsed: modelsState.recentlyUsed,
            };
          });
        }
        case "getSessionMemory":
        case "saveSessionMemory":
        case "saveSessionMemoryPinned":
        case "clearSessionMemory":
        case "regenerateSessionMemory":
        case "retrySessionMemory":
        case "setSessionMemoryModel":
        case "setSessionMemoryIncluded":
        case "getSessionSummary":
        case "saveSessionSummary":
        case "setSessionSummaryModel":
        case "setSessionSummaryceptionModel":
        case "setSessionSummaryImplementation":
        case "setSessionSummaryMode":
        case "setSessionSummaryIncluded":
        case "setSessionSummaryceptionIncluded":
        case "setSessionSummaryTriggerTokens":
        case "setSessionSummaryRecentTailTokens":
        case "setSessionSummaryLanguage":
        case "clearSessionSummary":
        case "regenerateSessionSummary":
        case "resumeSessionSummaryAutoCompaction":
        case "compactSessionSummary": {
          const sid = sessionIdRef.current;
          if (!sid) return Promise.reject(new Error("No active session"));

          const isSummaryMethod = method.includes("SessionSummary");
          const endpoint = `${apiBase}/api/sessions/${sid}/${isSummaryMethod ? "summary" : "memory"}`;
          let request: Promise<Response>;
          if (method === "getSessionMemory" || method === "getSessionSummary") {
            request = fetch(endpoint, { credentials: "include" });
          } else if (method === "retrySessionMemory") {
            request = fetch(`${endpoint}/retry`, { method: "POST", credentials: "include" });
          } else if (method === "saveSessionMemory") {
            request = fetch(endpoint, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({ memory: args[0], model: args[1] }),
            });
          } else if (method === "saveSessionMemoryPinned") {
            request = fetch(`${endpoint}/pinned`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({ pinned: args[0] ?? null }),
            });
          } else if (method === "saveSessionSummary") {
            request = fetch(endpoint, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({ summary: args[0], model: args[1] }),
            });
          } else if (method === "setSessionSummaryMode") {
            request = fetch(`${endpoint}/settings`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({ mode: args[0] }),
            });
          } else if (method === "setSessionSummaryModel") {
            request = fetch(`${endpoint}/settings`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({ model: args[0] }),
            });
          } else if (method === "setSessionSummaryceptionModel") {
            request = fetch(`${endpoint}/settings`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({ summaryceptionModel: args[0] }),
            });
          } else if (method === "setSessionSummaryImplementation") {
            request = fetch(`${endpoint}/settings`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({ implementation: args[0] }),
            });
          } else if (method === "setSessionMemoryIncluded" || method === "setSessionSummaryIncluded") {
            request = fetch(`${endpoint}/settings`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({ included: args[0] }),
            });
          } else if (method === "setSessionSummaryceptionIncluded") {
            request = fetch(`${endpoint}/settings`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({ summaryceptionIncluded: args[0] }),
            });
          } else if (method === "setSessionSummaryTriggerTokens") {
            request = fetch(`${endpoint}/settings`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({ triggerTokens: args[0] }),
            });
          } else if (method === "setSessionSummaryRecentTailTokens") {
            request = fetch(`${endpoint}/settings`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({ recentTailTokens: args[0] }),
            });
          } else if (method === "setSessionSummaryLanguage") {
            // One session-wide column behind /summary/settings — the memory
            // updater and the layered summarizer read the same value.
            request = fetch(`${endpoint}/settings`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({ language: args[0] }),
            });
          } else if (method === "clearSessionMemory" || method === "clearSessionSummary") {
            request = fetch(endpoint, { method: "DELETE", credentials: "include" });
          } else if (method === "setSessionMemoryModel") {
            request = fetch(`${endpoint}/model`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({ model: args[0] }),
            });
          } else if (method === "compactSessionSummary") {
            const compactOptions = args[2] && typeof args[2] === "object"
              ? args[2] as { force?: boolean }
              : {};
            request = fetch(`${endpoint}/compact`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({ model: args[0], implementation: args[1], force: compactOptions.force === true }),
            });
          } else if (method === "resumeSessionSummaryAutoCompaction") {
            request = fetch(`${endpoint}/resume-auto`, {
              method: "POST",
              credentials: "include",
            });
          } else {
            request = fetch(`${endpoint}/regenerate`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({ model: args[0] }),
            });
          }

          return request
            .then(async (res) => {
              const json = await res.json().catch(() => ({} as any));
              if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
              if (!json.data) throw new Error("Malformed memory response");
              return json.data;
            });
        }
        case "updateSummaryceptionSnippet": {
          const sid = sessionIdRef.current;
          if (!sid) return Promise.reject(new Error("No active session"));
          const snippetId = encodeURIComponent(String(args[0] ?? ""));
          return fetch(`${apiBase}/api/sessions/${sid}/summaryception/snippets/${snippetId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ text: String(args[1] ?? "") }),
          }).then(async (res) => {
            const json = await res.json().catch(() => ({} as any));
            if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
            if (!json.data) throw new Error("Malformed snippet response");
            return json.data;
          });
        }
        // Pinning is a global user preference, not session state — no session
        // id guard here, or the pin is silently dropped and the sandbox star
        // lights for a change that never happened. Both return the resulting
        // list so the picker renders the truth instead of an optimistic guess.
        case "pinModel": {
          return Promise.all([
            import("@/stores/config"),
            import("@/stores/models"),
          ]).then(([configModule, modelsModule]) => {
            const scope = modelsModule.pinScopeFromSourceKey(
              modelsModule.useModelsStore.getState().lastSourceKey,
            );
            const accepted = configModule.useConfigStore.getState().pinModel(args[0] as string, scope);
            return { pinnedModels: pinnedFor(configModule.useConfigStore.getState(), scope), accepted };
          });
        }
        case "unpinModel": {
          return Promise.all([
            import("@/stores/config"),
            import("@/stores/models"),
          ]).then(([configModule, modelsModule]) => {
            const scope = modelsModule.pinScopeFromSourceKey(
              modelsModule.useModelsStore.getState().lastSourceKey,
            );
            configModule.useConfigStore.getState().unpinModel(args[0] as string, scope);
            return { pinnedModels: pinnedFor(configModule.useConfigStore.getState(), scope), accepted: true };
          });
        }
        case "setMixMode": {
          import("@/stores/config").then(m => m.useConfigStore.getState().setConfig("mixMode", args[0] as boolean)).catch(() => {});
          return;
        }
        case "addToPool": {
          import("@/stores/config").then(m => m.useConfigStore.getState().addToPool(args[0] as string)).catch(() => {});
          return;
        }
        case "removeFromPool": {
          import("@/stores/config").then(m => m.useConfigStore.getState().removeFromPool(args[0] as string)).catch(() => {});
          return;
        }
        case "setPoolWeight": {
          import("@/stores/config").then(m => m.useConfigStore.getState().setPoolWeight(args[0] as string, args[1] as number)).catch(() => {});
          return;
        }
        case "togglePoolLock": {
          import("@/stores/config").then(m => m.useConfigStore.getState().togglePoolLock(args[0] as string)).catch(() => {});
          return;
        }
        case "setPreferredProvider": {
          const sid = sessionIdRef.current;
          if (!sid) return Promise.resolve({ ok: false, error: "No active session" });

          const nextProvider = args[0] === "private" ? "private" : "official";
          return (async () => {
            const [
              { useUserProfileStore },
              { useConfigStore },
              { useModelsStore },
            ] = await Promise.all([
              import("@/stores/user-profile"),
              import("@/stores/config"),
              import("@/stores/models"),
            ]);

            await savePreferredProvider(nextProvider);

            if (nextProvider === "official") {
              const plan = useCreditStore.getState().plan ?? "free";
              const current = useConfigStore.getState().selectedModel;
              const model = resolveOfficialSelectedModel(current, plan);
              if (model !== current) {
                useConfigStore.getState().setConfig("selectedModel", model);
              }
            } else {
              const activeKeyId =
                (useUserProfileStore.getState().profile?.preferences?.activeApiKeyId as string | undefined)
                ?? null;
              const profiles = await fetchApiKeyModelProfiles(apiBase).catch(() => []);
              const model = resolvePrivateSelectedModel(profiles, activeKeyId);
              if (model && model !== useConfigStore.getState().selectedModel) {
                useConfigStore.getState().setConfig("selectedModel", model);
              }
            }

            void useModelsStore.getState().fetchModels();

            return { ok: true, provider: nextProvider };
          })().catch((err) => ({
            ok: false,
            error: err instanceof Error ? err.message : "Failed to switch provider",
          }));
        }
        // ── Multiplayer room (game-rt relay) ──
        // Spec: docs/superpowers/specs/2026-08-24-game-room-primitives-design.md §6.
        case "room.join": {
          const roomId = String(args[0] ?? "");
          if (!roomId) return { ok: false, reason: "no-room" };
          gameRoomRef.current?.destroy();
          const connection = new GameRoomConnection((frame) => sendRoomFrameRef.current?.(frame));
          gameRoomRef.current = connection;
          return connection.join(roomId);
        }
        case "room.leave": {
          gameRoomRef.current?.destroy();
          gameRoomRef.current = null;
          return;
        }
        case "room.input": {
          gameRoomRef.current?.sendInput((args[0] ?? {}) as Record<string, unknown>);
          return;
        }
        case "room.cmd": {
          const connection = gameRoomRef.current;
          if (!connection) return { ok: false, body: { reason: "not-connected" } };
          return connection.sendCommand(String(args[0] ?? ""), args[1]);
        }
        case "showToast": {
          const [msg, type] = args as [string, string?];
          const text = toPillText(msg);
          if (!text) return;
          try {
            // Only a real failure is red; a card's "warning" is authored guidance.
            if (type === "error") feedback.error(text);
            else feedback.notice(text);
          } catch {
            /* dev-only copy guard — a card's wording must not break the card */
          }
          return;
        }
        // ── Storage ──
        // Keys are ALWAYS confined to THIS world's namespaces. The old code
        // passed through ANY key starting with "yumina:", which let sandbox
        // code read/write OTHER worlds' storage (and any host-side yumina:*
        // key) by crafting the prefix itself. Pre-scoped keys are accepted
        // only when they already sit inside this world's own namespaces —
        // the compat shims (localStorage/sessionStorage) legitimately send
        // full `yumina:{local|session}:{worldId}:` keys; everything else gets
        // the default namespace applied here, never trusted from the caller.
        case "storage.get": {
          return localStorage.getItem(scopeStorageKey(worldIdRef.current, args[0] as string));
        }
        case "storage.set": {
          const key = scopeStorageKey(worldIdRef.current, args[0] as string);
          try {
            localStorage.setItem(key, args[1] as string);
          } catch {
            evictOldestYuminaKeys(key);
            try {
              localStorage.setItem(key, args[1] as string);
            } catch {
              console.warn("[WorldRenderer] localStorage quota exceeded, write dropped");
              return { error: "quota_exceeded" };
            }
          }
          return;
        }
        case "storage.remove": {
          localStorage.removeItem(scopeStorageKey(worldIdRef.current, args[0] as string));
          return;
        }
        case "storage.clear": {
          // The caller-supplied value is either a compat-shim namespace prefix
          // (accepted via the same this-world-only rule) or a sub-prefix
          // within the default namespace — never a raw localStorage prefix.
          const prefix = scopeStorageKey(worldIdRef.current, (args[0] as string | undefined) ?? "");
          for (let i = localStorage.length - 1; i >= 0; i--) {
            const k = localStorage.key(i);
            if (k?.startsWith(prefix)) localStorage.removeItem(k);
          }
          return;
        }
        default:
          // The cases above ARE the RPC allowlist — reject anything else
          // loudly and resolve the caller with an error instead of letting
          // its 10s bridge timeout expire.
          console.warn(`[WorldRenderer] Rejected unknown sandbox API call: ${method}`);
          return { error: `unknown_method:${method}` };
      }
    },
    [i18n, navigateToStory, router],
  );

  // ── Streaming API call handler (LLM completions) ──
  const handleStreamCall = useCallback(
    (
      method: string,
      args: unknown[],
      callbacks: {
        onDelta: (text: string) => void;
        onDone: (fullText: string) => void;
        onError: (error: string) => void;
      },
    ) => {
      if (method !== "ai.complete") {
        callbacks.onError(`Unknown streaming method: ${method}`);
        return;
      }

      const params = args[0] as {
        messages?: Array<{ role: string; content: string }>;
        model?: string;
        maxTokens?: number;
        temperature?: number;
        includeLorebook?: boolean | "all" | "matched";
      } | undefined;

      if (!params?.messages?.length) {
        callbacks.onError("messages array is required");
        return;
      }

      const sid = sessionIdRef.current;
      if (!sid) {
        callbacks.onError("No active session");
        return;
      }

      // Make the fetch to the completions endpoint and stream deltas back
      (async () => {
        try {
          const res = await fetch(`/api/sessions/${sid}/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              messages: params.messages,
              model: params.model,
              maxTokens: params.maxTokens,
              temperature: params.temperature,
              includeLorebook: params.includeLorebook,
            }),
          });

          if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }));
            callbacks.onError(err.error ?? `HTTP ${res.status}`);
            return;
          }

          const reader = res.body?.getReader();
          if (!reader) {
            callbacks.onError("No response stream");
            return;
          }

          // The endpoint's `done` frame repeats the entire reply and its
          // `error` frame carries no text, so the frames have to be told apart
          // by event name — see side-call-stream.ts.
          const decoder = new TextDecoder();
          const sse = createSideCallStreamReader(callbacks);

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            sse.push(decoder.decode(value, { stream: true }));
          }

          sse.end();
        } catch (err: any) {
          callbacks.onError(err?.message ?? "Fetch failed");
        }
      })();
    },
    [],
  );

  const handleError = useCallback((message: string) => {
    console.warn("[WorldRenderer] Component error:", message);
  }, []);

  // Sandbox self-diagnostics → PostHog. Today this is the scroll-clamp
  // watchdog reporting that it corrected a stuck scroll offset (the "game UI
  // pushed up, blank space below" bug) — capturing it fleet-wide tells us how
  // often the underlying browser bug fires and on which devices, instead of
  // waiting for user reports. Same direct-capture convention as
  // chunk_load_diagnostic (stale-chunk-reload.ts).
  const handleDiag = useCallback((event: string, data: Record<string, string | number | boolean>) => {
    try {
      posthog.capture(`sandbox_diag_${event.replace(/[^a-z0-9]+/gi, "_")}`, {
        ...data,
        world_id: worldId,
      });
    } catch {
      // Analytics must never break play.
    }
  }, [worldId]);

  // ── Stale child-viewport healer ──
  //
  // On some devices (Android-heavy) the child frame misses the final resize
  // after the iframe shrinks and grows back (keyboard close, URL-bar settle):
  // it keeps laying out at the stale SHORT height, anchored top, and the
  // bottom band of the iframe shows the engine's unpainted default (grey) —
  // user reports of "game canvas pushed up, grey space below". Every layer we
  // paint is near-black, so a grey band can only be an unrendered region.
  //
  // Detection: the sandbox already reports its perceived viewport height
  // (hostRef is 100% tall → its ResizeObserver report IS the child's believed
  // height). Compare that against the iframe element's true height; a
  // persistent disagreement while both sides are stable = the child missed a
  // resize. Heal: shrink the iframe by 1px for one frame and restore — that
  // forces the engine to re-deliver the true viewport size to the child,
  // which re-lays-out and repaints the full frame.
  const iframeElRef = useRef<HTMLIFrameElement | null>(null);
  const childViewportHRef = useRef<number | null>(null);
  const mismatchTimerRef = useRef<number | null>(null);
  const mismatchVerifyTimerRef = useRef<number | null>(null);
  const healBudgetRef = useRef(3); // per mount — enough to heal, never a reflow loop
  const lastHealAtRef = useRef(0);

  const scheduleViewportMismatchCheck = useCallback(() => {
    if (mismatchTimerRef.current !== null) return;
    mismatchTimerRef.current = window.setTimeout(() => {
      mismatchTimerRef.current = null;
      const iframe = iframeElRef.current;
      const childH = childViewportHRef.current;
      if (!iframe || childH === null) return;
      const parentH1 = iframe.getBoundingClientRect().height;
      // Hidden/collapsed host (persistent-chat keep-alive, background tab
      // layout) — a 0-height iframe vs a stale child report is not the bug.
      if (parentH1 < 50) return;
      // 8px slack: fractional-DPR rounding and the child's Math.ceil'd report.
      if (Math.abs(parentH1 - childH) <= 8) return;
      // Re-verify after a settle delay — keyboard/orientation animations make
      // the two sides legitimately disagree for a few frames.
      mismatchVerifyTimerRef.current = window.setTimeout(() => {
        mismatchVerifyTimerRef.current = null;
        const iframe2 = iframeElRef.current;
        const childH2 = childViewportHRef.current;
        if (!iframe2 || childH2 === null) return;
        const parentH2 = iframe2.getBoundingClientRect().height;
        if (parentH2 < 50) return; // host hidden mid-check
        if (Math.abs(parentH2 - childH2) <= 8) return; // resolved itself
        if (Math.abs(parentH2 - parentH1) > 1 || childH2 !== childH) {
          // Either side still moving — not stuck yet, watch another round.
          scheduleViewportMismatchCheck();
          return;
        }
        const now = Date.now();
        if (healBudgetRef.current <= 0 || now - lastHealAtRef.current < 10_000) return;
        healBudgetRef.current -= 1;
        lastHealAtRef.current = now;
        iframe2.style.height = "calc(100% - 1px)";
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (iframeElRef.current) iframeElRef.current.style.height = "100%";
          });
        });
        try {
          posthog.capture("sandbox_diag_viewport_healed", {
            parent_h: Math.round(parentH2),
            child_h: Math.round(childH2),
            world_id: worldId,
          });
        } catch {
          // Analytics must never break play.
        }
      }, 450);
    }, 350);
  }, [worldId]);

  // The child's height reports drive one side of the comparison…
  const handleSandboxResize = useCallback((height: number) => {
    childViewportHRef.current = height;
    scheduleViewportMismatchCheck();
  }, [scheduleViewportMismatchCheck]);

  // …and parent-side iframe resizes (keyboard inset, orientation, window)
  // drive the other. Healthy frames re-report within a frame or two, so the
  // settle-recheck above sees agreement and does nothing.
  useEffect(() => {
    const el = iframeElRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => scheduleViewportMismatchCheck());
    ro.observe(el);
    return () => ro.disconnect();
  }, [scheduleViewportMismatchCheck]);

  useEffect(() => {
    return () => {
      if (mismatchTimerRef.current !== null) window.clearTimeout(mismatchTimerRef.current);
      if (mismatchVerifyTimerRef.current !== null) window.clearTimeout(mismatchVerifyTimerRef.current);
    };
  }, []);

  // ── Composer draft: mirror out of the iframe, restore after a reload ──
  // The composer's text can only live here. Its iframe runs `allow-scripts`
  // without `allow-same-origin`, so sessionStorage throws in there. Holding it
  // parent-side also lets main.tsx's deploy check see that a message is
  // half-typed and refuse to reload over it.
  const handleComposerDraft = useCallback((text: string) => {
    setComposerDraft(sessionIdRef.current, text);
  }, []);

  // Leaving this chat — or switching to another session — must clear the
  // in-memory mirror, or a draft belonging to a page the user is no longer on
  // would block the deploy refresh for the rest of the tab's life. The stored
  // copy stays, so coming back to that session still restores it.
  useEffect(() => {
    resetComposerDraftMirror();
    return resetComposerDraftMirror;
  }, [sessionId]);

  const {
    ready: sandboxReady,
    rendered: worldRendered,
    iframeRefCallback,
    sandboxUrl,
    installRoot,
    pushChannel,
    setMediaSuspended,
    sendAudioEnded,
    restoreComposerDraft,
    restoreTranscriptPosition,
    sendRoomFrame,
    openMemoryPanel,
  } = useSandbox({
    onApiCall: handleApiCall,
    onStreamCall: handleStreamCall,
    onError: handleError,
    onDiag: handleDiag,
    onResize: handleSandboxResize,
    onComposerDraft: handleComposerDraft,
    onPlayInteraction: () => { if (mode !== "guest-preview") notePlayInteraction(sessionId); },
    sandboxUrlOverride: SANDBOX_URL,
  });

  const combinedIframeRef = useCallback((el: HTMLIFrameElement | null) => {
    iframeElRef.current = el;
    iframeRefCallback(el);
  }, [iframeRefCallback]);

  // Play-controls-bar fallback: the fullscreen floating bar (parent chrome)
  // dispatches this when the player asks for the memory panel — worlds whose
  // custom UI has no Memory pill still need a way in. Forwarded across the
  // bridge; the sandbox mounts the extension's modal host-level.
  useEffect(() => {
    const handler = () => openMemoryPanel();
    window.addEventListener("yumina:request-memory-panel", handler);
    return () => window.removeEventListener("yumina:request-memory-panel", handler);
  }, [openMemoryPanel]);

  // Multiplayer relay: keep the frame pump pointed at the live bridge, and
  // tear the socket down when the session unmounts or changes.
  sendRoomFrameRef.current = sendRoomFrame;
  useEffect(() => {
    return () => {
      gameRoomRef.current?.destroy();
      gameRoomRef.current = null;
    };
  }, [sessionId]);

  // Push a saved draft back once the composer exists to receive it. This waits
  // on `rendered`, not `ready`: `ready` only means the iframe runtime booted,
  // which is before install-root, before ChatCanvas, and so before
  // MessageInput has registered the listener — the restore would land with
  // nothing listening and the text would sit invisible in storage.
  const draftRestoredForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!worldRendered) return;
    if (draftRestoredForRef.current === sessionId) return;
    draftRestoredForRef.current = sessionId;
    const saved = loadComposerDraft(sessionId);
    if (saved) restoreComposerDraft(saved);
  }, [worldRendered, sessionId, restoreComposerDraft]);

  useEffect(() => {
    if (worldRendered) restoreTranscriptPosition(api.currentUser?.id ?? "guest", sessionId);
  }, [worldRendered, sessionId, api.currentUser?.id, restoreTranscriptPosition]);

  // ── Loading overlay: keep a spinner up until the world actually paints ──
  // worldRendered flips when the sandbox reports its root component's first
  // paint (component-host posts "rendered" after a double-rAF). Gating on this
  // instead of the boot handshake removes the "spinner gone -> grey gap -> pop-in"
  // that the opacity-on-ready gate produced.
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    if (worldRendered) setRevealed(true);
  }, [worldRendered]);
  // Safety net: once the iframe runtime has booted, reveal after a grace window
  // even if no paint signal arrives (e.g. a stale cached sandbox build that
  // predates the "rendered" message, or a world that renders nothing) — so we
  // never cover the iframe forever.
  useEffect(() => {
    if (!sandboxReady) return;
    const t = window.setTimeout(() => setRevealed(true), 5000);
    return () => window.clearTimeout(t);
  }, [sandboxReady]);

  // ── Boot watchdog: the iframe document itself failing to load ─────────────
  // The safety net above only arms once the runtime has booted, so it cannot
  // cover the case where the sandbox DOCUMENT never arrives — a 503 during a
  // deploy swap, a dropped connection, an edge hiccup. There is no `error`
  // event to hook either: a 503 still *loads* (the error page renders), so the
  // only observable symptom is a ready handshake that never comes. Left alone
  // that is a spinner with no end, no message, and no way out but a manual
  // reload — exactly what users reported on custom-UI cards (2026-08-25).
  //
  // This deliberately does NOT re-mount on its own. A slow phone on a bad
  // connection can legitimately still be fetching the runtime here, and
  // auto-remounting would throw away a download that was about to finish and
  // restart the card's intro. So: surface a button, let the user decide. If the
  // handshake does land late, `sandboxReady` clears the failure by itself and
  // the spinner resumes as if nothing happened.
  //
  // Two deadlines, because one cannot serve both cases it has to cover. A 3G
  // phone legitimately needs longer than 15s to pull the runtime cold, and
  // calling that a failure told people their world was broken while it was
  // still downloading — which is most of what the 2026-08-29 triage found
  // behind 17-29 people a day pressing retry. So 15s only says "still going,
  // your connection is slow" and keeps the spinner up; the failure message and
  // the retry button wait for 40s.
  const BOOT_SLOW_MS = 15_000;
  const BOOT_TIMEOUT_MS = 40_000;
  const [bootAttempt, setBootAttempt] = useState(0);
  const [bootSlow, setBootSlow] = useState(false);
  const [bootFailed, setBootFailed] = useState(false);
  const bootStartedAtRef = useRef(Date.now());
  // What the user was last told, read by the recovery effect without making it
  // a dependency of the timer effect (which would restart both deadlines).
  const bootShownRef = useRef<"slow" | "failed" | null>(null);

  useEffect(() => {
    if (sandboxReady) return;
    bootStartedAtRef.current = Date.now();
    const slow = window.setTimeout(() => {
      bootShownRef.current = "slow";
      setBootSlow(true);
    }, BOOT_SLOW_MS);
    const dead = window.setTimeout(() => {
      bootShownRef.current = "failed";
      setBootFailed(true);
      posthog.capture("sandbox_boot_timeout", {
        world_id: worldId,
        attempt: bootAttempt,
        duration_ms: Date.now() - bootStartedAtRef.current,
        connection_type: bootConnectionType(),
      });
    }, BOOT_TIMEOUT_MS);
    return () => {
      window.clearTimeout(slow);
      window.clearTimeout(dead);
    };
  }, [sandboxReady, bootAttempt, worldId]);

  // A handshake landing after we cried wolf is the measurement that the old
  // single-deadline watchdog could not make: it separates "slow" from "broken",
  // which is what decides whether the deadlines or the payload need the work.
  useEffect(() => {
    if (!sandboxReady) return;
    if (bootShownRef.current) {
      posthog.capture("sandbox_boot_recovered", {
        world_id: worldId,
        attempt: bootAttempt,
        shown: bootShownRef.current,
        duration_ms: Date.now() - bootStartedAtRef.current,
        connection_type: bootConnectionType(),
      });
      bootShownRef.current = null;
    }
    setBootSlow(false);
    setBootFailed(false);
  }, [sandboxReady, bootAttempt, worldId]);

  const retryBoot = useCallback(() => {
    bootShownRef.current = null;
    setBootSlow(false);
    setBootFailed(false);
    setBootAttempt((n) => n + 1);
  }, []);

  // Attempt 0 loads the content-hashed document. Retries drop back to the
  // authored path, which is never hashed and so cannot go missing — the case
  // that needs it is a tab left open across a deploy that changed the document,
  // where the hash this bundle was built with no longer exists on the server.
  // The retry counter is what actually forces the re-fetch: without a changing
  // query string a browser that cached the failed response would replay it on
  // every attempt. The rest of the query (parentOrigin, which the sandbox needs
  // to validate inbound messages) is carried across verbatim.
  const bootUrl = useMemo(() => {
    if (bootAttempt === 0) return sandboxUrl;
    const q = sandboxUrl.includes("?") ? sandboxUrl.slice(sandboxUrl.indexOf("?") + 1) : "";
    return `${SANDBOX_DOC_RETRY_URL}?${q ? `${q}&` : ""}retry=${bootAttempt}`;
  }, [sandboxUrl, bootAttempt]);

  // Pause raw <video>/<audio> inside the sandbox whenever this renderer is not
  // the visible session. Belt-and-suspenders with useAudioStore.cleanup() in
  // ChatView: that one stops SDK-started audio (parent-window Audio elements),
  // this one stops creator-embedded media tags that live inside the iframe DOM.
  useEffect(() => {
    setMediaSuspended(!isActive);
  }, [isActive, setMediaSuspended]);

  // Forward SDK track-ended notifications into the sandbox so creator code
  // (api.onAudioEnded) can react — e.g. a music player auto-advancing.
  useEffect(() => onAudioTrackEnded(sendAudioEnded), [sendAudioEnded]);

  // ── Install root component when files change ──
  // Fire in parallel with iframe boot — SandboxBridge queues messages sent before
  // the iframe signals ready and flushes on handshake. This removes the
  // iframe-boot → ready → compile → install waterfall, which was the dominant
  // cold-first-load cost: the parent compile now overlaps with iframe fetch.
  const lastFilesKeyRef = useRef<string>("");
  useEffect(() => {
    if (!files || !entryFile) return;
    const filesKey = JSON.stringify({ entryFile, files });
    if (filesKey === lastFilesKeyRef.current) return;
    lastFilesKeyRef.current = filesKey;

    (async () => {
      const fileKeys = Object.keys(files);
      try {
        // Fast path: a valid pre-compiled blob (stamped at save-time) lets us
        // skip the in-browser Sucrase/bundler compile entirely. isCompiledValid
        // re-checks the file hash + compiler version, so a stale or wrong-version
        // blob falls through to a fresh compile below.
        if (isCompiledValid(precompiled, entryFile, files)) {
          installRoot(entryFile, files, precompiled.code, undefined, mode);
          return;
        }
        if (fileKeys.length <= 1) {
          const { transformTSX } = await import("@/features/studio/lib/tsx-compiler");
          const single = files[entryFile] ?? files[fileKeys[0] ?? ""] ?? "";
          const transformed = transformTSX(single);
          if (transformed.code) {
            installRoot(entryFile, files, transformed.code, undefined, mode);
          } else {
            installRoot(entryFile, files, undefined, transformed.error ?? "Compile failed", mode);
          }
        } else {
          const { bundleTSX } = await import("@/features/studio/lib/tsx-bundler");
          const bundled = bundleTSX({ files, entryFile });
          if (bundled.code) {
            installRoot(entryFile, files, bundled.code, undefined, mode);
          } else {
            installRoot(entryFile, files, undefined, bundled.error ?? "Bundle failed", mode);
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Pre-compile failed";
        installRoot(entryFile, files, undefined, msg, mode);
      }
    })();
    // Reset the install guard on teardown so a remount re-installs onto the
    // freshly-created SandboxBridge. Without this, React StrictMode's dev
    // double-invoke (mount → cleanup → mount) installs onto the first bridge,
    // which is then destroyed; the second mount sees an unchanged filesKey and
    // skips re-install, so the live bridge never receives the root component →
    // black screen (precompiled cards especially, since their synchronous send
    // races the bridge handshake — the live-compile path's `await import` masks it).
    return () => {
      lastFilesKeyRef.current = "";
    };
  }, [entryFile, files, precompiled, installRoot, mode]);

  // ── Channel-based state pushing ──
  // Track per-channel version + JSON cache
  const channelCache = useRef<Record<string, { json: string; version: number }>>({});

  function pushIfChanged<C extends StateChannel>(channel: C, data: ChannelDataMap[C]) {
    const json = JSON.stringify(data);
    const cached = channelCache.current[channel];
    if (cached && cached.json === json) return; // No change
    const version = (cached?.version ?? 0) + 1;
    channelCache.current[channel] = { json, version };
    pushChannel(channel, data, version);
  }

  // Same teardown reset as the install effect above: when the SandboxBridge is
  // torn down + recreated (React StrictMode dev double-invoke, or any remount),
  // drop the per-channel cache so the channel effects below re-push their data
  // onto the fresh bridge. Without this, the cache still holds the old bridge's
  // versions and pushIfChanged short-circuits → the live bridge never receives
  // variables/messages/etc. (e.g. the seeded first message never appears).
  useEffect(() => {
    return () => {
      channelCache.current = {};
    };
  }, []);

  // Slim the messages payload before it crosses the bridge (see slim-messages.ts):
  // drops swipe data the iframe never renders. Memoized on api.messages so the
  // heavy messages-channel push below only re-runs when messages actually change,
  // not on every parent render (e.g. each streaming delta).
  const slimmedMessages = useMemo(() => slimMessages(api.messages ?? []), [api.messages]);

  // Display name → id, for names that aren't already an id. Memoized on the
  // defs so the channel payload stays reference-stable between pushes.
  const variableIdsByName = useMemo(() => {
    if (!variableDefs?.length) return undefined;
    const ids = new Set(variableDefs.map((v) => v.id));
    const map: Record<string, string> = {};
    for (const v of variableDefs) {
      const name = v.name?.trim();
      if (!name || name === v.id || ids.has(name)) continue;
      map[name] = v.id;
    }
    return Object.keys(map).length ? map : undefined;
  }, [variableDefs]);

  // Push variables channel
  useEffect(() => {
    const data: VariablesChannelData = {
      variables: variables as Record<string, unknown>,
      globalVariables: (api.globalVariables ?? variables) as Record<string, unknown>,
      ...(variableIdsByName ? { variableIdsByName } : {}),
    };
    pushIfChanged("variables", data);
  }, [variables, api.globalVariables, variableIdsByName]);

  // Push messages channel — runs only when slimmedMessages changes (i.e. messages
  // changed), so its large JSON.stringify in pushIfChanged no longer fires on
  // every parent render during streaming.
  useEffect(() => {
    const data: MessagesChannelData = { messages: slimmedMessages };
    pushIfChanged("messages", data);
  }, [slimmedMessages]);

  // Push streaming channel
  useEffect(() => {
    const data: StreamingChannelData = {
      isStreaming: api.isStreaming ?? false,
      content: api.streamingContent ?? "",
      reasoning: (api as any).streamingReasoning ?? "",
      bg: null, // Streaming bg is handled via variables
    };
    pushIfChanged("streaming", data);
  }, [api.isStreaming, api.streamingContent, (api as any).streamingReasoning]);

  // Push session channel (rarely changes)
  useEffect(() => {
    // Sort by position so cards that iterate `api.entries` get a stable,
    // schema-faithful order without each author having to remember to .sort().
    const slimEntries: SandboxEntry[] = (entries ?? [])
      .filter((e) => e.enabled !== false)
      .slice()
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map((e) => ({
        id: e.id,
        name: e.name,
        content: e.content,
        keywords: Array.isArray(e.keywords) ? e.keywords : [],
        position: e.position,
        section: e.section,
        enabled: e.enabled,
        role: e.role ?? "lore",
        tags: e.tags,
        conditions: e.conditions ?? [],
        conditionLogic: e.conditionLogic ?? "all",
        // Resolved here (the sandbox boundary) so the bubble can drop it straight
        // into an <img src> — the sandbox never sees a raw @asset: ref.
        portrait: e.portrait ? absoluteImageUrl(e.portrait) : null,
      }));
    const data: SessionChannelData = {
      worldId,
      worldName: api.worldName,
      worldCover: api.worldCover ?? null,
      sessionId,
      // Resolved here as well as in chat-view: this effect IS the sandbox
      // boundary, so any caller that hands us a raw S3 key or relative ref
      // still pushes a fetchable absolute URL across the bridge.
      currentUser: api.currentUser
        ? { ...api.currentUser, image: absoluteImageUrl(api.currentUser.image) }
        : null,
      user: user ?? {
        // Same identity fallback as chat-view.tsx, used when a caller doesn't
        // supply a pre-branched persona-aware user. Avoid literal "User" — this
        // value ends up rendered as {user.name} in custom TSX, so "Player" is the
        // anchor label.
        name:
          (api.currentUser as { username?: string | null } | null)?.username
          || (api.currentUser as { displayUsername?: string | null } | null)?.displayUsername
          || api.currentUser?.name
          || "Player",
        avatar: absoluteImageUrl(api.currentUser?.image) ?? null,
      },
      entries: slimEntries,
      loreUiBindings: loreUiBindings ?? [],
      worldbooks: worldbooks ?? [],
    };
    pushIfChanged("session", data);
  }, [worldId, sessionId, api.worldName, api.worldCover, api.currentUser, user, entries, loreUiBindings, worldbooks]);

  // Push UI channel. Intentionally left without a dependency array: it carries
  // ~15 small fields (pendingChoices, model picker, checkpoints, volumes, …),
  // its payload is KB not MB, and pushIfChanged already no-ops when unchanged.
  // Enumerating exact deps here risks a missed dep silently freezing one of
  // those fields in the iframe (stale model picker / pending choices) — not
  // worth it for a cheap stringify. The expensive channel (messages) is gated above.
  useEffect(() => {
    const data: UIChannelData = {
      pendingChoices: (api as any).pendingChoices ?? [],
      error: (api as any).error ?? null,
      readOnly: (api as any).readOnly ?? false,
      checkpoints: (api as any).checkpoints ?? [],
      greetingContent: (api as any).greetingContent ?? null,
      selectedModel: (api as any).selectedModel ?? "",
      modelFallback,
      userPlan: (api as any).userPlan ?? "free",
      memorySummaryEnabled: (api as any).memorySummaryEnabled ?? false,
      installedExtensions: (api as any).installedExtensions ?? [],
      preferredProvider: (api as any).preferredProvider ?? "official",
      mixMode: (api as any).mixMode ?? false,
      modelPool: (api as any).modelPool ?? [],
      hasEarlierMessages: (api as any).hasEarlierMessages ?? false,
      isLoadingEarlier: (api as any).isLoadingEarlier ?? false,
      bgmVolume,
      sfxVolume,
      language,
      balance: mushieBalance,
      mode,
      capabilities,
      composerSendKey,
      uiFontScale,
      sendFailureNonce: (api as any).sendFailureNonce ?? 0,
    };
    pushIfChanged("ui", data);
  });

  return (
    <div
      className={className}
      style={{
        position: "relative",
        background: "var(--color-background, #121316)",
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      <iframe
        // `key` on the attempt counter is what re-mounts the element, so a
        // retry is a genuinely fresh document fetch rather than a no-op src set.
        key={bootAttempt}
        ref={combinedIframeRef}
        src={bootUrl}
        sandbox="allow-scripts allow-pointer-lock"
        allow="autoplay; fullscreen; pointer-lock"
        referrerPolicy="no-referrer"
        title="Yumina Sandbox"
        style={{
          border: "none",
          width: "100%",
          height: "100%",
          display: "block",
          background: "var(--color-background, #121316)",
          colorScheme: "dark",
          opacity: revealed ? 1 : 0,
          transition: "opacity 150ms ease",
        }}
      />
      {!revealed && (
        <div
          className="absolute inset-0 flex items-center justify-center"
          style={{
            background: "var(--color-background, #121316)",
            pointerEvents: bootFailed ? "auto" : "none",
          }}
        >
          {bootFailed ? (
            <div className="flex max-w-xs flex-col items-center gap-3 px-6 text-center">
              <p className="text-sm text-muted-foreground">
                {i18n.t(
                  "chat:view.sandboxBootFailed",
                  "Couldn't load this world's interface. Check your connection and try again.",
                )}
              </p>
              <button
                type="button"
                onClick={retryBoot}
                className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-muted"
              >
                {i18n.t("chat:view.retry", "Retry")}
              </button>
            </div>
          ) : (
            // The spinner stays through the slow stage — the download really is
            // still running, and swapping it for an error would be a lie.
            <div className="flex max-w-xs flex-col items-center gap-3 px-6 text-center">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
              {bootSlow && (
                <p className="text-xs text-muted-foreground">
                  {i18n.t(
                    "chat:view.sandboxBootSlow",
                    "Still loading — your connection looks slow.",
                  )}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
