import React, { Component, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useEditorStore } from "@/stores/editor";
import { useStudioSidebarStore } from "@/stores/studio-sidebar";
import {
  type YuminaAPI,
  type TrackedListener,
  applyRuntimeStyleFixes,
  hardenImages,
  resolveStyleAssetRefs,
  rewriteMediaToContainerQueries,
  rewriteShadowRootSelectors,
} from "../lib/custom-component-renderer";
import { bundleAndCompile, type BundleInput, type CompileRuntimeScope } from "../lib/tsx-bundler";
import { renderMessage } from "@/lib/markdown";
import { getAssetCdnUrl } from "@/lib/asset-url";
import { useAudioStore } from "@/stores/audio";
import { Layers, AlertCircle } from "lucide-react";
import { CopyErrorButton } from "@/components/copy-error-button";

// ── Mock bubble props for canvas preview ────────────────────────────
interface MockBubbleProps {
  contentHtml: string;
  rawContent: string;
  role: "user" | "assistant";
  messageIndex: number;
  isStreaming: boolean;
  stateSnapshot: null;
  variables: Record<string, unknown>;
  renderMarkdown: (text: string) => string;
}

const PHONE_PREVIEW_MAX_WIDTH = "375px";

const EMPTY_OVERRIDES: Record<string, number | string | boolean | Record<string, unknown> | unknown[]> = {};

// ── Error boundary ───────────────────────────────────────────────────
// Catches runtime errors thrown by the compiled card component — without
// this, any throw during render/useEffect inside the user's TSX crashes the
// entire Studio Canvas panel. Matches the ErrorBoundary pattern in the
// sandbox's component-host and custom-component-renderer. Callers should
// set a React `key` tied to the compiled bundle so a fresh bundle gets a
// fresh boundary (clearing any stale error state from a previous compile).

class CanvasErrorBoundary extends Component<
  { children: React.ReactNode },
  { error: string | null }
> {
  state = { error: null as string | null };

  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }

  render() {
    if (this.state.error) {
      const err = this.state.error;
      return (
        <div className="relative flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 pr-9 m-4">
          <AlertCircle className="h-4 w-4 shrink-0 text-destructive mt-0.5" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-destructive">Component runtime error</p>
            <p className="mt-1 text-xs text-destructive/70 font-mono break-all whitespace-pre-wrap">{err}</p>
          </div>
          <CopyErrorButton text={`Component runtime error:\n${err}`} />
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Shared shell ─────────────────────────────────────────────────────

function CanvasShell({ children, isEmpty, fullBleed }: { children: React.ReactNode; isEmpty: boolean; fullBleed?: boolean }) {
  return (
    <div className="flex h-full flex-col bg-muted/30">
      {/* Preview area */}
      <div className="flex flex-1 justify-center overflow-y-auto overscroll-contain p-2 sm:p-6">
        <div
          className="h-full w-full"
          style={{ maxWidth: PHONE_PREVIEW_MAX_WIDTH }}
        >
          <DeviceFrame fullBleed={fullBleed}>{isEmpty ? <EmptyState /> : children}</DeviceFrame>
        </div>
      </div>
    </div>
  );
}

// ── Asset processing wrapper — resolves @asset: refs in rendered DOM ──
// Mirrors the MutationObserver pipeline from the sandbox iframe so that
// images and CSS background-image refs using @asset:{id} work in studio.

function AssetProcessingWrapper({ children }: { children: React.ReactNode }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const tracked: TrackedListener[] = [];
    let rafId: number | null = null;
    let suppressObserver = false;

    const process = () => {
      suppressObserver = true;
      // Rewrite simple @media (max/min-width) queries to @container queries so
      // the phone/tablet frame actually triggers responsive CSS in the preview.
      // The wrapper div below sets `container-type: inline-size` to match.
      // Playtime uses a real iframe where @media resolves correctly, so this
      // transform only runs in the studio canvas path.
      rewriteMediaToContainerQueries(host);
      // Remap top-level :root/html/body selectors to :host so theme variables
      // and root-level styles keep working inside the Shadow Root that wraps
      // this subtree. Without this, cards declaring `:root { --x: ... }` would
      // render with their CSS variables undefined inside the canvas preview.
      rewriteShadowRootSelectors(host);
      applyRuntimeStyleFixes(host, tracked);
      hardenImages(host, tracked);
      void resolveStyleAssetRefs(host);
      queueMicrotask(() => { suppressObserver = false; });
    };

    process();

    const scheduleProcess = () => {
      if (suppressObserver || rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        process();
      });
    };

    const observer = new MutationObserver(scheduleProcess);
    observer.observe(host, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "src", "style"],
    });

    return () => {
      observer.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
      for (const t of tracked) t.el.removeEventListener(t.type, t.fn);
    };
  }, []);

  // `containerType: inline-size` turns this div into a CSS container so that
  // @container queries (the rewrite above converts @media → @container) resolve
  // against THIS element's width. When CanvasShell constrains this to 375px
  // for phone preview, mobile breakpoints actually fire — matching what
  // players on real devices will see.
  return <div ref={hostRef} style={{ width: "100%", height: "100%", containerType: "inline-size" }}>{children}</div>;
}

