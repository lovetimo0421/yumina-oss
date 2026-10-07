import React from "react";
import { useYumina } from "../sandbox-context";
import { MessageList } from "./message-list";
import { MessageInput } from "./message-input";
import { ChatBackground } from "./chat-background";
import { makeChatT } from "./i18n";

interface ChatCanvasProps {
  /** Compiled creator message renderer component, or null for default markdown */
  messageRenderer?: React.ComponentType<Record<string, unknown>> | null;
}

/**
 * The default chat UI template that runs inside the sandbox iframe.
 * This is the "universal canvas" — every world renders through this.
 *
 * Structure matches the parent chat-view.tsx normal chat path exactly.
 */
export function ChatCanvas({ messageRenderer = null }: ChatCanvasProps) {
  const api = useYumina();
  const t = makeChatT(api.language);

  return (
    <div className="relative flex h-full w-full min-w-0 flex-1 flex-col overflow-hidden">
      {/* A sibling of the transcript, never an ancestor — see ChatBackground. */}
      <ChatBackground background={api.background ?? null} />
      <div className="relative z-[1] flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <MessageList rendererComponent={messageRenderer} />
          {!api.readOnly && <MessageInput />}
          {api.readOnly && (api.messages as unknown[])?.length > 0 && (
            <div className="shrink-0 border-t border-border px-4 py-3 text-center text-xs text-muted-foreground/60">
              {t("readOnlySession")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
