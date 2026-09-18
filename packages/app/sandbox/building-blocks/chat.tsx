import React, { useMemo, useRef } from "react";
import { useYumina } from "../sandbox-context";
import { MessageList } from "../chat/message-list";
import { MessageInput } from "../chat/message-input";
import { renderMessage } from "../chat/markdown";

/**
 * Props for the creator's custom bubble renderer.
 * Passed to `renderBubble` for each message in the chat.
 */
export interface BubbleProps {
  /** Pre-rendered HTML (markdown → safe HTML). Use this when you want
   *  passthrough: `<div dangerouslySetInnerHTML={{ __html: contentHtml }} />`. */
  contentHtml: string;
  /** Directive-stripped markdown text — the message body with any `[var: op val]`
   *  directives removed. Stable across streaming. Use this to run your own
   *  regex matches (banners, markers) and to pass into `renderMarkdown` when
   *  you need to embed a processed slice as HTML. Matches the v1 `content`
   *  prop contract for message renderers migrated from v19→v20. */
  content: string;
  /** Raw markdown content (includes any directives). */
  rawContent: string;
  /** Message role */
  role: "user" | "assistant" | "system";
  /** Position in message list (0 = first message / greeting) */
  messageIndex: number;
  /** Whether this message is currently being streamed */
  isStreaming: boolean;
  /** Game state snapshot at the time this message was generated */
  stateSnapshot: Record<string, unknown> | null;
  /** Current game variables (latest state) */
  variables: Record<string, unknown>;
  /** Convert markdown text to safe HTML */
  renderMarkdown: (text: string) => string;
}

export interface ChatProps {
  /**
   * Custom renderer for each message bubble.
   * If not provided, uses default markdown rendering.
   */
  renderBubble?: (props: BubbleProps) => React.ReactNode;
  /** Additional CSS class for the chat container */
  className?: string;
  /** Content to render above the message list */
  children?: React.ReactNode;
}

/**
 * <Chat> — The platform's chat experience as an importable building block.
 *
 * Handles: scroll management, streaming cursor, swipe controls, message actions,
 * input box, choice buttons, model picker, read-only mode, greeting display.
 *
 * Creator customizes bubble appearance via `renderBubble`. Everything else is
 * managed by the platform. Platform improvements auto-propagate.
 *
 * @example
 * // Styled bubbles only
 * <Chat renderBubble={(msg) => <div className="parchment">{msg.contentHtml}</div>} />
 *
 * @example
 * // Default chat (no customization)
 * <Chat />
 *
 * @example
 * // Chat with header content
 * <Chat renderBubble={(msg) => <StyledBubble {...msg} />}>
 *   <div className="p-2 border-b">Custom header content</div>
 * </Chat>
 */
export function Chat({ renderBubble, className, children }: ChatProps) {
  const api = useYumina();

  // Bridge the creator's `renderBubble` into the component format MessageList
  // expects. CRITICAL: this bridge component must keep a STABLE identity across
  // renders. Creators write `renderBubble` as an inline closure (a new function
  // reference on every host-App render), so depending on its identity here used
  // to mint a brand-new component type every render. React unmounts/remounts the
  // subtree whenever the component *type* at a position changes — so during
  // streaming (the host App re-renders on every chunk) the entire MessageList
  // remounted on every streamed segment, flashing/reflowing the whole chat
  // ("整个前端跳一下"). We keep the latest closure + variables in refs and depend
  // only on renderBubble *presence*, so the bridge is created once and merely
  // re-invoked with fresh content on each chunk — no remount.
  const renderBubbleRef = useRef(renderBubble);
  renderBubbleRef.current = renderBubble;
  const apiVariablesRef = useRef(api.variables);
  apiVariablesRef.current = api.variables;

  const hasRenderBubble = !!renderBubble;
  const rendererComponent = useMemo(() => {
    if (!hasRenderBubble) return null;

    // MessageList passes `content` (already directive-stripped during streaming)
    // and `rawContent` (full unstripped text). We render markdown to HTML here
    // so creators can use `contentHtml` directly without calling renderMarkdown.
    const BubbleRenderer = (props: Record<string, unknown>) => {
      const fn = renderBubbleRef.current;
      if (!fn) return null;

      const content = (props.content as string) ?? "";
      const rawContent = (props.rawContent as string) ?? content;
      const role = (props.role as "user" | "assistant" | "system") ?? "assistant";
      const messageIndex = (props.messageIndex as number) ?? 0;
      const isStreaming = (props.isStreaming as boolean) ?? false;
      const variables = (props.variables as Record<string, unknown>) ?? (apiVariablesRef.current ?? {}) as Record<string, unknown>;
      const stateSnapshot = (props.stateSnapshot as Record<string, unknown> | null) ?? null;

      const rendered = renderMessage(content);
      const bubbleProps: BubbleProps = {
        contentHtml: rendered,
        // `content` is the directive-stripped markdown — not the rendered HTML.
        // This matches how v1 message renderers were written (they ran regex
        // matches on markdown and called renderMarkdown() themselves). Passing
        // HTML here would defeat both: regexes wouldn't match the markdown
        // markers, and renderMarkdown(HTML) would escape tags into visible text.
        content,
        rawContent,
        role,
        messageIndex,
        isStreaming,
        stateSnapshot,
        variables,
        renderMarkdown: renderMessage,
      };

      return <>{fn(bubbleProps)}</>;
    };

    BubbleRenderer.displayName = "CreatorBubbleRenderer";
    return BubbleRenderer;
    // Identity changes only when renderBubble is added/removed, never on each
    // inline-closure re-creation — so MessageList never remounts mid-stream.
  }, [hasRenderBubble]);

  return (
    <div
      className={`flex h-full w-full min-w-0 flex-1 flex-col overflow-hidden ${className ?? ""}`}
    >
      {/* Optional creator header content */}
      {children}

      {/* Message list with optional custom renderer */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <MessageList rendererComponent={rendererComponent} />
        {!api.readOnly && <MessageInput />}
        {api.readOnly &&
          (api.messages as unknown[])?.length > 0 && (
            <div className="shrink-0 border-t border-border px-4 py-3 text-center text-xs text-muted-foreground/60">
              Read-only session
            </div>
          )}
      </div>
    </div>
  );
}