// ── Shadow DOM host — isolates user TSX styles from Studio chrome ────
//
// Without this, a `<style>` tag emitted by the user's component (the standard
// pattern for full-screen rootComponent cards) injects rules into the
// document scope. Selectors like `*`, `body`, or `:root` then cascade across
// the entire Studio UI — wiping margins on toolbars, retypesetting unrelated
// panels. Playtime renders the same TSX inside an iframe so styles are
// already contained there; this gives the Studio Canvas preview the same
// guarantee using a Shadow Root — no iframe overhead, no postMessage plumbing,
// just native style isolation.
//
// `mode: "open"` so devtools can inspect the shadow tree, and so the existing
// helpers (applyRuntimeStyleFixes, hardenImages, resolveStyleAssetRefs,
// rewriteMediaToContainerQueries) keep working — they walk a `ParentNode`
// and `ShadowRoot` is one.
//
// CSS custom properties (Tailwind theme tokens, --play-surface-max, etc.)
// inherit through the shadow boundary, so cards using `var(--foo)` defined on
// :root in the parent document still resolve them. `@container` queries
// match against the nearest containment ancestor regardless of shadow
// boundary, so the wrapper inside (containerType: inline-size) keeps device-
// frame previews responsive.
function ShadowHost({ children }: { children: React.ReactNode }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [shadow, setShadow] = useState<ShadowRoot | null>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // Guard against StrictMode double-invocation and re-runs: attachShadow
    // throws if called twice on the same element. Re-using the existing
    // shadow root keeps any in-flight portal children stable.
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    setShadow(root);
  }, []);

  return (
    <div ref={hostRef} style={{ width: "100%", height: "100%" }}>
      {shadow ? createPortal(children, shadow) : null}
    </div>
  );
}

// ── V2 Canvas — uses bundleAndCompile for rootComponent ──────────────

