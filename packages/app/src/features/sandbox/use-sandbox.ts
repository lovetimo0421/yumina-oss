import { useCallback, useEffect, useRef, useState } from "react";
import { SandboxBridge, type ApiHandler, type StreamHandler } from "./bridge-parent";
import type { ChannelDataMap, SandboxMode } from "../../../sandbox/protocol";
import type { StateChannel } from "@yumina/engine";
import { SANDBOX_DOC_URL } from "@/lib/sandbox-doc-url";

const SANDBOX_URL = SANDBOX_DOC_URL;

/** Pin our origin into the iframe URL so the sandbox can validate inbound
 *  parent messages and post replies to an exact origin instead of "*". */
function withParentOrigin(url: string): string {
  try {
    return `${url}${url.includes("?") ? "&" : "?"}parentOrigin=${encodeURIComponent(window.location.origin)}`;
  } catch {
    return url;
  }
}

/**
 * Hook to manage a single sandbox iframe per session.
 * Creates the iframe, establishes the bridge, and provides methods
 * to install the root component and push state channel updates.
 */
export function useSandbox(opts: {
  onApiCall: ApiHandler;
  onStreamCall?: StreamHandler;
  onError?: (message: string) => void;
  onResize?: (height: number) => void;
  /** Sandbox self-diagnostics (e.g. scroll-clamp corrections) for analytics. */
  onDiag?: (event: string, data: Record<string, string | number | boolean>) => void;
  /** The composer's unsent text, mirrored out of the iframe (user content). */
  onComposerDraft?: (text: string) => void;
  onPlayInteraction?: () => void;
  /** Override sandbox URL */
  sandboxUrlOverride?: string;
}) {
  const [ready, setReady] = useState(false);
  // True once the world's root component has actually painted (not just booted).
  const [rendered, setRendered] = useState(false);
  const bridgeRef = useRef<SandboxBridge | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const onApiCallRef = useRef(opts.onApiCall);
  const onStreamCallRef = useRef(opts.onStreamCall);
  const onErrorRef = useRef(opts.onError);
  const onResizeRef = useRef(opts.onResize);
  const onDiagRef = useRef(opts.onDiag);
  const onComposerDraftRef = useRef(opts.onComposerDraft);
  const onPlayInteractionRef = useRef(opts.onPlayInteraction);
  onApiCallRef.current = opts.onApiCall;
  onStreamCallRef.current = opts.onStreamCall;
  onErrorRef.current = opts.onError;
  onResizeRef.current = opts.onResize;
  onDiagRef.current = opts.onDiag;
  onComposerDraftRef.current = opts.onComposerDraft;
  onPlayInteractionRef.current = opts.onPlayInteraction;

  useEffect(() => {
    const bridge = new SandboxBridge({
      onApiCall: (method, args) => onApiCallRef.current(method, args),
      onStreamCall: (method, args, cbs) => onStreamCallRef.current?.(method, args, cbs),
      onError: (message) => onErrorRef.current?.(message),
      onResize: (height) => onResizeRef.current?.(height),
      onDiag: (event, data) => onDiagRef.current?.(event, data),
      onComposerDraft: (text) => onComposerDraftRef.current?.(text),
      onPlayInteraction: () => onPlayInteractionRef.current?.(),
      onRendered: () => setRendered(true),
    });
    bridgeRef.current = bridge;

    if (iframeRef.current) {
      bridge.attach(iframeRef.current);
    }

    bridge.waitReady().then(() => setReady(true));

    return () => {
      bridge.destroy();
      bridgeRef.current = null;
      setReady(false);
      setRendered(false);
    };
  }, []);

  const iframeRefCallback = useCallback(
    (el: HTMLIFrameElement | null) => {
      iframeRef.current = el;
      if (el && bridgeRef.current) {
        bridgeRef.current.attach(el);
      }
    },
    []
  );

  const pushTheme = useCallback((cssVars: Record<string, string>) => {
    bridgeRef.current?.pushTheme(cssVars);
  }, []);

  const installRoot = useCallback(
    (
      entryFile: string,
      files: Record<string, string>,
      compiledCode?: string,
      compileError?: string,
      mode?: SandboxMode,
    ) => {
      bridgeRef.current?.installRoot(entryFile, files, compiledCode, compileError, mode);
    },
    [],
  );

  const pushChannel = useCallback(
    <C extends StateChannel>(channel: C, data: ChannelDataMap[C], version: number) => {
      bridgeRef.current?.pushChannel(channel, data, version);
    },
    [],
  );

  const setMediaSuspended = useCallback((suspended: boolean) => {
    bridgeRef.current?.setMediaSuspended(suspended);
  }, []);

  const sendAudioEnded = useCallback((trackId: string) => {
    bridgeRef.current?.sendAudioEnded(trackId);
  }, []);

  const restoreComposerDraft = useCallback((text: string) => {
    bridgeRef.current?.restoreComposerDraft(text);
  }, []);

  const restoreTranscriptPosition = useCallback((accountId: string, sessionId: string) => {
    bridgeRef.current?.restoreTranscriptPosition(accountId, sessionId);
  }, []);

  const sendRoomFrame = useCallback((frame: Record<string, unknown>) => {
    bridgeRef.current?.sendRoomFrame(frame);
  }, []);

  const openMemoryPanel = useCallback(() => {
    bridgeRef.current?.openMemoryPanel();
  }, []);

  return {
    ready,
    rendered,
    iframeRefCallback,
    sandboxUrl: withParentOrigin(opts.sandboxUrlOverride ?? SANDBOX_URL),
    pushTheme,
    installRoot,
    pushChannel,
    setMediaSuspended,
    sendAudioEnded,
    restoreComposerDraft,
    restoreTranscriptPosition,
    sendRoomFrame,
    openMemoryPanel,
  };
}
