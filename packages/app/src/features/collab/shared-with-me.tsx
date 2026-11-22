import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRouter } from "@tanstack/react-router";
import { Loader2, Users } from "lucide-react";
import { feedback } from "@/lib/feedback";
import { resolveImageUrl } from "@/lib/asset-url";
import type { WorldItem } from "@/stores/worlds";
import { LibraryGameCard } from "@/features/library/library-game-card";
import type { SharedWorld } from "./collab-api";
import { answerCollabInvite, useCollabInvites, type PendingInvite } from "./collab-invites";
import { openSharedCard } from "./open-shared-card";

/** Keep the invitations and shared cards fresh while My projects is open:
 *  on arrival, on coming back to the tab, and on any live notification
 *  (an invite, a removal) — they can be answered or changed elsewhere. */
function useLiveCollabInvites() {
  useEffect(() => { void useCollabInvites.getState().refresh(); }, []);
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") void useCollabInvites.getState().refresh(); };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
}

/**
 * At the top of My projects: invitations to work on someone else's card,
 * waiting for an answer. Renders nothing when there are none.
 */
export function CollabInviteList() {
  const { t } = useTranslation("editor");
  useLiveCollabInvites();
  const invites = useCollabInvites((s) => s.invites);
  const [busy, setBusy] = useState<string | null>(null);

  const answer = async (invite: PendingInvite, accept: boolean) => {
    if (busy) return;
    setBusy(invite.worldId);
    try {
      await answerCollabInvite(invite.worldId, accept);
    } catch {
      feedback.error(t("collab.inviteGone", "This invitation is no longer open"));
      void useCollabInvites.getState().refresh();
    } finally {
      setBusy(null);
    }
  };

  if (!invites?.length) return null;
  const roleLabel = (role: string) => role === "editor" ? t("collab.role.editor", "Can edit") : t("collab.role.viewer", "Can view");

  return (
    <div className="space-y-2 px-2" data-collab-invites>
      {invites.map((invite) => (
        <div key={invite.worldId} className="flex items-center gap-3 rounded-xl border border-sky-400/30 bg-sky-400/5 px-3 py-2">
          {invite.thumbnailUrl
            ? <img src={resolveImageUrl(invite.thumbnailUrl) ?? undefined} alt="" className="h-10 w-10 shrink-0 rounded-md object-cover" />
            : <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted"><Users className="h-4 w-4 text-muted-foreground/60" /></div>}
          <div className="min-w-0 flex-1 text-sm">
            {t("collab.inviteLine", { name: invite.fromName, world: invite.worldName, role: roleLabel(invite.role), defaultValue: "{{name}} invited you to {{world}} ({{role}})" })}
          </div>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void answer(invite, true)}
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground disabled:opacity-60"
          >
            {busy === invite.worldId && <Loader2 className="h-3 w-3 animate-spin" />}
            {t("collab.accept", "Accept")}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void answer(invite, false)}
            className="shrink-0 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground disabled:opacity-60"
          >
            {t("collab.decline", "Decline")}
          </button>
        </div>
      ))}
    </div>
  );
}

/** A shared card in the shape the library's cards take. */
function sharedAsItem(world: SharedWorld): WorldItem {
  return {
    id: world.id,
    creatorId: world.creatorId,
    name: world.name,
    description: world.description,
    thumbnailUrl: world.thumbnailUrl,
    isPublished: world.status === "published",
    status: world.status,
    isNsfw: null,
    allowEdit: null,
    downloadCount: 0,
    tags: null,
    announcement: null,
    totalTokens: null,
    approxTime: null,
    galleryImages: null,
    sourceWorldId: null,
    sourceWorldTakenDown: null,
    moderationNote: null,
    moderationAction: null,
    creatorName: world.creatorName,
    createdAt: world.updatedAt,
    updatedAt: world.updatedAt,
  };
}

/**
 * In My projects, under the creator's own cards: the cards other people
 * shared with them, as the same cards as their own. Matches the search box by
 * name. Renders nothing for the (many) people nobody shared a card with.
 */
export function SharedWithMe({ searchQuery = "" }: { searchQuery?: string }) {
  const { t } = useTranslation("editor");
  const router = useRouter();
  useLiveCollabInvites();
  const shared = useCollabInvites((s) => s.shared);

  const query = searchQuery.trim().toLowerCase();
  const shown = (shared ?? []).filter((w) => !query || w.name.toLowerCase().includes(query));
  if (shown.length === 0) return null;
  const roleLabel = (role: string) => role === "editor" ? t("collab.role.editor", "Can edit") : t("collab.role.viewer", "Can view");
  const open = (worldId: string) => void openSharedCard(router, worldId);

  return (
    <div>
      <h3 className="text-sm font-bold text-sky-400 mb-4 uppercase tracking-wider flex items-center gap-2">
        <Users size={14} />
        {t("collab.sharedWithMe", "Shared with me")}{" "}
        <span className="text-muted-foreground font-normal">({shown.length})</span>
      </h3>
      <div className="library-card-grid">
        {shown.map((world) => (
          <div key={world.id} className="flex flex-col">
            <LibraryGameCard item={sharedAsItem(world)} onClick={() => open(world.id)} onEdit={() => open(world.id)} />
            <p className="mt-0.5 truncate text-[10px] text-muted-foreground/70">
              {t("collab.sharedBy", { name: world.creatorName, role: roleLabel(world.role), defaultValue: "{{name}} · {{role}}" })}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
