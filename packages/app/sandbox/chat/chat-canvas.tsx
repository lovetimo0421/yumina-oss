import React from "react";
import { useYumina } from "../sandbox-context";
import { MessageList } from "./message-list";
import { MessageInput } from "./message-input";

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

  return (
    <div className="flex h-full w-full min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <MessageList rendererComponent={messageRenderer} />
          {!api.readOnly && <MessageInput />}
          {api.readOnly && (api.messages as unknown[])?.length > 0 && (
            <div className="shrink-0 border-t border-border px-4 py-3 text-center text-xs text-muted-foreground/60">
              Read-only session
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
