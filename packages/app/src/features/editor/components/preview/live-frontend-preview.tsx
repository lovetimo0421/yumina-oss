import { previewMacroNames, resolveDisplayMacros } from "@/lib/resolve-display-macros";
import React, { Component, createContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useEditorStore } from "@/stores/editor";
import {
  type YuminaAPI,
  type PreviewEntry,
  type TrackedListener,
  applyRuntimeStyleFixes,
  hardenImages,
  resolveStyleAssetRefs,
  rewriteMediaToContainerQueries,
  rewriteShadowRootSelectors,
} from "@/features/studio/lib/custom-component-renderer";
import { bundleAndCompile, type BundleInput, type CompileRuntimeScope } from "@/lib/tsx/tsx-bundler";
import { viewportUnitsToContainerFiles } from "@/lib/tsx/viewport-units";
import { renderMessage } from "@/lib/markdown";
import { absoluteImageUrl, getAssetCdnUrl } from "@/lib/asset-url";
import { deepEqual, resolveBackground, sampleConversation, type ResolvedBackground } from "@yumina/engine";
import { ChatBackground } from "@/../sandbox/chat/chat-background";
import {
  DESIGNED_MESSAGE_CSS,
  DesignedMessage,
  type DesignedMessageHost,
  type MessageDesign,
} from "@/../sandbox/chat/designed-message";
import { useAudioStore } from "@/stores/audio";
import { Layers, AlertCircle } from "lucide-react";
import { CopyErrorButton } from "@/components/copy-error-button";
import { resolvePreviewOpening } from "./preview-opening";
import { resolvePreviewVariables } from "./preview-variables";