function RootComponentCanvas({ previewVars }: {
  previewVars: Record<string, number | string | boolean | Record<string, unknown> | unknown[]>;
}) {
  const rootComponent = useEditorStore(s => s.worldDraft.rootComponent);
  const worldName = useEditorStore(s => s.worldDraft.name);
  const entries = useEditorStore(s => s.worldDraft.entries);

  const bundleInput = useMemo<BundleInput | null>(() => {
    if (!rootComponent?.files || !rootComponent.entryFile) return null;
    return { files: rootComponent.files, entryFile: rootComponent.entryFile };
  }, [rootComponent?.files, rootComponent?.entryFile]);

  // Build mock messages from greeting entry — this is what the player sees on game start
  const mockMessages = useMemo<MockBubbleProps[]>(() => {
    const greeting = entries.find(e => e.role === "greeting" && e.enabled);
    if (!greeting?.content) return [];
    return [{
      contentHtml: renderMessage(greeting.content),
      rawContent: greeting.content,
      role: "assistant",
      messageIndex: 0,
      isStreaming: false,
      stateSnapshot: null,
      variables: previewVars,
      renderMarkdown: renderMessage,
    }];
  }, [entries, previewVars]);

  // Provide a stub useYumina hook with preview variables + mock session data
  const useYuminaStub = useMemo(() => {
    const stubApi: YuminaAPI = {
      sendMessage: () => {},
      setVariable: () => {},
      executeAction: () => {},
      navigateTo: () => {},
      variables: previewVars,
      globalVariables: previewVars,
      worldName,
      resolveAssetUrl: (ref: string) => {
        if (ref.startsWith("@asset:")) return getAssetCdnUrl(ref.slice(7));
        return ref;
      },
      // Session/streaming state for cards that read these
      messages: mockMessages.map((m, i) => ({
        id: `preview-${i}`,
        role: m.role,
        content: m.rawContent,
        status: "complete",
      })),
      isStreaming: false,
      streamingContent: "",
      currentUser: { id: "preview-user", name: "Player" },
      user: { name: "Player", avatar: null },
      // Real audio routing — canvas preview now plays sounds exactly like
      // production, so creators can hear what their components trigger instead
      // of testing audio only in the playtest panel. If they mute or pause via
      // the audio controls, those controls apply here too (same store).
      // Silent no-ops used to live here; they caused audio-triggering TSX
      // components to appear broken during editing.
      playAudio: (trackId, opts) => useAudioStore.getState().playTrack(trackId, opts),
      stopAudio: (trackId, fadeDuration) => {
        if (trackId) useAudioStore.getState().stopTrack(trackId, fadeDuration);
      },
      pauseAudio: (trackId) => useAudioStore.getState().pauseTrack(trackId),
      resumeAudio: (trackId) => useAudioStore.getState().resumeTrack(trackId),
      setAudioVolume: (type, vol) => {
        const s = useAudioStore.getState();
        if (type === "bgm") s.setBgmVolume(vol);
        else if (type === "sfx") s.setSfxVolume(vol);
      },
      getAudioVolume: (type) => {
        const s = useAudioStore.getState();
        return type === "bgm" ? s.bgmVolume : s.sfxVolume;
      },
      switchGreeting: () => {},
    };
    return () => stubApi;
  }, [previewVars, worldName, mockMessages]);

  // Provide mock platform components so cards using <Chat>, <MessageList>, etc. render properly
  const runtimeScope = useMemo<CompileRuntimeScope>(() => {
    // Stub Chat: renders messages via renderBubble + mock input placeholder
    const StubChat: React.FC<Record<string, unknown>> = (props) => {
      const renderBubble = props.renderBubble as ((p: MockBubbleProps) => React.ReactNode) | undefined;
      const className = props.className as string | undefined;
      const children = props.children as React.ReactNode;
      return (
        <div className={className} style={{ display: "flex", flexDirection: "column", height: "100%" }}>
          {children}
          <div style={{ flex: 1, overflowY: "auto" }}>
            {mockMessages.map((msg, i) => (
              <div key={i}>
                {renderBubble ? renderBubble(msg) : (
                  <div style={{ padding: "8px 16px" }} dangerouslySetInnerHTML={{ __html: msg.contentHtml }} />
                )}
              </div>
            ))}
          </div>
          <div style={{ padding: "10px 16px", borderTop: "1px solid rgba(255,255,255,0.08)" }}>
            <div style={{
              background: "rgba(255,255,255,0.06)",
              borderRadius: "10px",
              padding: "10px 14px",
              fontSize: "13px",
              color: "rgba(255,255,255,0.25)",
              cursor: "default",
            }}>
              Send a message...
            </div>
          </div>
        </div>
      );
    };

    // Stub MessageList: renders messages via rendererComponent
    const StubMessageList: React.FC<Record<string, unknown>> = (props) => {
      const Renderer = props.rendererComponent as React.ComponentType<MockBubbleProps> | undefined;
      return (
        <div style={{ flex: 1, overflowY: "auto" }}>
          {mockMessages.map((msg, i) =>
            Renderer ? <Renderer key={i} {...msg} /> : (
              <div key={i} style={{ padding: "8px 16px" }} dangerouslySetInnerHTML={{ __html: msg.contentHtml }} />
            ),
          )}
        </div>
      );
    };

    // Stub MessageInput: non-functional placeholder
    const StubMessageInput: React.FC<Record<string, unknown>> = () => (
      <div style={{ padding: "10px 16px", borderTop: "1px solid rgba(255,255,255,0.08)" }}>
        <div style={{
          background: "rgba(255,255,255,0.06)",
          borderRadius: "10px",
          padding: "10px 14px",
          fontSize: "13px",
          color: "rgba(255,255,255,0.25)",
          cursor: "default",
        }}>
          Send a message...
        </div>
      </div>
    );

    // Stub ModelPickerModal/ModelTrigger: studio preview doesn't run a real session,
    // so the picker has no real models to switch — render placeholders so cards
    // referencing these components don't crash, but clicking them is a no-op.
    const StubModelPickerModal: React.FC<Record<string, unknown>> = (props) => {
      if (!props.open) return null;
      return (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 9999, display: "flex",
            alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.6)",
          }}
          onClick={() => (props.onClose as undefined | (() => void))?.()}
        >
          <div
            style={{
              background: "#1a1b1e", color: "rgba(255,255,255,0.7)", padding: "20px 24px",
              borderRadius: "12px", fontSize: "13px", maxWidth: "320px", textAlign: "center",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            Model picker is disabled in studio preview — it works in the live game.
          </div>
        </div>
      );
    };
    const StubModelTrigger: React.FC<Record<string, unknown>> = () => (
      <div style={{
        background: "rgba(255,255,255,0.06)", borderRadius: "8px", padding: "4px 10px",
        fontSize: "12px", color: "rgba(255,255,255,0.4)", cursor: "default",
      }}>
        Model
      </div>
    );
    const StubSessionMemoryModal: React.FC<Record<string, unknown>> = (props) => {
      if (!props.open) return null;
      return (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 9999, display: "flex",
            alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.6)",
          }}
          onClick={() => (props.onClose as undefined | (() => void))?.()}
        >
          <div
            style={{
              background: "#1a1b1e", color: "rgba(255,255,255,0.7)", padding: "20px 24px",
              borderRadius: "12px", fontSize: "13px", maxWidth: "320px", textAlign: "center",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            Session memory is disabled in studio preview — it works in the live game.
          </div>
        </div>
      );
    };

    return {
      Chat: StubChat, MessageList: StubMessageList, MessageInput: StubMessageInput,
      ModelPickerModal: StubModelPickerModal, ModelTrigger: StubModelTrigger,
      SessionMemoryModal: StubSessionMemoryModal,
    };
  }, [mockMessages]);

  const bundleResult = useMemo(() => {
    if (!bundleInput) return null;
    return bundleAndCompile(bundleInput, useYuminaStub, runtimeScope);
  }, [bundleInput, useYuminaStub, runtimeScope]);

  if (!bundleInput) return null;

  if (bundleResult?.error) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
        <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
        <p className="text-xs text-destructive font-mono break-all">{bundleResult.error}</p>
      </div>
    );
  }

  if (!bundleResult?.Component) return null;

  const Comp = bundleResult.Component;

  // Containment wrapper: `transform` creates a new containing block so
  // `position: fixed` elements inside the card stay within this div
  // instead of escaping to the viewport and overlaying the Studio UI.
  // overflow: auto so tall cards scroll inside the device viewport
  // (mirrors how a real iframe handles overflow with sticky/fixed UI).
  //
  // ShadowHost lives outside the error boundary so the shadow root survives
  // recompiles — only the user component subtree remounts when the bundle
  // identity changes, avoiding shadow-root churn on every TSX edit. The
  // ErrorBoundary stays inside the shadow so caught errors render inside
  // the isolated tree (and the boundary's own classes / styles are the few
  // that intentionally cross into the shadow via the portal).
  return (
    <div style={{
      position: "relative",
      overflow: "auto",
      transform: "scale(1)",
      width: "100%",
      height: "100%",
    }}>
      <ShadowHost>
        {/* React key tied to Comp identity — each successful recompile produces
            a new function reference, so the boundary is replaced and any error
            state from the previous compile is cleared. */}
        <CanvasErrorBoundary key={getCompKey(Comp)}>
          <AssetProcessingWrapper>
            <Comp />
          </AssetProcessingWrapper>
        </CanvasErrorBoundary>
      </ShadowHost>
    </div>
  );
}

