import { useEffect, useRef, useState } from "react";
import { FriendPicker } from "@/edition/slots";
import { useFeature } from "@/edition/edition";

/**
 * The iframe a game-path world plays in, plus the social bridge it is allowed:
 * a game may PROMPT for the platform's friend-invite picker and report its room
 * closing — nothing else. The picker renders here, over the frame, from
 * platform code; the game never sees the friends list, composes no text, and
 * holds no credential (the prompt-only constitution of the 2026-09 friends
 * design). Message shape, following the app's `yumina:*` convention but with
 * the strict validation of bridge-parent.ts — same-origin AND same-window,
 * because this frame is first-party content, not the opaque-origin sandbox:
 *
 *   { type: "yumina:social:invite",      joinUrl: "/pvz/?join=AB12" }
 *   { type: "yumina:social:room-closed", joinUrl: "/pvz/?join=AB12" }
 *
 * room-closed revokes every pending invite pointing at that room, so a friend
 * never accepts into "room not found".
 */
export function GameFrame({
  src,
  title,
  worldId,
}: {
  src: string;
  title: string;
  worldId?: string;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const multiplayerEnabled = useFeature("multiplayer");
  const [invitePrompt, setInvitePrompt] = useState<{ joinUrl: string } | null>(null);
  // "Invited" states live per ROOM: a new room (new joinUrl) starts fresh.
  const [invited, setInvited] = useState<{ joinUrl: string; ids: Set<string> }>({
    joinUrl: "",
    ids: new Set(),
  });

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
      const data = event.data as { type?: unknown; joinUrl?: unknown } | null;
      if (!data || typeof data.joinUrl !== "string") return;
      if (!data.joinUrl.startsWith("/") || data.joinUrl.startsWith("//")) return;
      if (data.type === "yumina:social:invite") {
        const joinUrl = data.joinUrl;
        setInvitePrompt({ joinUrl });
        setInvited((prev) => (prev.joinUrl === joinUrl ? prev : { joinUrl, ids: new Set() }));
      } else if (data.type === "yumina:social:room-closed") {
        void fetch("/api/friend-invites/revoke", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ joinUrl: data.joinUrl }),
        }).catch(() => {});
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <>
      <iframe
        ref={iframeRef}
        src={src}
        title={title}
        className="h-full w-full min-h-0 flex-1 border-0"
        allow="fullscreen; clipboard-write; autoplay"
      />
      {multiplayerEnabled && (
      <FriendPicker
        isOpen={invitePrompt !== null}
        onClose={() => setInvitePrompt(null)}
        mode="invite"
        joinUrl={invitePrompt?.joinUrl}
        worldId={worldId}
        invitedIds={invited.ids}
        onInvited={(friendId) =>
          setInvited((prev) => ({ joinUrl: prev.joinUrl, ids: new Set(prev.ids).add(friendId) }))
        }
      />
      )}
    </>
  );
}