// ── Mock bubble props for canvas preview ────────────────────────────
interface MockBubbleProps {
  contentHtml: string;
  /** Directive-stripped markdown — part of the sandbox's BubbleProps contract
   *  (building-blocks/chat.tsx). Bubbles written against it run regexes on
   *  `content` directly, so a mock that omits it makes every such card throw
   *  "cannot read properties of undefined" IN THE STUDIO ONLY, while playing
   *  fine — the most misleading kind of broken. */
  content: string;
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

export function CanvasShell({ children, isEmpty, fullBleed }: { children: React.ReactNode; isEmpty: boolean; fullBleed?: boolean }) {
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

function AssetProcessingWrapper({ children, contain = "inline-size" }: {
  children: React.ReactNode;
  /** `size` when the card is drawn in a frame of its own and its viewport
   *  units have been re-aimed at that frame (see RootComponentCanvas's
   *  `fitToFrame`): `cqh` needs a height to measure against. */
  contain?: "inline-size" | "size";
}) {
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
  // `data-yc-frame` marks this as studio scaffolding rather than card markup —
  // the inspector's breadcrumb drops it so the chain starts at something the
  // creator actually wrote.
  return <div ref={hostRef} data-yc-frame="" style={{ width: "100%", height: "100%", containerType: contain }}>{children}</div>;
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

// ── Live preview data, outside the compile ──────────────────────────

type PreviewVars = Record<string, number | string | boolean | Record<string, unknown> | unknown[]>;

/** What a played preview does with the card's writes (see LiveFrontendPreview `play`). */
interface PreviewPlay {
  setVariable: (id: string, value: PreviewVars[string]) => void;
  switchGreeting: (index: number) => void;
}

interface PreviewRuntimeData {
  previewVars: PreviewVars;
  worldName: string;
  mockMessages: MockBubbleProps[];
  background: ResolvedBackground | null;
  play: PreviewPlay | null;
  /** The card's entries, so a part listing them shows what play will. */
  entries: PreviewEntry[];
}

const PreviewRuntimeContext = createContext<PreviewRuntimeData | null>(null);

/** The preview data for whoever is asking. Inside a render that is the
 *  context, so the reader re-renders when it changes. A card may also call
 *  useYumina() outside a render (an event handler, a module-level helper);
 *  there is no context to read then, and the latest values are the answer. */
function readPreviewRuntime(latest: React.RefObject<PreviewRuntimeData>): PreviewRuntimeData {
  try {
    // useContext claims no hook slot, so reading it in a try is order-safe.
    return React.useContext(PreviewRuntimeContext) ?? latest.current;
  } catch {
    return latest.current;
  }
}

function buildPreviewApi({ previewVars, worldName, mockMessages, play, entries }: PreviewRuntimeData): YuminaAPI {
  return {
    entries,
    sendMessage: () => {},
    setVariable: play ? (id, value) => play.setVariable(id, value as PreviewVars[string]) : () => {},
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
    switchGreeting: play ? (index: number) => play.switchGreeting(index) : () => {},
    // 现场 / story events: a preview makes no AI calls, so nothing to tell
    // and nothing to hear — but a card that calls them must still render.
    setScene: () => {},
    onStoryEvent: () => () => {},
  };
}

/** The same files object for as long as the file contents are the same. */
function useStableFiles(files: Record<string, string> | undefined): Record<string, string> | undefined {
  const ref = useRef(files);
  if (files !== ref.current) {
    const prev = ref.current;
    const same = !!prev && !!files && Object.keys(prev).length === Object.keys(files).length
      && Object.keys(files).every((name) => prev[name] === files[name]);
    if (!same) ref.current = files;
  }
  return ref.current;
}

// ── V2 Canvas — uses bundleAndCompile for rootComponent ──────────────

/** The board, player interface and preserved-base preview share one choice.
 * An explicit scene selection takes precedence over the current card's choice. */
/** Which opening the preview plays. Passed in — the Studio remembers a choice
 *  per world and hands it down; the normal editor has no such memory and lets
 *  the resolver pick the first enabled opening. Reading the Studio's store from
 *  in here is what used to make this renderer Studio-only. */

/** Marks the opening's bubble in the preview, so an editor drawn over it can
 *  tell a click on the opening from a click on the rest of the card. */
export const PREVIEW_GREETING_ATTR = "data-preview-greeting";

function RootComponentCanvas({ previewVars, entryFileOverride, inspect, greetingId, fitToFrame, play = null }: {
  previewVars: Record<string, number | string | boolean | Record<string, unknown> | unknown[]>;
  play?: PreviewPlay | null;
  /** The card is drawn in a box that is not the window — the board's
   *  interface block — so its viewport units are rewritten to measure that
   *  box instead (see viewport-units.ts). The player interface page and the
   *  playtest leave this off: there the card has the whole surface. */
  fitToFrame?: boolean;
  /** Compile from a different entry in the same files — how the interface
   *  builder renders a wrapped card's BASE layer without its own overlay. */
  entryFileOverride?: string;
  /** Stamp each rendered node with the source line that produced it, so the
   *  frontend inspector can answer "where is this in the code?". Studio-only —
   *  see BundleInput.inspect. */
  inspect?: boolean;
  greetingId?: string;
}) {
  const { t, i18n } = useTranslation("editor");
  const sampleLang = i18n.language;
  // The composer stub wears the player's own placeholder: this preview is sold
  // as "what the player sees", and an English prompt under a Chinese card is
  // the preview telling a small lie about the surface it is previewing.
  const { t: tChat } = useTranslation("chat");
  const firstCompKey = useRef<string | null>(null);
  const rootComponent = useEditorStore(s => s.worldDraft.rootComponent);
  const worldName = useEditorStore(s => s.worldDraft.name);
  const entries = useEditorStore(s => s.worldDraft.entries);
  // The entries as play hands them to a card (see world-renderer's
  // slimEntries); the portrait stays a ref for resolveAssetUrl.
  const previewEntries = useMemo<PreviewEntry[]>(() => (entries ?? [])
    .filter((e) => e.enabled !== false)
    .slice()
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((e) => ({ id: e.id, name: e.name, content: e.content, role: e.role ?? "lore", folderId: e.folderId, audience: e.audience, portrait: e.portrait ?? null })), [entries]);
  const backgrounds = useEditorStore(s => s.worldDraft.backgrounds);
  const cover = useEditorStore(s => s.worldDraft.avatar);
  const previewGreetingId = greetingId;
  // The picture behind the chat, the way play resolves it — by the opening
  // being previewed and the preview's variables — then made fetchable. The
  // preview never drew one before, so an author who uploaded a background
  // saw the block beside it change and the interface stay bare, and had to
  // start a playtest to find out whether it took.
  const background = useMemo<ResolvedBackground | null>(() => {
    const resolved = resolveBackground({ backgrounds }, { variables: previewVars }, { activeGreetingId: previewGreetingId ?? null, coverUrl: absoluteImageUrl(cover) });
    if (!resolved) return null;
    const url = resolved.url.startsWith("@asset:") ? getAssetCdnUrl(resolved.url.slice(7)) : absoluteImageUrl(resolved.url);
    return url ? { ...resolved, url } : null;
  }, [backgrounds, previewVars, previewGreetingId, cover]);

  // The compile depends on the files and nothing else. A draft rebuilt with
  // equal files (a merge, a refresh) keeps the old object so it does not
  // recompile either.
  const sourceFiles = useStableFiles(rootComponent?.files);
  const bundleInput = useMemo<BundleInput | null>(() => {
    if (!sourceFiles || !rootComponent?.entryFile) return null;
    const files = fitToFrame ? viewportUnitsToContainerFiles(sourceFiles) : sourceFiles;
    return { files, entryFile: entryFileOverride ?? rootComponent.entryFile, inspect };
  }, [sourceFiles, rootComponent?.entryFile, entryFileOverride, inspect, fitToFrame]);

  // Build mock messages from greeting entry — this is what the player sees on game start
  const mockMessages = useMemo<MockBubbleProps[]>(() => {
    const greeting = resolvePreviewOpening(entries, previewGreetingId);
    if (!greeting?.content) return [];
    const reply = t("studio.theme.sampleYou");
    // {{user}} / {{char}} read as names here, as they will when played.
    const names = previewMacroNames(entries, t("studio.preview.you"));
    const text = resolveDisplayMacros(greeting.content, names.user, names.char);
    return [{
      contentHtml: renderMessage(text),
      // A greeting has no [var: op value] directives to strip, so the
      // stripped text IS the text — but the field must exist.
      content: text,
      rawContent: greeting.content,
      role: "assistant",
      messageIndex: 0,
      isStreaming: false,
      stateSnapshot: null,
      variables: previewVars,
      renderMarkdown: renderMessage,
    }, {
      // One line back from the player. A card styles both sides of a
      // conversation — the user's bubble, its colour, its corner — and a
      // preview holding only the greeting cannot show any of it.
      contentHtml: renderMessage(reply),
      content: reply,
      rawContent: reply,
      role: "user",
      messageIndex: 1,
      isStreaming: false,
      stateSnapshot: null,
      variables: previewVars,
      renderMarkdown: renderMessage,
    }];
  }, [entries, previewVars, previewGreetingId, t]);

  // Everything the running card reads that changes while the creator edits —
  // variables, the opening, the background. None of it is part of the
  // compile: it reaches the card through context, so an edit re-renders the
  // card in place. It used to be baked into the compiled bundle, and every
  // draft edit recompiled and REMOUNTED the card, restarting its BGM, timers
  // and entrance on each keystroke.
  const runtimeData = useMemo<PreviewRuntimeData>(
    () => ({ previewVars, worldName, mockMessages, background, play, entries: previewEntries }),
    [previewVars, worldName, mockMessages, background, play, previewEntries],
  );
  const latestRuntime = useRef(runtimeData);
  latestRuntime.current = runtimeData;

  // A stub useYumina hook with preview variables + mock session data. Stable
  // for the life of this canvas: the values come from context at call time.
  const useYuminaStub = useMemo(() => {
    const apis = new WeakMap<PreviewRuntimeData, YuminaAPI>();
    return function useYumina(): YuminaAPI {
      const data = readPreviewRuntime(latestRuntime);
      let api = apis.get(data);
      if (!api) { api = buildPreviewApi(data); apis.set(data, api); }
      return api;
    };
  }, []);

  // Provide mock platform components so cards using <Chat>, <MessageList>, etc. render properly
  const runtimeScope = useMemo<CompileRuntimeScope>(() => {
    // The stubs wear the sandbox's own `play-*` hooks.
    //
    // They are what the Studio shows a creator who is choosing how their card
    // LOOKS, and a theme reaches the platform's chat exclusively through those
    // class names (TOKEN_RULES in ui-doc/compile.ts). A stub without them shows
    // the theme's background and none of its type, bubbles or composer — so the
    // Studio would promise one card and the player would get another, which is
    // the one thing a preview must never do. Their structure mirrors
    // sandbox/chat/message-bubble.tsx and message-input.tsx; the hooks are a
    // published contract, so keeping them in step is not optional.
    const MockBubble: React.FC<{ msg: MockBubbleProps }> = ({ msg }) => {
      const isUser = msg.role === "user";
      return (
        <div className={`play-message-block${isUser ? " play-message-block--user" : ""}`} style={{ padding: "6px 16px" }} {...(!isUser && msg.messageIndex === 0 ? { [PREVIEW_GREETING_ATTR]: "" } : {})}>
          <div className={isUser ? "play-user-message-shell" : undefined} style={{ display: "flex", flexDirection: "column", alignItems: isUser ? "flex-end" : "flex-start" }}>
            <div
              className={`play-message-content${isUser ? " play-user-message-content" : ""}`}
              style={{
                maxWidth: "100%",
                fontFamily: "var(--yc-font, inherit)",
                fontSize: "var(--yc-text-size, 14px)",
                lineHeight: "var(--yc-line-height, 1.625)",
                color: isUser ? "var(--yc-user-text, rgba(255,255,255,0.92))" : "var(--yc-text, rgba(255,255,255,0.92))",
                background: isUser ? "var(--yc-user-bubble-bg, transparent)" : "var(--yc-bubble-bg, transparent)",
                borderRadius: "var(--yc-bubble-radius, 0px)",
                padding: "var(--yc-bubble-padding, 0px)",
              }}
              dangerouslySetInnerHTML={{ __html: msg.contentHtml }}
            />
          </div>
        </div>
      );
    };

    const MockComposer: React.FC = () => (
      <div className="play-composer-shell" style={{ padding: "10px 16px" }}>
        <div
          className="play-composer-card"
          style={{
            display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
            // The fallbacks are what the platform's own composer looks like
            // (globals: a light gradient over the surface, a 12% edge). 6%
            // white with no border — the old numbers — vanished into the
            // stage whenever no theme was on, and creators read "no input box".
            background: "var(--yc-input-bg, linear-gradient(180deg, rgba(255,255,255,0.09), rgba(255,255,255,0.05)))",
            border: "var(--yc-input-border, 1px solid rgba(255,255,255,0.14))",
            borderRadius: "var(--yc-input-radius, 16px)",
          }}
        >
          <div
            className="play-composer-textarea"
            style={{
              flex: 1, minWidth: 0, cursor: "default",
              fontFamily: "var(--yc-font, inherit)", fontSize: 13,
              color: "var(--yc-input-fg, rgba(255,255,255,0.25))", opacity: 0.55,
            }}
          >
            {/* `chat` loads lazily; the fallback is what this line said before. */}
            {tChat("input.placeholder", { defaultValue: "Send a message..." })}
          </div>
          <div
            className="play-composer-send"
            style={{
              width: 28, height: 28, flex: "0 0 auto",
              background: "var(--yc-send-bg, rgba(255,255,255,0.14))",
              borderRadius: "var(--yc-send-radius, 999px)",
            }}
          />
        </div>
      </div>
    );

    // ── The message layer ──
    //
    // A transcript with a design (message style, 特殊写法 rules) is drawn by
    // the sandbox's own renderer — imported, not re-implemented — on the card's
    // opening, a line back, and then a sample reply that puts every rule to
    // work. A rule you cannot see working is a rule you cannot tell is right,
    // and a card still being written has nothing of its own to show them on.
    const previewHost: DesignedMessageHost = {
      sendMessage: () => {},
      resolveAssetUrl: (ref) => (ref.startsWith("@asset:") ? getAssetCdnUrl(ref.slice(7)) : ref),
      storage: null,
      canSend: () => true,
    };
    const DesignedList: React.FC<{ design: MessageDesign; fontMap?: Record<string, string> }> = ({ design, fontMap }) => {
      const { mockMessages } = readPreviewRuntime(latestRuntime);
      const own = mockMessages.map((m) => ({ role: m.role, content: m.rawContent }));
      const rules = Array.isArray(design.rules) ? design.rules : [];
      const sample = rules.length ? sampleConversation(rules, sampleLang) : [];
      const list = own.length ? [...own, ...sample.slice(1)] : sample;
      const hasGreeting = own.length > 0 && own[0]!.role === "assistant";
      return (
        <>
          <style>{DESIGNED_MESSAGE_CSS}</style>
          {list.map((m, i) => {
            const isUser = m.role === "user";
            // A player's line without a bubble is prose in the column, the
            // way the played card lays it out (messageDesignCss in compile.ts).
            const userProse = isUser && !!design.style?.user && !design.style.user.bubble;
            return (
              <div key={i} className={`play-message-block${isUser ? " play-message-block--user" : ""}`} style={{ padding: "6px 16px" }} {...(!isUser && hasGreeting && i === 0 ? { [PREVIEW_GREETING_ATTR]: "" } : {})}>
                <div className={isUser ? "play-user-message-shell" : undefined} style={{ display: "flex", flexDirection: "column", alignItems: isUser && !userProse ? "flex-end" : isUser ? "stretch" : "flex-start" }}>
                  <div
                    className={`play-message-content${isUser ? " play-user-message-content" : ""}`}
                    style={{
                      width: isUser && !userProse ? undefined : "100%",
                      marginLeft: userProse ? 0 : undefined,
                      textAlign: userProse ? design.style?.user?.text?.align ?? "left" : undefined,
                      maxWidth: "100%",
                      fontFamily: "var(--yc-font, inherit)",
                      fontSize: "var(--yc-text-size, 14px)",
                      lineHeight: "var(--yc-line-height, 1.625)",
                      color: isUser ? "var(--yc-user-text, rgba(255,255,255,0.92))" : "var(--yc-text, rgba(255,255,255,0.92))",
                    }}
                  >
                    <DesignedMessage
                      design={design}
                      fontMap={fontMap}
                      host={previewHost}
                      content={m.content}
                      role={m.role}
                      messageId={`__preview-${i}`}
                      isLastMessage={i === list.length - 1}
                      isGreeting={hasGreeting && i === 0}
                      renderMarkdown={renderMessage}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </>
      );
    };

    // Stub Chat: renders messages via renderBubble + mock input placeholder
    const StubChat: React.FC<Record<string, unknown>> = (props) => {
      const { mockMessages, background } = readPreviewRuntime(latestRuntime);
      const renderBubble = props.renderBubble as ((p: MockBubbleProps) => React.ReactNode) | undefined;
      const className = props.className as string | undefined;
      const children = props.children as React.ReactNode;
      const design = !renderBubble && props.design && typeof props.design === "object" ? props.design as MessageDesign : null;
      // Same shape as the sandbox's Chat: the background is a sibling under
      // the transcript, never an ancestor of it (see chat-background.tsx).
      return (
        <div className={className} style={{ position: "relative", display: "flex", flexDirection: "column", height: "100%" }}>
          <ChatBackground background={background} />
          <div style={{ position: "relative", zIndex: 1, display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
            {children}
            <div style={{ flex: 1, overflowY: "auto" }}>
              {design ? (
                <div className="play-message-stack">
                  <DesignedList design={design} fontMap={props.fontMap as Record<string, string> | undefined} />
                </div>
              ) : mockMessages.map((msg, i) => (
                <div key={i}>
                  {renderBubble ? renderBubble(msg) : <MockBubble msg={msg} />}
                </div>
              ))}
            </div>
            <MockComposer />
          </div>
        </div>
      );
    };

    // Stub MessageList: renders messages via rendererComponent
    const StubMessageList: React.FC<Record<string, unknown>> = (props) => {
      const { mockMessages } = readPreviewRuntime(latestRuntime);
      const Renderer = props.rendererComponent as React.ComponentType<MockBubbleProps> | undefined;
      const design = !Renderer && props.design && typeof props.design === "object" ? props.design as MessageDesign : null;
      if (design) {
        return (
          <div style={{ flex: 1, overflowY: "auto" }}>
            <div className="play-message-stack">
              <DesignedList design={design} fontMap={props.fontMap as Record<string, string> | undefined} />
            </div>
          </div>
        );
      }
      return (
        <div style={{ flex: 1, overflowY: "auto" }}>
          {mockMessages.map((msg, i) =>
            Renderer ? <Renderer key={i} {...msg} /> : <MockBubble key={i} msg={msg} />,
          )}
        </div>
      );
    };

    // Stub MessageInput: non-functional placeholder
    const StubMessageInput: React.FC<Record<string, unknown>> = () => <MockComposer />;

    // Stub ModelPickerModal/ModelTrigger: studio preview doesn't run a real session,
    // so the picker has no real models to switch — render placeholders so cards
    // referencing these components don't crash, but clicking them is a no-op.
    const StubModelPickerModal: React.FC<Record<string, unknown>> = (props) => {
      if (!props.open) return null;
      return (
        <div
          className="modal-backdrop"
          style={{
            position: "fixed", inset: 0, zIndex: 9999, display: "flex",
            alignItems: "center", justifyContent: "center",
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
          className="modal-backdrop"
          style={{
            position: "fixed", inset: 0, zIndex: 9999, display: "flex",
            alignItems: "center", justifyContent: "center",
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

    // ── The lore-binding family ──
    //
    // These reach into the live session (they persist their on/off in
    // `__lore_<slot>` game variables), so the preview cannot run the real
    // ones. It must still DRAW them: a card whose interface is a wall of
    // lore chips previewed as a blank panel, and the creator had no way to
    // tell "my layout is wrong" from "this control does not exist here".
    const chip = (on = false): React.CSSProperties => ({
      display: "inline-flex", alignItems: "center", gap: "6px",
      border: `1px solid ${on ? "rgba(217,161,63,0.5)" : "rgba(255,255,255,0.12)"}`,
      background: on ? "rgba(217,161,63,0.12)" : "rgba(255,255,255,0.04)",
      borderRadius: "999px", padding: "5px 11px", fontSize: "12px",
      color: on ? "rgba(240,205,140,0.95)" : "rgba(255,255,255,0.55)",
      cursor: "default", margin: "3px 4px 3px 0",
    });
    const StubLoreButton: React.FC<Record<string, unknown>> = (props) => (
      <span style={chip()}>
        {props.icon ? <span>{String(props.icon)}</span> : null}
        <span>{String(props.label ?? "lore")}</span>
      </span>
    );
    const StubLoreSwitch: React.FC<Record<string, unknown>> = (props) => (
      <span style={chip()}>
        <span style={{
          width: "22px", height: "13px", borderRadius: "999px",
          background: "rgba(255,255,255,0.14)", display: "inline-block",
        }} />
        <span>{String(props.label ?? "lore")}</span>
      </span>
    );
    const StubLoreGroup: React.FC<Record<string, unknown>> = (props) => {
      const slots = Array.isArray(props.slots) ? (props.slots as Array<Record<string, unknown>>) : [];
      return (
        <span>
          {slots.map((s, i) => (
            <span key={i} style={chip(i === 0)}>
              {s.icon ? <span>{String(s.icon)}</span> : null}
              <span>{String(s.label ?? s.id ?? "lore")}</span>
            </span>
          ))}
        </span>
      );
    };
    const StubLorePanel: React.FC<Record<string, unknown>> = (props) => (
      <div style={{
        border: "1px solid rgba(255,255,255,0.1)", borderRadius: "12px",
        padding: "10px 12px", margin: "6px 0",
      }}>
        <div style={{
          fontSize: "12px", fontWeight: 600, color: "rgba(255,255,255,0.6)", marginBottom: "6px",
        }}>
          {String(props.title ?? "")}
        </div>
        {props.children as React.ReactNode}
      </div>
    );

    return {
      Chat: StubChat, MessageList: StubMessageList, MessageInput: StubMessageInput,
      ModelPickerModal: StubModelPickerModal, ModelTrigger: StubModelTrigger,
      SessionMemoryModal: StubSessionMemoryModal,
      LoreButton: StubLoreButton, LorePanel: StubLorePanel,
      LoreGroup: StubLoreGroup, LoreSwitch: StubLoreSwitch,
    };
  }, [tChat, sampleLang]);

  // Recompiles only when the source changes (useYuminaStub is stable, and
  // runtimeScope only follows the chat namespace's language).
  const bundleResult = useMemo(() => {
    if (!bundleInput) return null;
    return bundleAndCompile(bundleInput, useYuminaStub, runtimeScope);
  }, [bundleInput, useYuminaStub, runtimeScope]);

  if (!bundleInput) return null;

  if (bundleResult?.error) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
        <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-destructive font-mono break-all">{bundleResult.error}</p>
          {Object.entries(bundleResult.fileErrors ?? {}).map(([file, msg]) => (
            <p key={file} className="mt-1 text-[10px] text-destructive/70 font-mono break-all">
              {file}: {msg}
            </p>
          ))}
        </div>
      </div>
    );
  }

  // A bundle that "succeeded" but produced no component was, until now, an
  // unmarked black rectangle — the board's interface block would just sit
  // there dark, and the creator had no way to know whether the card was
  // empty, broken, or still loading. Nothing rendering IS a diagnosis; say it.
  if (!bundleResult?.Component) {
    const fileErrors = Object.entries(bundleResult?.fileErrors ?? {});
    return (
      <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-3 m-3">
        <AlertCircle className="h-4 w-4 shrink-0 text-amber-400 mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-amber-200/90">{t("studio.canvas.noComponent")}</p>
          <p className="mt-1 text-[11px] leading-relaxed text-amber-200/60">
            {fileErrors.length > 0
              ? t("studio.canvas.noComponentFiles")
              : t("studio.canvas.noComponentHint")}
          </p>
          {fileErrors.map(([file, msg]) => (
            <p key={file} className="mt-1 text-[10px] text-amber-200/70 font-mono break-all">
              {file}: {msg}
            </p>
          ))}
        </div>
      </div>
    );
  }

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
  // First compile of this mount gets the entrance; every later one is an edit.
  const compKey = getCompKey(Comp);
  if (firstCompKey.current === null) firstCompKey.current = compKey;
  const replayingEntrance = firstCompKey.current !== compKey;

  return (
    <PreviewRuntimeContext.Provider value={runtimeData}>
    <div style={{
      position: "relative",
      overflow: "auto",
      transform: "scale(1)",
      width: "100%",
      height: "100%",
    }}>
      <ShadowHost>
        {/* Every recompile is a remount: the compiled card is a NEW function,
            and React replaces an element whose type changed no matter what key
            it carries. That is correct — it is also why editing a colour used
            to replay the card's entrance, fading the portrait back in and
            sliding the name down again on every keystroke.

            So the entrance plays once, on the first compile. After that the
            stylesheet below rides into the shadow root with the card and
            neutralises it. The animation is still in the document, still runs
            for the player, and still plays here if the page is reloaded. */}
        {replayingEntrance && (
          <style>{"[data-ui-stage] *,[data-ui-stage] *::before,[data-ui-stage] *::after{animation:none!important}"}</style>
        )}
        {/* React key tied to Comp identity — each successful recompile produces
            a new function reference, so the boundary is replaced and any error
            state from the previous compile is cleared. */}
        <CanvasErrorBoundary key={getCompKey(Comp)}>
          <AssetProcessingWrapper contain={fitToFrame ? "size" : "inline-size"}>
            <Comp />
          </AssetProcessingWrapper>
        </CanvasErrorBoundary>
      </ShadowHost>
    </div>
    </PreviewRuntimeContext.Provider>
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


/** Shared with the board's interface block: the same preview variables the
 *  dock builds, so the block and the dock can never disagree about what the
 *  card is showing. */
export function usePreviewVars(
  greetingId?: string,
  overrides?: Record<string, number | string | boolean | Record<string, unknown> | unknown[]>,
) {
  const worldDraft = useEditorStore((s) => s.worldDraft);
  const resolved = useMemo(
    () => resolvePreviewVariables(worldDraft, greetingId, overrides ?? EMPTY_OVERRIDES),
    [worldDraft, greetingId, overrides],
  );
  // Most draft edits (an entry's text, a file) leave the variables as they
  // were; keep the same object then, so nothing downstream re-renders.
  const stable = useRef(resolved);
  if (stable.current !== resolved && !deepEqual(stable.current, resolved)) stable.current = resolved;
  return stable.current;
}

/**
 * The card's frontend rendered live with no device chrome — the board's
 * interface block IS the frame.
 *
 * Compiling the card's TSX twice at once would give the card two shadow roots
 * and fire its side effects (audio unlock, timers) twice, so only one of these
 * is ever mounted: the board pauses its block while the full preview dock or a
 * playtest owns the screen.
 */
export function LiveFrontendPreview({
  inspect,
  overrides,
  greetingId,
  fitToFrame,
  play = false,
}: {
  /** The card is being played, not edited: what it writes (a name typed in,
   *  a choice, a button's 改变量, an opening picked) is kept in a scratch copy
   *  so the next page reads it, as in a playtest but with no AI and nothing
   *  saved. Turning it off throws the copy away. Before this the preview
   *  dropped every write — a name page's 进入故事 never lit up. */
  play?: boolean;
  inspect?: boolean;
  /** Drawn in the board's interface block rather than on a full surface:
   *  the card's viewport units measure the block. */
  fitToFrame?: boolean;
  /** The opening the author is editing; does not change its saved order. */
  greetingId?: string;
  /** Variables forced on top of the preview's: a module's scene block shows
   *  the interface in the state that opens that module. Pass a stable
   *  object — a fresh one every render re-sends the variables. */
  overrides?: Record<string, number | string | boolean | Record<string, unknown> | unknown[]>;
} = {}) {
  const [played, setPlayed] = useState<{ greetingId?: string; vars: PreviewVars }>(EMPTY_PLAYED);
  useEffect(() => { if (!play) setPlayed(EMPTY_PLAYED); }, [play]);
  const shownGreeting = (play && played.greetingId) || greetingId;
  const base = usePreviewVars(shownGreeting, overrides);
  const previewVars = useMemo(
    () => (Object.keys(played.vars).length ? { ...base, ...played.vars } : base),
    [base, played.vars],
  );
  const playApi = useMemo<PreviewPlay | null>(() => (play ? {
    setVariable: (id, value) => setPlayed((p) => ({ ...p, vars: { ...p.vars, [id]: value } })),
    // The openings in switchGreeting's count (world-preview collectGreetings).
    // Switching starts that opening's variables over, keeping what the player
    // set up before the story — as play does (preserveSetupScopedVariables).
    switchGreeting: (index) => {
      const draft = useEditorStore.getState().worldDraft;
      const opening = (draft.entries ?? [])
        .filter((e) => e.role === "greeting" && e.enabled !== false && (e.content ?? "").trim())
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[index];
      if (!opening) return;
      const setup = new Set(draft.variables.filter((v) => v.scope === "setup").map((v) => v.id));
      setPlayed((p) => ({
        greetingId: opening.id,
        vars: Object.fromEntries(Object.entries(p.vars).filter(([id]) => setup.has(id))),
      }));
    },
  } : null), [play]);
  return <RootComponentCanvas previewVars={previewVars} inspect={inspect} greetingId={shownGreeting} fitToFrame={fitToFrame} play={playApi} />;
}
const EMPTY_PLAYED: { greetingId?: string; vars: PreviewVars } = { vars: {} };

/**
 * A wrapped card's preserved frontend, alone — the interface builder draws
 * this UNDER its editable elements, so the canvas shows the card the player
 * actually has rather than a placeholder where the card should be. Compiling
 * from the base entry (not the generated one) is what keeps the builder's own
 * overlay from rendering twice.
 */
export function BaseFrontendPreview({ entryFile }: { entryFile: string }) {
  const previewVars = usePreviewVars();
  return <RootComponentCanvas previewVars={previewVars} entryFileOverride={entryFile} />;
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