// Stable string ID per Comp function reference — recompiles yield a new
// reference, so the returned key changes, forcing React to remount the child.
const compIdMap = new WeakMap<object, string>();
let compIdCounter = 0;
function getCompKey(comp: unknown): string {
  if (typeof comp !== "function") return "none";
  let id = compIdMap.get(comp as object);
  if (!id) {
    id = `c${++compIdCounter}`;
    compIdMap.set(comp as object, id);
  }
  return id;
}

// ── Main panel ───────────────────────────────────────────────────────
// Every world has rootComponent after v19→v20 migration — the legacy
// customUI[] preview path was removed in phase 6.

export function CanvasPanel() {
  const worldDraft = useEditorStore(s => s.worldDraft);
  const worldKey = worldDraft.id || "new";
  const previewOverridesByWorld = useStudioSidebarStore(
    (state) => state.previewVariableOverridesByWorld
  );
  const previewOverrides = useMemo(
    () => previewOverridesByWorld[worldKey] ?? EMPTY_OVERRIDES,
    [previewOverridesByWorld, worldKey]
  );

  const previewVars = useMemo(
    () => {
      const base = Object.fromEntries(
        worldDraft.variables.map((v) => [v.id, v.defaultValue])
      ) as Record<string, number | string | boolean | Record<string, unknown> | unknown[]>;
      for (const variable of worldDraft.variables) {
        if (Object.prototype.hasOwnProperty.call(previewOverrides, variable.id)) {
          base[variable.id] = previewOverrides[variable.id]!;
        }
      }
      return base;
    },
    [worldDraft.variables, previewOverrides]
  );

  const hasFiles = !!worldDraft.rootComponent?.files && Object.keys(worldDraft.rootComponent.files).length > 0;
  return (
    <CanvasShell isEmpty={!hasFiles} fullBleed>
      <RootComponentCanvas previewVars={previewVars} />
    </CanvasShell>
  );
}

/** Phone device frame */
function DeviceFrame({ children, fullBleed }: { children: React.ReactNode; fullBleed?: boolean }) {
  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-2xl border-2 border-border bg-background shadow-2xl">
      {/* Status bar */}
      <div className="flex items-center justify-between px-4 py-1.5 text-[10px] text-muted-foreground/50">
        <span>9:41</span>
        <span>Yumina</span>
      </div>
      {/* Content — fullBleed removes padding for full-screen root component cards */}
      <div className={`flex-1 overflow-hidden ${fullBleed ? "" : "overflow-y-auto p-4"}`}>
        {children}
      </div>
      {/* Home indicator */}
      <div className="flex justify-center pb-2 pt-1">
        <div className="h-1 w-24 rounded-full bg-muted-foreground/30" />
      </div>
    </div>
  );
}

function EmptyState() {
  const { t } = useTranslation("editor");
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-muted-foreground/50">
      <Layers className="h-6 w-6" />
      <p className="text-xs">{t("studio.canvas.emptyState")}</p>
    </div>
  );
}
